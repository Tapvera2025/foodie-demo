/**
 * The refund engine, connected.
 *
 * WHY THIS FILE EXISTS
 *
 * `refund.ts` — the retry schedule, the customer copy keys, the decision
 * function — has been here with nineteen passing tests since week five, and was
 * imported by nothing except those tests. Same for `credit.ts`. The `refund`
 * and `platform_credit` tables were created and never written to by any code
 * path. §14.7 listed seven triggers for a refund and none of them had one.
 *
 * The sharpest version of the gap: the escalation ladder's fourth rung sets
 * `escalation_state.customer_offered_cancel_at`, the tracking screen offers the
 * customer a one-tap refund, and there was no endpoint behind it. A customer
 * paid, no stall accepted, the system told them they could have their money
 * back, and nothing could give it to them.
 *
 * WHAT DRIVES IT
 *
 * State, not events — the same shape as `notifyReady` and the capture sweep,
 * for the same reason. An order in REJECTED / CANCELLED / DISPATCH_FAILED with
 * a live payment and no refund row IS the query. That is self-healing across a
 * worker restart, and it means REF-01's "within 60 seconds, no manual step"
 * does not depend on an event bus nobody has built.
 *
 * MODE B DOES NOT REFUND
 *
 * §14.2 and §14.7: in VENDOR_DIRECT the platform never held the money and
 * cannot give it back. It records that one is owed, marks the ledger entries
 * ADVISORY, and leaves the refund REQUESTED for a human to chase. Calling a
 * provider we have no relationship with, on money we never touched, would
 * produce a confident failure and a customer told the wrong thing.
 */

import type { Kysely, Transaction } from 'kysely';

import { buildAuditEntry } from '../platform/audit.js';
import type { AuditWriter } from '../platform/audit.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { paise, type Paise } from '../platform/money.js';
import type { Database, OrderStatus } from '../platform/schema.js';
import { orderRefundEntries } from '../ledger/entries.js';
import { computeQuote } from '../pricing/quote.js';
import type { FeeRule, TaxModel } from '../pricing/fee-engine.js';
import { transitionOrder } from '../ordering/transition.js';
import type { PaymentProvider } from './provider.interface.js';
import { decideRefundNextAction, MAX_ATTEMPTS } from './refund.js';

/** Order states that owe the customer their money back. §14.7. */
const REFUNDABLE_FROM: readonly OrderStatus[] = ['REJECTED', 'CANCELLED', 'DISPATCH_FAILED'];

/** Payment states where money is actually held. Nothing else can be returned. */
const REFUNDABLE_PAYMENT: readonly ('AUTHORIZED' | 'CAPTURED')[] = ['AUTHORIZED', 'CAPTURED'];

export interface RefundInitiation {
  readonly refundId: string;
  readonly orderId: string;
  readonly amountPaise: Paise;
  readonly authority: 'AUTHORITATIVE' | 'ADVISORY';
}

