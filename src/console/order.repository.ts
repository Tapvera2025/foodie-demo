/**
 * Live orders across a court, and the one intervention the platform can make.
 *
 * ============================================================================
 * WHAT THIS SCREEN IS FOR
 * ============================================================================
 *
 * Every order in this system is money the platform is already holding on
 * somebody else's behalf. When one stops moving, three parties are stuck at
 * once: a customer waiting for food they paid for, a stall that may not know
 * the order exists, and a platform holding cash it can neither settle nor
 * return. Nothing in the product surfaced that — the customer saw a spinner,
 * the kitchen saw nothing, and the console showed stall configuration.
 *
 * The four failure modes below are not hypothetical. Every one of them happened
 * during development, and each took a database query to diagnose because there
 * was no screen that would say it.
 *
 * ============================================================================
 * THE DIAGNOSIS IS COMPUTED HERE, NOT IN THE BROWSER
 * ============================================================================
 *
 * "Stuck" is a claim about money and time, and it has to mean exactly one thing
 * across the worker, this screen and anybody reading the audit log later. A
 * client that decided for itself would drift the first time somebody changed a
 * threshold in one place — and the drift would be silent, because both versions
 * would look plausible.
 */

import type { Kysely } from 'kysely';

import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { transitionOrder } from '../ordering/transition.js';

/**
 * Money taken, food not collected.
 *
 * Deliberately the same list `court.repository.ts` uses for `liveOrderCount`,
 * plus the two pre-confirmation states — because an order sitting in
 * PAYMENT_PENDING with an authorised payment is the single worst state in the
 * system and excluding it would hide the failure this screen exists to catch.
 */
const WATCHED: readonly string[] = [
  'CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'DISPATCHED',
  'ACKNOWLEDGED',
  'PREPARING',
  'READY',
  'DISPATCH_FAILED',
  'RECONCILIATION_REQUIRED',
];

/**
 * Why an order needs a human, in the order a human should deal with them.
 *
 * The ranking is by WHOSE PROBLEM IT IS and how much it costs to leave:
 *
 *   PAYMENT_ORPHANED   we hold their money and nothing is cooking. Worst.
 *   RECONCILIATION     the payment engine gave up and flagged it.
 *   DISPATCH_FAILED    the stall never got it and retries are exhausted.
 *   STALL_SILENT       dispatched, unacknowledged past the ladder's last rung.
 *   UNCOLLECTED        cooked, going cold on a counter.
 *   SLOW               past the stall's own estimate. Often fine.
 *   OK                 moving normally.
 */
export type Attention =
  | 'PAYMENT_ORPHANED'
  | 'RECONCILIATION'
  | 'DISPATCH_FAILED'
  | 'STALL_SILENT'
  | 'UNCOLLECTED'
  | 'SLOW'
  | 'OK';

const SEVERITY: Record<Attention, number> = {
  PAYMENT_ORPHANED: 0,
  RECONCILIATION: 1,
  DISPATCH_FAILED: 2,
  STALL_SILENT: 3,
  UNCOLLECTED: 4,
  SLOW: 5,
  OK: 6,
};

export interface LiveOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly customerName: string | null;
  readonly totalPayablePaise: number;
  readonly placedAt: string;
  readonly ageSeconds: number;
  readonly paymentStatus: string | null;
  /** True when money is genuinely held — AUTHORIZED or CAPTURED. */
  readonly moneyHeld: boolean;
  readonly attention: Attention;
  /** One sentence naming the situation, for somebody who did not build this. */
  readonly diagnosis: string;
  /** Whether force-cancelling would return money as well as stop the order. */
  readonly cancelRefunds: boolean;
}

/** Past the escalation ladder's last rung (180s) — the stall is not answering. */
const STALL_SILENT_SECONDS = 180;
/** Cooked and still on the counter. Long enough that the customer has left. */
const UNCOLLECTED_SECONDS = 600;
/** Multiple of the stall's own estimate before "slow" is worth saying. */
const SLOW_FACTOR = 2;

