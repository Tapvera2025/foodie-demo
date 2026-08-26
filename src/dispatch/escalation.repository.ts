/**
 * The escalation ladder, running.
 *
 * `escalation.ts` decides what each rung means; this executes it against the
 * database. PRD §11.4, ESC-01..04.
 *
 * WHY THIS IS THE MOST IMPORTANT WORKER IN THE SYSTEM
 *
 * The product removed the vendor's "accept" click. That was defensible only
 * because something watches for the case it used to cover: the tablet is
 * asleep, the printer is out of paper, the court wi-fi dropped — and a customer
 * has paid for food nobody is cooking. Without this sweeper, `DISPATCHED` is a
 * claim the platform makes and never checks.
 *
 * Every rung tolerates arriving late, because by the time a delayed sweep runs
 * the order has usually been acknowledged already. The status check is first
 * and unconditional.
 */

import type { Kysely } from 'kysely';

import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { transitionOrder } from '../ordering/transition.js';
import { decideLadderStep, type LadderConfig } from './escalation.js';
import type { DispatchRepository } from './dispatch.repository.js';

export interface SweepResult {
  readonly examined: number;
  readonly cancelled: number;
  readonly escalated: number;
  readonly vendorsBlocked: number;
  /**
   * Stalls released from a block that nothing left could lift.
   *
   * The counterpart to `vendorsBlocked`. Over a healthy day these two should
   * roughly balance; a run of releases with no matching blocks means orders are
   * leaving DISPATCHED by a route that never acknowledged them, which is worth
   * looking into rather than being quietly repaired for ever.
   */
  readonly blocksReleased: number;
  readonly dispatchFailed: number;
  /**
   * Orders that crossed a rung on THIS sweep and owe somebody a phone call.
   *
   * Returned rather than sent from here because `dispatch` may not import
   * `notify` — and should not. The worker composes the two, the same way it
   * composes dispatch with notification and order state with refunds. What the
   * ladder knows is that a stall has stopped answering; who gets woken up about
   * it is not the ladder's business.
   */
  readonly alertedOrderIds: readonly string[];
  readonly failedOrderIds: readonly string[];
}