export class RefundRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly provider: PaymentProvider,
    private readonly audit: AuditWriter,
  ) {}

  // =========================================================================
  // Initiation
  // =========================================================================

  /**
   * Orders that owe a refund and do not have one yet.
   *
   * The `NOT EXISTS` is the idempotency guarantee, and it is a query rather
   * than a flag on the order so that a second worker, a restart, or a replayed
   * tick cannot produce two refunds for one order.
   */
  async claimRefundable(limit = 50): Promise<string[]> {
    const rows = await this.db
      .selectFrom('order')
      .innerJoin('payment', 'payment.order_id', 'order.id')
      .select('order.id as orderId')
      .where('order.status', 'in', REFUNDABLE_FROM)
      .where('payment.status', 'in', REFUNDABLE_PAYMENT)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('refund')
              .select('refund.id')
              .whereRef('refund.order_id', '=', 'order.id'),
          ),
        ),
      )
      .orderBy('order.updated_at')
      .limit(limit)
      .execute();

    return [...new Set(rows.map((r) => r.orderId))];
  }

  /**
   * Open a refund: the row, the compensating ledger entries and the order
   * transition, in one transaction.
   *
   * Same rule as order placement (§14.6): a ledger that can lag the thing it
   * describes is one that is sometimes wrong, and the window is exactly when a
   * process dies mid-refund.
   */
  async initiate(orderId: string, correlationId: string): Promise<RefundInitiation | null> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('order')
        .select([
          'id',
          'status',
          'vendor_id',
          'food_court_id',
          'settlement_mode_snapshot',
          'total_payable_paise',
          'fee_rule_snapshot',
          'tax_model_snapshot',
        ])
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');
      if (!REFUNDABLE_FROM.includes(order.status)) return null;

      // Re-checked inside the lock. `claimRefundable` read outside it.
      const already = await trx
        .selectFrom('refund')
        .select('id')
        .where('order_id', '=', orderId)
        .executeTakeFirst();
      if (already) return null;

      const payment = await trx
        .selectFrom('payment')
        .select(['id', 'status', 'amount_paise'])
        .where('order_id', '=', orderId)
        .where('status', 'in', REFUNDABLE_PAYMENT)
        .executeTakeFirst();

      // Nothing was ever held. An unpaid order that was cancelled owes nobody
      // anything, and writing a zero refund would put a row in a queue a human
      // then has to close.
      if (!payment) return null;

      /**
       * The refund is priced from the order's SNAPSHOTTED terms, not today's.
       *
       * §15: "the order's snapshotted terms" are the authority on what an order
       * cost; current fee rules are irrelevant to a historical one. Re-running
       * the same pure function against the same snapshotted rules and the same
       * stored line totals reproduces the original quote exactly.
       */
      const items = await trx
        .selectFrom('order_item')
        .select(['line_total_paise', 'tax_rate_bps_snapshot'])
        .where('order_id', '=', order.id)
        .execute();

      const quote = computeQuote({
        lines: items.map((i) => ({
          lineTotalPaise: paise(i.line_total_paise),
          taxRateBps: i.tax_rate_bps_snapshot,
        })),
        feeRules: order.fee_rule_snapshot as unknown as FeeRule[],
        taxModel: order.tax_model_snapshot as unknown as TaxModel,
        settlementMode: order.settlement_mode_snapshot,
      });

      /**
       * If the snapshot no longer reproduces the order, refund nothing.
       *
       * This is the whole reason for re-deriving rather than trusting a stored
       * total: it is a second opinion. A mismatch means the snapshot and the
       * order disagree about what was charged, and the correct response to
       * undeterminable truth is a human, not a transfer (§7.2, §9 case G).
       */
      if (quote.grossPayablePaise !== order.total_payable_paise) {
        await trx
          .insertInto('reconciliation_item')
          .values({
            kind: 'AMOUNT_MISMATCH',
            order_id: order.id,
            state: 'OPEN',
            expected_paise: order.total_payable_paise,
            actual_paise: quote.grossPayablePaise,
            delta_paise: quote.grossPayablePaise - order.total_payable_paise,
          })
          .execute();

        throw new AppError(
          'RECONCILIATION_REQUIRED',
          `Order ${order.id} does not reprice to its own total; refund held for review`,
        );
      }

      const entries = orderRefundEntries(quote);

      /**
       * Mode B entries are ADVISORY: the platform's belief about money it never
       * touched. §14.2 — mixing them into one figure produces a number that is
       * partly measured and partly inferred, with nothing downstream able to
       * tell which.
       */
      const authority = order.settlement_mode_snapshot === 'PLATFORM_COLLECT' ? 'AUTHORITATIVE' : 'ADVISORY';

      const refund = await trx
        .insertInto('refund')
        .values({
          order_id: order.id,
          payment_id: payment.id,
          kind: 'FULL',
          amount_paise: payment.amount_paise,
          status: 'REQUESTED',
          reason: `order ${order.status.toLowerCase()}`,
          // Due immediately. Attempt 1 has a zero delay by design — REF-01's
          // sixty seconds must not depend on queue latency.
          next_retry_at: new Date(),
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('ledger_entry')
        .values(
          entries.map((e) => ({
            order_id: order.id,
            vendor_id: e.party === 'VENDOR' ? order.vendor_id : null,
            food_court_id: order.food_court_id,
            entry_type: e.entryType,
            party: e.party,
            direction: e.direction,
            amount_paise: e.amountPaise,
            authority,
            reference: `refund:${refund.id}`,
            correlation_id: correlationId,
          })),
        )
        .execute();

      await transitionOrder(trx, {
        orderId: order.id,
        to: 'REFUND_PENDING',
        actorType: 'SYSTEM',
        correlationId,
      });

      // In the transaction, on purpose. An audit row that survives a rolled
      // back refund describes money moving that did not move.
      await this.audit.write(
        buildAuditEntry({
          action: 'refund.initiated',
          entity: 'order',
          entityId: order.id,
          foodCourtId: order.food_court_id,
          vendorId: order.vendor_id,
          afterValue: {
            refundId: refund.id,
            amountPaise: payment.amount_paise,
            authority,
            fromStatus: order.status,
          },
        }),
        trx,
      );

      log().info(
        {
          event: 'refund_initiated',
          orderId: order.id,
          refundId: refund.id,
          amountPaise: payment.amount_paise,
          authority,
        },
        'a refund is owed and has been opened',
      );

      return {
        refundId: refund.id,
        orderId: order.id,
        amountPaise: paise(payment.amount_paise),
        authority,
      };
    });
  }

  // =========================================================================
  // Execution and retry
  // =========================================================================

  /** Refunds due for an attempt. */
  async claimDue(now = new Date(), limit = 25): Promise<string[]> {
    const rows = await this.db
      .selectFrom('refund')
      .select('id')
      .where('status', 'in', ['REQUESTED', 'PENDING', 'FAILED'])
      .where('next_retry_at', '<=', now)
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('next_retry_at')
      .limit(limit)
      .execute();

    return rows.map((r) => r.id);
  }

  /**
   * One attempt against the provider, and whatever the outcome implies.
   *
   * The provider call is deliberately OUTSIDE the transaction, for the same
   * reason as intent creation: holding a row lock across a third-party network
   * call is how a slow provider becomes a database incident. The cost is a
   * window where the provider has acted and we have not recorded it — which is
   * exactly what `refundId`, generated before the call, makes recoverable.
   */
  async attempt(refundId: string, now = new Date()): Promise<void> {
    const refund = await this.db
      .selectFrom('refund')
      .innerJoin('payment', 'payment.id', 'refund.payment_id')
      .innerJoin('order', 'order.id', 'refund.order_id')
      .select([
        'refund.id as id',
        'refund.order_id as orderId',
        'refund.amount_paise as amountPaise',
        'refund.attempts as attempts',
        'refund.reason as reason',
        'refund.status as status',
        'payment.provider_payment_ref as providerPaymentRef',
        'payment.provider_order_ref as providerOrderRef',
        'order.settlement_mode_snapshot as settlementMode',
        'order.food_court_id as foodCourtId',
        'order.vendor_id as vendorId',
      ])
      .where('refund.id', '=', refundId)
      .executeTakeFirst();

    if (!refund) return;

    /**
     * Mode B: record the obligation, do not attempt it.
     *
     * The refund stays REQUESTED with no retry scheduled — a human chases the
     * vendor. Scheduling retries against a provider that was never in the flow
     * would burn the attempt budget and end in RECONCILIATION_REQUIRED with a
     * reason that blames the wrong party.
     */
    if (refund.settlementMode !== 'PLATFORM_COLLECT') {
      await this.db
        .updateTable('refund')
        .set({
          next_retry_at: null,
          last_error: 'VENDOR_DIRECT: the platform never held these funds; the vendor must refund',
        })
        .where('id', '=', refund.id)
        .execute();

      log().warn(
        { event: 'refund_vendor_direct', orderId: refund.orderId, refundId: refund.id },
        'refund owed in VENDOR_DIRECT — the platform cannot initiate it',
      );
      return;
    }

    const ref = refund.providerPaymentRef ?? refund.providerOrderRef;
    if (!ref) {
      throw new AppError('RECONCILIATION_REQUIRED', 'Refund has no provider reference');
    }

    const attemptNo = refund.attempts + 1;
    let result;
    try {
      result = await this.provider.refund({
        // The platform's id, generated before the call, so a timeout is
        // retryable rather than ambiguous.
        refundId: refund.id,
        orderId: refund.orderId,
        providerPaymentRef: ref,
        amountPaise: paise(refund.amountPaise),
        reason: refund.reason ?? 'order refunded',
        // Mode A: the vendor's share was split to them and has to come back.
        reverseVendorTransfer: true,
      });
    } catch (e) {
      // A throw is UNKNOWN, never a decline — same rule as `getStatus`. Record
      // the attempt and let the schedule bring it back.
      result = { status: 'FAILED' as const, authority: 'AUTHORITATIVE' as const, reason: (e as Error).message };
    }

    const next = decideRefundNextAction(result.status, attemptNo, now);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('refund')
        .set({
          status:
            result.status === 'SUCCEEDED'
              ? 'SUCCEEDED'
              : result.status === 'PENDING'
                ? 'PENDING'
                : 'FAILED',
          attempts: attemptNo,
          ...(result.providerRefundRef ? { provider_refund_ref: result.providerRefundRef } : {}),
          ...(result.reason !== undefined ? { last_error: result.reason } : {}),
          vendor_transfer_reversed: result.status === 'SUCCEEDED',
          next_retry_at: next.kind === 'RETRY' ? next.at : null,
          ...(result.status === 'SUCCEEDED' ? { confirmed_at: now } : {}),
        })
        .where('id', '=', refund.id)
        .execute();

      if (result.status === 'SUCCEEDED') {
        await this.movePayment(trx, refund.orderId, 'REFUNDED');
        await transitionOrder(trx, {
          orderId: refund.orderId,
          to: 'REFUNDED',
          actorType: 'SYSTEM',
          correlationId: `refund:${refund.id}`,
        });
        return;
      }

      if (next.kind === 'RECONCILE') {
        /**
         * Retries exhausted. This becomes a queue item with an owner and an
         * age, never a silence — REF-03, and §7.2's rule that truth which
         * cannot be determined is never resolved automatically.
         */
        await trx
          .insertInto('reconciliation_item')
          .values({
            kind: 'REFUND_UNCONFIRMED',
            order_id: refund.orderId,
            state: 'OPEN',
            provider_reference: refund.id,
            expected_paise: refund.amountPaise,
            actual_paise: 0,
            delta_paise: refund.amountPaise,
          })
          .execute();

        await transitionOrder(trx, {
          orderId: refund.orderId,
          to: 'REFUND_FAILED',
          actorType: 'SYSTEM',
          correlationId: `refund:${refund.id}`,
        });

        log().error(
          {
            event: 'refund_exhausted',
            orderId: refund.orderId,
            refundId: refund.id,
            attempts: attemptNo,
          },
          'a refund could not be completed and is now a reconciliation item',
        );
        return;
      }

      // Still going. Audited on every retry, because §13.3's whole argument is
      // that a refund is never an untracked event.
      await this.audit.write(
        buildAuditEntry({
          action: 'refund.retried',
          entity: 'refund',
          entityId: refund.id,
          foodCourtId: refund.foodCourtId,
          vendorId: refund.vendorId,
          metadata: { attempt: attemptNo, outcome: result.status, reason: result.reason },
        }),
        trx,
      );
    });
  }

  /**
   * The payment row follows the refund.
   *
   * Separated out because a partial refund would set PARTIALLY_REFUNDED here
   * and the CHECK constraint on that state is strict about the amounts. Full
   * refunds are all this path produces today — see `orderRefundEntries` for
   * why partials are refused rather than guessed.
   */
  private async movePayment(
    trx: Transaction<Database>,
    orderId: string,
    to: 'REFUNDED',
  ): Promise<void> {
    await trx
      .updateTable('payment')
      .set((eb) => ({ status: to, refunded_paise: eb.ref('amount_paise') }))
      .where('order_id', '=', orderId)
      .where('status', 'in', REFUNDABLE_PAYMENT)
      .execute();
  }
}