export class ConsoleOrderRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  async liveOrders(foodCourtId: string): Promise<LiveOrder[]> {
    const rows = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      .leftJoin('customer', 'customer.id', 'order.customer_id')
      /**
       * The payment is a LEFT join and the newest one wins.
       *
       * `payment_order_uq` makes it one row per order today, so this could be a
       * plain join — but an order with no payment row at all is exactly the
       * state a checkout that died mid-flight leaves behind, and an inner join
       * would drop it from the one screen meant to find it.
       */
      .leftJoin('payment', 'payment.order_id', 'order.id')
      .select([
        'order.id as orderId',
        'order.public_order_number as orderNumber',
        'order.status as status',
        'order.vendor_id as vendorId',
        'order.total_payable_paise as totalPayablePaise',
        'order.created_at as placedAt',
        'order.dispatched_at as dispatchedAt',
        'vendor.name as vendorName',
        'vendor.estimated_prep_minutes as prepMinutes',
        'customer.display_name as customerName',
        'payment.status as paymentStatus',
      ])
      .where('vendor.food_court_id', '=', foodCourtId)
      .where('order.status', 'in', WATCHED as never)
      .orderBy('order.created_at', 'desc')
      .limit(300)
      .execute();

    const now = Date.now();

    const out = rows.map((r): LiveOrder => {
      const ageSeconds = Math.round((now - r.placedAt.getTime()) / 1000);
      const moneyHeld = r.paymentStatus === 'AUTHORIZED' || r.paymentStatus === 'CAPTURED';
      const sinceDispatch = r.dispatchedAt
        ? Math.round((now - r.dispatchedAt.getTime()) / 1000)
        : null;

      let attention: Attention = 'OK';
      let diagnosis = 'Moving normally.';

      if (r.status === 'RECONCILIATION_REQUIRED') {
        attention = 'RECONCILIATION';
        diagnosis = 'The payment engine could not decide what happened. A person owns this.';
      } else if (r.status === 'DISPATCH_FAILED') {
        attention = 'DISPATCH_FAILED';
        diagnosis = 'The stall never received this and the retries are exhausted.';
      } else if (moneyHeld && (r.status === 'CREATED' || r.status === 'PAYMENT_PENDING')) {
        /**
         * THE WORST STATE IN THE SYSTEM, AND THE REASON THIS SCREEN EXISTS.
         *
         * The payment is authorised and the order never moved. Those two are
         * written in one transaction by the webhook path, so this pair can only
         * mean that transaction rolled back — and the status poll then wrote
         * the payment row on its own, which it does by design.
         *
         * The customer has been charged and told nothing is happening. The
         * stall has no idea. Left alone, the payment expires and the money goes
         * back eventually, which is the right outcome reached the slowest
         * possible way.
         */
        attention = 'PAYMENT_ORPHANED';
        diagnosis =
          'Payment went through and the order never reached the stall. The customer has been charged and nothing is cooking.';
      } else if (
        r.status === 'DISPATCHED' &&
        sinceDispatch !== null &&
        sinceDispatch > STALL_SILENT_SECONDS
      ) {
        attention = 'STALL_SILENT';
        diagnosis = `Sent to the stall ${Math.round(sinceDispatch / 60)} minutes ago and still not accepted.`;
      } else if (r.status === 'READY' && ageSeconds > UNCOLLECTED_SECONDS) {
        attention = 'UNCOLLECTED';
        diagnosis = 'Cooked and waiting on the counter. The customer may have left.';
      } else if (
        (r.status === 'ACKNOWLEDGED' || r.status === 'PREPARING') &&
        ageSeconds > r.prepMinutes * 60 * SLOW_FACTOR
      ) {
        attention = 'SLOW';
        diagnosis = `Past twice the stall's own ${r.prepMinutes}-minute estimate.`;
      }

      return {
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        status: r.status,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        customerName: r.customerName,
        totalPayablePaise: r.totalPayablePaise,
        placedAt: r.placedAt.toISOString(),
        ageSeconds,
        paymentStatus: r.paymentStatus,
        moneyHeld,
        attention,
        diagnosis,
        /**
         * Cancelling refunds only when money is actually held.
         *
         * `claimRefundable` picks up CANCELLED orders whose payment is
         * AUTHORIZED or CAPTURED and the worker opens the refund — so the
         * cancel IS the refund and no separate action is needed. But an order
         * with no payment has nothing to return, and a console that promised a
         * refund there would be lying in the one place it must not.
         */
        cancelRefunds: moneyHeld,
      };
    });

