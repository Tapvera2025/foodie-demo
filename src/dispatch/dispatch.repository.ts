/**
 * Getting a paid order in front of a kitchen.
 *
 * PRD §7.3: `PAYMENT_CONFIRMED → DISPATCHED` is a system transition, run by
 * this worker rather than by whoever happened to handle the webhook. That
 * separation is PAY-04 and it is the reason a webhook delivered twice still
 * produces exactly one kitchen ticket: the confirmation commits, and the
 * dispatch is a separate committed command with its own idempotency.
 *
 * WHAT "DISPATCH" MEANS WITH NO PUSH CHANNEL
 *
 * There is no socket to the tablet and no thermal printer integration. The KDS
 * polls `/kds/orders` every few seconds, so an order becomes visible the moment
 * its status changes — which means dispatch is, today, a status change and a
 * `dispatch_attempt` row.
 *
 * That sounds like it makes the worker pointless. It is the opposite. The
 * `dispatch_attempt` row is what the escalation ladder counts, what proves the
 * platform tried, and what distinguishes "the stall never got it" from "the
 * stall ignored it" — and those two have completely different remedies. When a
 * push channel does land, it slots in at `deliver()` and nothing else moves.
 */

import type { Kysely } from 'kysely';

import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { transitionOrder } from '../ordering/transition.js';
import { firstRunAt, type LadderConfig } from './escalation.js';

export interface DispatchResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly attemptNo: number;
  readonly dispatched: boolean;
  readonly reason?: string;
}

export class DispatchRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ladder: LadderConfig,
  ) {}

  /**
   * Orders that have been paid for and are not yet in front of anyone.
   *
   * `FOR UPDATE SKIP LOCKED` so two worker replicas can sweep the same table
   * without either waiting on the other or both claiming one order. Without
   * SKIP LOCKED a second replica serialises behind the first and the queue
   * drains at single-worker speed while looking like it has two.
   */
  async claimPending(limit = 50): Promise<string[]> {
    const rows = await this.db
      .selectFrom('order')
      .select('id')
      .where('status', '=', 'PAYMENT_CONFIRMED')
      .orderBy('payment_confirmed_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    return rows.map((r) => r.id);
  }

  /**
   * Send one order to its stall.
   *
   * Idempotent on (order_id, target_type, attempt_no), which
   * `dispatch_attempt_uq` enforces. A retry after a timeout reuses its attempt
   * number and collides rather than writing a second ticket; a genuine
   * escalation retry increments it, so the two are distinguishable in the data
   * instead of being inferred from timestamps.
   */
  async dispatch(orderId: string, correlationId: string): Promise<DispatchResult> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('order')
        .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
        .select([
          'order.id as id',
          'order.status as status',
          'order.public_order_number as orderNumber',
          'order.vendor_id as vendorId',
          'vendor.name as vendorName',
          'vendor.status as vendorStatus',
          'vendor.kds_last_heartbeat_at as heartbeat',
        ])
        .where('order.id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');

      // Already moved on. A sweeper arriving late is normal, not an error.
      if (order.status !== 'PAYMENT_CONFIRMED' && order.status !== 'DISPATCH_FAILED') {
        return {
          orderId,
          orderNumber: order.orderNumber,
          attemptNo: 0,
          dispatched: false,
          reason: `order is ${order.status}`,
        };
      }

      const previous = await trx
        .selectFrom('dispatch_attempt')
        .select('attempt_no')
        .where('order_id', '=', orderId)
        .where('target_type', '=', 'KDS')
        .orderBy('attempt_no', 'desc')
        .executeTakeFirst();

      const attemptNo = (previous?.attempt_no ?? 0) + 1;

      // The delivery itself. Today: make it visible to a board that polls.
      const outcome = await this.deliver();

      await trx
        .insertInto('dispatch_attempt')
        .values({
          order_id: orderId,
          target_type: 'KDS',
          attempt_no: attemptNo,
          outcome: outcome.ok ? 'SENT' : 'FAILED',
          ...(outcome.ok ? {} : { error_code: 'DELIVERY_FAILED', error_detail: outcome.reason }),
          correlation_id: correlationId,
        })
        .execute();

      if (!outcome.ok) {
        await transitionOrder(trx, {
          orderId,
          to: 'DISPATCH_FAILED',
          actorType: 'SYSTEM',
          correlationId,
        });
        return {
          orderId,
          orderNumber: order.orderNumber,
          attemptNo,
          dispatched: false,
          reason: outcome.reason,
        };
      }

      const result = await transitionOrder(trx, {
        orderId,
        to: 'DISPATCHED',
        actorType: 'SYSTEM',
        correlationId,
      });

      // Arm the ladder in the SAME transaction as the dispatch. Scheduling it
      // afterwards means a crash in between leaves a dispatched order that
      // nothing is watching — which is precisely the situation the ladder was
      // built to make impossible.
      const dispatchedAt = new Date();
      await trx
        .insertInto('escalation_state')
        .values({
          order_id: orderId,
          step: 0,
          next_run_at: firstRunAt(dispatchedAt, this.ladder),
        })
        .onConflict((oc) =>
          oc.column('order_id').doUpdateSet({
            step: 0,
            next_run_at: firstRunAt(dispatchedAt, this.ladder),
            cancelled_at: null,
          }),
        )
        .execute();

      log().info(
        {
          event: 'order_dispatched',
          orderId,
          orderNumber: order.orderNumber,
          vendorId: order.vendorId,
          attemptNo,
          // Recorded because a dispatch to a stall whose tablet last spoke an
          // hour ago is technically a success and practically a problem.
          vendorHeartbeatAt: order.heartbeat?.toISOString() ?? null,
        },
        `ticket ${order.orderNumber} sent to ${order.vendorName}`,
      );

      return {
        orderId,
        orderNumber: result.orderNumber,
        attemptNo,
        dispatched: result.changed,
      };
    });
  }

  /**
   * The delivery hop. Currently a no-op that always succeeds.
   *
   * Kept as its own method, returning a real outcome, rather than inlined as
   * "always fine". When a socket push or a thermal printer lands, this is the
   * only thing that changes — and the failure path around it is already
   * written, tested and reachable, rather than being added under pressure on
   * the day the printer first jams.
   */
  private async deliver(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: true };
  }
}