export class EscalationRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly dispatch: DispatchRepository,
    private readonly ladder: LadderConfig,
  ) {}

  /**
   * One pass over everything that is due.
   *
   * `SKIP LOCKED` again: two replicas sweeping at once must divide the work
   * rather than queue behind each other. An escalation that waits on a lock is
   * an escalation that fires late, and the whole point of the 15-second rung is
   * that it is 15 seconds.
   */
  async sweep(now = new Date(), limit = 100): Promise<SweepResult> {
    const due = await this.db
      .selectFrom('escalation_state')
      .innerJoin('order', 'order.id', 'escalation_state.order_id')
      .select([
        'escalation_state.order_id as orderId',
        'escalation_state.step as step',
        'order.status as status',
        'order.vendor_id as vendorId',
        'order.public_order_number as orderNumber',
        'order.dispatched_at as dispatchedAt',
      ])
      .where('escalation_state.cancelled_at', 'is', null)
      .where('escalation_state.next_run_at', '<=', now)
      .orderBy('escalation_state.next_run_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    const result = {
      examined: due.length,
      cancelled: 0,
      escalated: 0,
      vendorsBlocked: 0,
      /** Stalls whose block had nothing left to lift it. See `releaseStaleBlocks`. */
      blocksReleased: 0,
      dispatchFailed: 0,
      alertedOrderIds: [] as string[],
      failedOrderIds: [] as string[],
    };

    /**
     * Runs FIRST, and unconditionally — not inside the loop below.
     *
     * The loop only visits escalation rows that are due and uncancelled. A
     * stall stuck behind a block whose order has already gone has no such row
     * by definition, so anything nested in that loop could never reach it. This
     * is the whole reason the bug existed: every code path that could have
     * unblocked required the thing that was missing.
     */
    result.blocksReleased = await this.releaseStaleBlocks();

    for (const row of due) {
      // A dispatched order with no dispatched_at is a contradiction we cannot
      // schedule from. Cancel the ladder and say so, rather than guessing a
      // timestamp and firing rungs at the wrong moments.
      if (row.dispatchedAt === null) {
        await this.cancel(row.orderId);
        log().error(
          { event: 'escalation_missing_dispatch_time', orderId: row.orderId },
          'escalation cancelled: order has no dispatched_at',
        );
        result.cancelled++;
        continue;
      }

      const decision = decideLadderStep({
        orderStatus: row.status,
        step: row.step + 1,
        dispatchedAt: row.dispatchedAt,
        now,
        config: this.ladder,
      });

      if (decision.kind === 'CANCEL') {
        await this.cancel(row.orderId);
        if (decision.unblockVendor) await this.unblockVendor(row.vendorId);
        result.cancelled++;
        continue;
      }

      const { rung, nextRunAt } = decision;

      switch (rung.action) {
        case 'RETRY_DISPATCH':
        case 'RETRY_DISPATCH_AND_ALARM':
          // A second ticket for the same order would be a real hazard, so this
          // goes through the same dispatch path with its own attempt number
          // rather than writing a status directly.
          await this.dispatch.dispatch(row.orderId, `escalation:${row.orderId}:${rung.step}`);
          break;

        case 'BLOCK_VENDOR_AND_ALERT_MANAGER':
          // The stall stops receiving NEW orders until it acknowledges the one
          // it is sitting on. Not a punishment — a stall that cannot see its
          // queue should not be given more of it.
          await this.blockVendor(row.vendorId);
          // Only a FIRST alert is reported. The column is already idempotent
          // and so is the notification dedupe, but reporting a repeat would
          // make the worker's log say a page was sent every tick.
          if (await this.markManagerAlerted(row.orderId)) {
            result.alertedOrderIds.push(row.orderId);
          }
          result.vendorsBlocked++;
          log().error(
            {
              event: 'vendor_dispatch_blocked',
              vendorId: row.vendorId,
              orderId: row.orderId,
              orderNumber: row.orderNumber,
            },
            'stall has not acknowledged in 90s; blocked from new orders and manager alerted',
          );
          break;

        case 'FAIL_DISPATCH_AND_OFFER_CANCEL':
          await this.db.transaction().execute(async (trx) => {
            await transitionOrder(trx, {
              orderId: row.orderId,
              to: 'DISPATCH_FAILED',
              actorType: 'SYSTEM',
              correlationId: `escalation:${row.orderId}:${rung.step}`,
            });
            await trx
              .updateTable('escalation_state')
              .set({ customer_offered_cancel_at: now, step: rung.step })
              .where('order_id', '=', row.orderId)
              .execute();
          });
          result.dispatchFailed++;
          result.failedOrderIds.push(row.orderId);
          log().error(
            { event: 'dispatch_failed', orderId: row.orderId, orderNumber: row.orderNumber },
            'no acknowledgement in 180s; customer offered a one-tap full refund',
          );
          break;
      }

      await this.db
        .updateTable('escalation_state')
        .set({ step: rung.step, next_run_at: nextRunAt })
        .where('order_id', '=', row.orderId)
        .execute();

      result.escalated++;
    }

    return result;
  }

  /**
   * Called when a kitchen acknowledges. Stops the ladder immediately rather
   * than waiting for the next sweep to notice.
   *
   * Both paths exist on purpose: this one is fast, and the sweep's own status
   * check is the one that still works if this call is never made.
   */
  async cancelForAcknowledgement(orderId: string, vendorId: string): Promise<void> {
    await this.cancel(orderId);
    await this.unblockVendor(vendorId);
  }

  private async cancel(orderId: string): Promise<void> {
    await this.db
      .updateTable('escalation_state')
      .set({ cancelled_at: new Date(), next_run_at: null })
      .where('order_id', '=', orderId)
      .where('cancelled_at', 'is', null)
      .execute();
  }

  private async blockVendor(vendorId: string): Promise<void> {
    await this.db
      .updateTable('vendor')
      .set({ dispatch_blocked_at: new Date() })
      .where('id', '=', vendorId)
      .where('dispatch_blocked_at', 'is', null)
      .execute();
  }

  /**
   * Release blocks that nothing can ever lift.
   *
   * ==========================================================================
   * THE BUG THIS FIXES: A STALL BLOCKED FOR EVER, WITH NO WAY BACK
   * ==========================================================================
   *
   * `unblockVendor` computes the right condition — "is anything still waiting
   * on this stall" — and it had exactly ONE trigger: a cook acknowledging an
   * order. That is fine for the path everyone pictures, and wrong for every
   * other way an order can leave DISPATCHED:
   *
   *   rejected by the kitchen · cancelled · payment expired · refunded ·
   *   or wiped by `npm run reset:orders` in development
   *
   * In all of those, nothing calls `unblockVendor` and `dispatch_blocked_at`
   * stays set. The consequences compound quietly:
   *
   *   · the stall disappears from the customer app — `closedReason` becomes
   *     'unavailable' and there is no explanation a customer can act on
   *   · the kitchen board says "New orders paused. Accept it to start
   *     receiving new orders" ALONGSIDE "All caught up, nothing waiting" —
   *     it is telling a cook to accept an order that does not exist
   *   · the Settings tab says the block is "set by the escalation ladder, not
   *     by the kitchen. Not clearable here", which is true and leaves the only
   *     remedy as an UPDATE typed into psql
   *
   * A stall silently earning nothing, told to perform an impossible action.
   *
   * So the check runs on a schedule instead of only on one event. Same
   * condition, evaluated by the sweep that already runs every tick — which
   * means the block heals itself within a second and a half whatever route the
   * order took out.
   *
   * WHY THIS IS A SWEEP AND NOT A FIX AT EACH EXIT POINT
   *
   * Because there are five exits today and the sixth will be added by somebody
   * who has never read this file. A rule enforced at every call site is a rule
   * that lasts until the next call site. This one is stated once and is true
   * regardless of how the order left.
   */
  private async releaseStaleBlocks(): Promise<number> {
    const stuck = await this.db
      .selectFrom('vendor')
      .select('id')
      .where('dispatch_blocked_at', 'is not', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('escalation_state as es')
              .innerJoin('order as o', 'o.id', 'es.order_id')
              .select('es.order_id')
              .whereRef('o.vendor_id', '=', 'vendor.id')
              .where('o.status', '=', 'DISPATCHED')
              .where('es.cancelled_at', 'is', null)
              .where('es.step', '>=', 3),
          ),
        ),
      )
      .execute();

    if (stuck.length === 0) return 0;

    await this.db
      .updateTable('vendor')
      .set({ dispatch_blocked_at: null })
      .where(
        'id',
        'in',
        stuck.map((v) => v.id),
      )
      .execute();

    // WARN, not info. A stall came back from being invisible to customers, and
    // if this fires repeatedly for the same stall it means something is
    // blocking it that this sweep is then undoing — which would be worth
    // knowing before it turns into a stall flickering in and out of the app.
    log().warn(
      { event: 'dispatch_block_released', vendorIds: stuck.map((v) => v.id), count: stuck.length },
      'a stall was blocked with nothing left to acknowledge — the block has been lifted',
    );

    return stuck.length;
  }

  /**
   * Unblock only when nothing else is still waiting on this stall.
   *
   * A stall can be sitting on three unacknowledged orders. Acknowledging one of
   * them should not reopen the tap while two are still unseen — that is how a
   * failing stall gets fed a steady drip of orders it will also miss.
   */
  private async unblockVendor(vendorId: string): Promise<void> {
    const stillWaiting = await this.db
      .selectFrom('escalation_state')
      .innerJoin('order', 'order.id', 'escalation_state.order_id')
      .select('escalation_state.order_id')
      .where('order.vendor_id', '=', vendorId)
      .where('order.status', '=', 'DISPATCHED')
      .where('escalation_state.cancelled_at', 'is', null)
      .where('escalation_state.step', '>=', 3)
      .executeTakeFirst();

    if (stillWaiting) return;

    await this.db
      .updateTable('vendor')
      .set({ dispatch_blocked_at: null })
      .where('id', '=', vendorId)
      .execute();
  }

  /** True when this call is the one that set it. */
  private async markManagerAlerted(orderId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('escalation_state')
      .set({ manager_alerted_at: new Date() })
      .where('order_id', '=', orderId)
      .where('manager_alerted_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }
}