    // Worst first, then oldest. A screen sorted only by time buries the
    // orphaned payment from an hour ago under nine healthy orders from now.
    out.sort((a, b) =>
      SEVERITY[a.attention] !== SEVERITY[b.attention]
        ? SEVERITY[a.attention] - SEVERITY[b.attention]
        : b.ageSeconds - a.ageSeconds,
    );

    return out;
  }

  /**
   * Stop an order and, where money is held, start its refund.
   *
   * `COMMAND_SPECS.forceCancel` has existed since the state machine was written
   * — target state, permission, mandatory reason — with no repository method
   * and no route. Specified and unreachable, which is the same shape
   * `assessVendorReadiness` was in before the console gave it a screen.
   *
   * THE REFUND IS NOT TRIGGERED HERE, DELIBERATELY.
   *
   * `REFUNDABLE_FROM` already contains CANCELLED, so the worker's
   * `claimRefundable` finds this order on its next tick and opens the refund in
   * one transaction with its compensating ledger entries. Calling the refund
   * from here as well would create the second path to a refund, and two paths
   * to moving money is how an order gets refunded twice.
   *
   * SCOPED TO THE COURT, not just to the order id. A `PLATFORM_OPS` assignment
   * can be court-scoped, and an operator for one venue must not be able to
   * cancel an order in another by pasting its id.
   */
  async forceCancel(input: {
    foodCourtId: string;
    orderId: string;
    reason: string;
    actorId: string;
  }): Promise<{ orderNumber: string; status: string; refundStarted: boolean }> {
    const order = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      .leftJoin('payment', 'payment.order_id', 'order.id')
      .select([
        'order.id as id',
        'order.status as status',
        'order.public_order_number as orderNumber',
        'order.vendor_id as vendorId',
        'payment.status as paymentStatus',
      ])
      .where('order.id', '=', input.orderId)
      .where('vendor.food_court_id', '=', input.foodCourtId)
      .executeTakeFirst();

    // 404, never 403 — a different code would confirm the order exists in
    // somebody else's court. PRD TENANT-01.
    if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');

    const moneyHeld = order.paymentStatus === 'AUTHORIZED' || order.paymentStatus === 'CAPTURED';

    const result = await this.db.transaction().execute(async (trx) => {
      const t = await transitionOrder(trx, {
        orderId: input.orderId,
        to: 'CANCELLED',
        correlationId: `console:force-cancel:${input.actorId}`,
        // Not SYSTEM. A person decided this, and six months from now "who
        // cancelled this order" must answer with a name rather than with the
        // software. `PLATFORM_OPS` is the actor type that holds
        // `order.force_cancel` alongside MANAGER, and the console is the
        // platform's surface.
        actorType: 'PLATFORM_OPS',
        actorId: input.actorId,
      });

      await this.audit.write(
        buildAuditEntry({
          action: 'order.force_cancelled',
          entity: 'order',
          entityId: input.orderId,
          foodCourtId: input.foodCourtId,
          vendorId: order.vendorId,
          beforeValue: { status: order.status },
          afterValue: { status: 'CANCELLED', reason: input.reason, refundExpected: moneyHeld },
        }),
        trx,
      );

      return t;
    });

    return {
      orderNumber: result.orderNumber,
      status: result.status,
      refundStarted: moneyHeld,
    };
  }
}
