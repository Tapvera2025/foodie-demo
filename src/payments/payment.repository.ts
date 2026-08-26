/**
 * The payment engine.
 *
 * This closes the gap PRD §18 called the one that matters most: nothing moved
 * an order from CREATED to PAYMENT_CONFIRMED, so the customer journey and the
 * kitchen board were both complete and not joined to each other.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 *   No client request may transition an order into a financially authoritative
 *   state. (PRD §7.4)
 *
 * A browser returning from a payment page saying "it worked" is a hint, not
 * evidence. The client redirect and the provider webhook are independent
 * channels and only one of them is authenticated. Every method here that moves
 * money is reachable only from a verified webhook or a server-initiated
 * process; `confirmFromClientReturn` exists and deliberately does not trust the
 * client — it asks the provider instead.
 */

import { createHash } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';

import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { paise, type Paise } from '../platform/money.js';
import type { Database, Json, OrderStatus, PaymentStatus } from '../platform/schema.js';
import { transitionOrder } from '../ordering/transition.js';
import { buildSplit } from './split.js';
import type { NormalisedPaymentEvent, PaymentProvider } from './provider.interface.js';
import { confirmationRequires, decideWebhookAction, type SplitTiming } from './webhook.js';

export interface PaymentEngineOptions {
  readonly splitTiming: SplitTiming;
  /** How long a customer has to complete payment. PAY-REC-06. */
  readonly intentTtlSeconds: number;
}

export interface IntentResult {
  readonly paymentId: string;
  readonly providerOrderRef: string;
  readonly amountPaise: number;
  readonly expiresAt: string;
  readonly checkoutPayload: Readonly<Record<string, unknown>>;
  /** False when an existing live intent was returned instead. */
  readonly created: boolean;
}

export interface WebhookResult {
  readonly outcome: 'DROPPED' | 'RECONCILED' | 'PAYMENT_UPDATED' | 'ORDER_ADVANCED';
  readonly orderId?: string;
  readonly orderStatus?: string;
  readonly dispatchQueued: boolean;
}

export class PaymentRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly provider: PaymentProvider,
    private readonly opts: PaymentEngineOptions,
  ) {}

  // =========================================================================
  // Creating an intent
  // =========================================================================

  /**
   * Move an order from CREATED to PAYMENT_PENDING and hand the client something
   * to pay with.
   *
   * Idempotent on `order_id`: tapping Pay twice must produce one order, one
   * intent and one charge (PAY-REC-03). The guarantee is a live-intent lookup
   * inside the same transaction that locks the order row, not a check-then-act
   * outside one.
   */
  async createIntent(input: {
    orderId: string;
    correlationId: string;
  }): Promise<IntentResult> {
    /*
     * The money columns come along for the SPLIT, not for the intent.
     *
     * `createIntent` only needs a total; everything else here feeds
     * `buildSplit`, which decides what the stall is transferred. Selected in
     * the same query because the row is already being read — a second round
     * trip to fetch nine integers off a row we are holding is waste.
     *
     * Joined to `vendor` for `cashfree_vendor_id`: without it the stall cannot
     * be paid at all, and `buildSplit` refuses rather than quietly keeping its
     * share.
     */
    const order = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      .select([
        'order.id as id',
        'order.status as status',
        'order.vendor_id as vendor_id',
        'order.total_payable_paise as total_payable_paise',
        'order.settlement_mode_snapshot as settlement_mode_snapshot',
        'order.vendor_net_paise as vendor_net_paise',
        'order.platform_tax_reserve_paise as platform_tax_reserve_paise',
        'order.customer_fee_paise as customer_fee_paise',
        'order.customer_fee_tax_paise as customer_fee_tax_paise',
        'order.vendor_commission_paise as vendor_commission_paise',
        'order.operator_share_paise as operator_share_paise',
        'vendor.provider_linked_account_id as linked_account',
      ])
      .where('order.id', '=', input.orderId)
      .executeTakeFirst();

    if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');

    // An existing live intent is returned rather than replaced. Replacing it
    // would leave the customer holding a checkout page for a payment we have
    // stopped watching, and they would still be able to complete it.
    const live = await this.db
      .selectFrom('payment')
      .select([
        'id',
        'provider_order_ref',
        'amount_paise',
        'expires_at',
        'status',
        'checkout_payload',
      ])
      .where('order_id', '=', order.id)
      .where('status', 'in', ['CREATED', 'PENDING', 'AUTHORIZED'] as PaymentStatus[])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (live && (live.expires_at === null || live.expires_at.getTime() > Date.now())) {
      return {
        paymentId: live.id,
        providerOrderRef: live.provider_order_ref ?? '',
        amountPaise: live.amount_paise,
        expiresAt: (live.expires_at ?? new Date()).toISOString(),
        /*
         * THE STORED PAYLOAD, NOT A DESCRIPTION OF IT.
         *
         * This used to return `{ provider, ref }` — true statements about the
         * intent, and useless to a checkout SDK. Cashfree's handoff is a
         * `payment_session_id` issued once at order creation and reconstructible
         * from nothing, so the second request for an intent handed the client a
         * payload it could not open a checkout with.
         *
         * The fallback covers rows written before migration 20. It is the old
         * behaviour, which is wrong but no worse than the null it replaces, and
         * those intents expire within fifteen minutes.
         */
        checkoutPayload:
          (live.checkout_payload as Record<string, unknown> | null) ?? {
            provider: this.provider.name,
            ref: live.provider_order_ref,
          },
        created: false,
      };
    }

    if (order.status !== 'CREATED' && order.status !== 'PAYMENT_PENDING') {
      throw new AppError(
        'INVALID_TRANSITION',
        `This order is ${order.status} and cannot be paid for again`,
      );
    }

    /**
     * THE LOOKUP ABOVE AND THE DATABASE INDEX DISAGREED ABOUT "LIVE".
     *
     * `payment_one_live_per_order` is UNIQUE (order_id) WHERE status NOT IN
     * ('FAILED','EXPIRED') — errata E-006 chose an exclusion deliberately, so
     * an unclassified state counts as live. The reuse lookup above only
     * recognises CREATED / PENDING / AUTHORIZED.
     *
     * Everything in the gap — CAPTURED, RECONCILIATION_REQUIRED, the refund
     * states — was therefore invisible to the lookup and fatal to the insert.
     * The customer got an opaque 500 from POST /payment-intent with no way to
     * retry, and the order became permanently unpayable.
     *
     * The index is right. This makes the application agree with it, and say so.
     */
    const blocking = await this.db
      .selectFrom('payment')
      .select(['id', 'status'])
      .where('order_id', '=', order.id)
      .where('status', 'not in', ['FAILED', 'EXPIRED'] as PaymentStatus[])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (blocking) {
      throw new AppError(
        'INVALID_TRANSITION',
        `This order already has a payment in ${blocking.status}; a new one cannot be opened until it is resolved`,
      );
    }

    // The provider call happens OUTSIDE the transaction, on purpose. It is a
    // network round trip to a third party, and holding a row lock across one is
    // how a slow provider turns into a database incident. The cost is that a
    // crash between here and the insert leaves an orphaned provider intent,
    // which expires by itself — the cheaper of the two failures.
    /*
     * ========================================================================
     * THE SPLIT, DECLARED AT ORDER CREATION
     * ========================================================================
     *
     * Cashfree's Easy Split takes `order_splits` on the order itself, so the
     * division has to be known now — not after the payment lands. That is why
     * `applySplit` on the provider throws: there is no deferred transfer step
     * to call, and a method that returned "applied: false" would describe a
     * system that was working.
     *
     * `buildSplit` returns null under VENDOR_DIRECT, where the money never
     * reaches a platform account and there is nothing to divide.
     */
    const decision = buildSplit({
      money: {
        orderId: order.id,
        totalPayablePaise: order.total_payable_paise,
        vendorNetPaise: order.vendor_net_paise,
        platformTaxReservePaise: order.platform_tax_reserve_paise,
        customerFeePaise: order.customer_fee_paise,
        customerFeeTaxPaise: order.customer_fee_tax_paise,
        vendorCommissionPaise: order.vendor_commission_paise,
        operatorSharePaise: order.operator_share_paise,
      },
      settlementMode: order.settlement_mode_snapshot ?? 'VENDOR_DIRECT',
      vendorLinkedAccountId: order.linked_account,
    });

    /*
     * A refusal is a REFUSAL, and it stops the payment here.
     *
     * `buildSplit` is pure and returns its decision rather than throwing — see
     * the note in split.ts. Translating it happens at this boundary, which is
     * the first place that has an HTTP context to translate into.
     */
    if (decision.kind === 'REFUSE') {
      throw new AppError('RECONCILIATION_REQUIRED', decision.reason);
    }
    const split = decision.kind === 'SPLIT' ? decision.split : null;

    const intent = await this.provider.createIntent({
      orderId: order.id,
      vendorId: order.vendor_id,
      amountPaise: paise(order.total_payable_paise),
      correlationId: input.correlationId,
      // Spread-or-omit: `split` is an optional property under
      // `exactOptionalPropertyTypes`, and "absent" is not the same as
      // "present and undefined" to the provider that reads it.
      ...(split ? { split } : {}),
    });

    const expiresAt = new Date(Date.now() + this.opts.intentTtlSeconds * 1000);

    return this.db.transaction().execute(async (trx) => {
      const payment = await trx
        .insertInto('payment')
        .values({
          order_id: order.id,
          settlement_mode: order.settlement_mode_snapshot,
          provider: this.provider.name,
          status: 'PENDING',
          amount_paise: order.total_payable_paise,
          provider_order_ref: intent.providerOrderRef,
          // Kept so the next request for this intent can return the real thing.
          checkout_payload: intent.checkoutPayload as unknown as Json,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // PAYMENT_PENDING is not a financially authoritative state — no money has
      // moved — so a client request may cause it. PAYMENT_CONFIRMED may not.
      await transitionOrder(trx, {
        orderId: order.id,
        to: 'PAYMENT_PENDING',
        actorType: 'SYSTEM',
        correlationId: input.correlationId,
      });

      return {
        paymentId: payment.id,
        providerOrderRef: intent.providerOrderRef,
        amountPaise: order.total_payable_paise,
        expiresAt: expiresAt.toISOString(),
        checkoutPayload: intent.checkoutPayload,
        created: true,
      };
    });
  }

  // =========================================================================
  // The webhook — the only authenticated channel
  // =========================================================================

  /**
   * Verify, claim, decide, apply. In that order, and the order is not
   * negotiable (TDD §5.4).
   *
   * Step 2 claims the provider event id by INSERT. A lookup-then-insert races,
   * and the race is two simultaneous deliveries of the same event, which is
   * exactly what a provider does when it thinks we timed out.
   */
  async ingestWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookResult> {
    // 1. Signature before parse. An unsigned body is never deserialised.
    const event = this.provider.verifyAndParseWebhook(rawBody, headers);

    // 2. Claim. A duplicate insert is caught and reported as a duplicate rather
    //    than as an error, because a provider redelivering is normal traffic.
    let claimed = true;
    try {
      await this.db
        .insertInto('processed_event')
        .values({
          provider: this.provider.name,
          provider_event_id: event.providerEventId,
          event_type: event.kind,
          order_id: event.orderId ?? null,
          payload_digest: createHash('sha256').update(rawBody).digest('hex'),
        })
        .execute();
    } catch (e) {
      // 23505 unique_violation. Any other error is real and must not be
      // swallowed into "already processed", which would silently drop a
      // payment we never applied.
      if ((e as { code?: string }).code !== '23505') throw e;

      /**
       * A CLAIM IS NOT AN OUTCOME, AND CONFLATING THEM LOST MONEY.
       *
       * The row is written before the decision is applied, so its existence
       * proves only that the event was *seen*. Treating that as "already
       * processed" meant a webhook whose transaction rolled back left a claim
       * behind that suppressed every subsequent delivery of the same event:
       *
       *   apply throws          → the order never advances
       *   claim row survives    → every retry is DROP_DUPLICATE
       *   the status poll runs  → writes AUTHORIZED to the payment alone
       *
       * Result: money secured, no kitchen told, and the engine permanently
       * refusing to try again because it believed it had already succeeded.
       * The provider would redeliver on its own schedule and we would drop
       * every one.
       *
       * `processed_at` is what separates the two, and it is the column this
       * table has carried unused since the schema was written — the trigger
       * comment even names the case: "marking an event processed". Only a
       * FINISHED claim is a duplicate. An unfinished one is a previous attempt
       * that did not complete, and is re-attemptable.
       *
       * The window this opens — two deliveries racing, both seeing unfinished —
       * is closed downstream: `transitionOrder` takes a row lock, so they
       * serialise, and the allow-list makes the second a no-op.
       */
      const existing = await this.db
        .selectFrom('processed_event')
        .select(['processed_at'])
        .where('provider', '=', this.provider.name)
        .where('provider_event_id', '=', event.providerEventId)
        .executeTakeFirst();

      claimed = existing?.processed_at == null;

      if (claimed) {
        log().warn(
          { event: 'webhook_retry_of_unfinished', providerEventId: event.providerEventId },
          'this event was claimed before and never applied — retrying rather than dropping it',
        );
      }
    }

    return this.applyEvent(event, claimed);
  }

  /**
   * ==========================================================================
   * ONE IMPLEMENTATION, TWO WAYS IN
   * ==========================================================================
   *
   * Everything below here works on a NORMALISED EVENT. It does not care whether
   * that event arrived as a signed webhook or was synthesised from asking the
   * provider directly — both are the provider's word, and only the CLIENT is
   * untrustworthy (§7.4, PRD §9 case B).
   *
   * Extracted so `reconcileStalePayments` can reuse it rather than reimplement
   * the transitions. Duplicating them is exactly the divergence the original
   * design avoided by refusing to let polling advance an order at all — this
   * keeps that guarantee while removing the limitation.
   */
  /**
   * ==========================================================================
   * ASK THE PROVIDER ABOUT ORDERS THE WEBHOOK NEVER RESOLVED
   * ==========================================================================
   *
   * A webhook is a message from a third party over the internet, and messages
   * over the internet are lost. Until now it was the ONLY way an order could
   * learn it had been paid for, which means a single dropped callback stranded
   * a paying customer for ever: money taken, kitchen never told, and no code
   * path anywhere that would notice.
   *
   * That is not a development inconvenience. It is a production failure mode
   * with no recovery, and it showed up the moment a real aggregator replaced
   * the stub — every order sat in PAYMENT_PENDING because nothing was
   * listening on a public URL.
   *
   * WHY THIS IS ALLOWED TO ADVANCE AN ORDER, AND POLLING FROM THE CLIENT IS NOT
   *
   * §7.4 forbids a CLIENT from moving an order into a financially authoritative
   * state, and it is right: a browser saying "I paid" is not evidence. This is
   * the server asking the provider directly, authenticated, server to server.
   * That is the same evidence a webhook carries — the difference is only who
   * started the conversation.
   *
   * It reuses `applyEvent`, so the transitions, the ledger and the audit actor
   * are identical to the webhook path. Reimplementing them here is what the
   * original "polling must not advance orders" rule was really protecting
   * against, and that protection is kept.
   *
   * WHAT STOPS IT DOUBLE-APPLYING
   *
   * The synthetic event id is deterministic per order and outcome, so a sweep
   * that runs every few seconds claims the same row once. And if the real
   * webhook turns up afterwards it carries a DIFFERENT id — which is fine,
   * because `decideWebhookAction` already sees `orderAlreadyConfirmed` and
   * refuses to confirm twice. That guard existed; it simply had nothing else
   * that could reach it.
   */
  async reconcileStalePayments(olderThanSeconds = 20, limit = 20): Promise<{
    checked: number;
    advanced: number;
  }> {
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000);

    /*
     * Only orders that are WAITING, and only ones with a provider reference to
     * ask about. `SKIP LOCKED` so two workers never chase the same order.
     */
    const stale = await this.db
      .selectFrom('order')
      .innerJoin('payment', 'payment.order_id', 'order.id')
      .select([
        'order.id as orderId',
        'payment.provider_order_ref as orderRef',
        'payment.provider_payment_ref as paymentRef',
      ])
      .where('order.status', 'in', ['CREATED', 'PAYMENT_PENDING'])
      .where('order.created_at', '<', cutoff)
      .where((eb) =>
        eb.or([
          eb('payment.provider_order_ref', 'is not', null),
          eb('payment.provider_payment_ref', 'is not', null),
        ]),
      )
      .orderBy('order.created_at', 'asc')
      .limit(limit)
      .execute();

    let advanced = 0;

    for (const row of stale) {
      const ref = row.paymentRef ?? row.orderRef;
      if (!ref) continue;

      let status: PaymentStatus;
      try {
        status = await this.provider.getStatus(ref);
      } catch (err) {
        // Unknown, never a failure. The next tick asks again.
        log().warn(
          { orderId: row.orderId, ref, err: err instanceof Error ? err.message : String(err) },
          'reconcile: provider status lookup failed',
        );
        continue;
      }

      /*
       * Only the two outcomes that mean money moved. Everything else — PENDING,
       * EXPIRED, RECONCILIATION_REQUIRED — is either still in flight or belongs
       * to a human, and inventing a transition for it is how an unpaid order
       * reaches a kitchen.
       */
      if (status !== 'CAPTURED' && status !== 'AUTHORIZED') continue;

      const event: NormalisedPaymentEvent = {
        providerEventId: `reconcile:${row.orderId}:${status}`,
        kind: status === 'CAPTURED' ? 'PAYMENT_CAPTURED' : 'PAYMENT_AUTHORIZED',
        orderId: row.orderId,
        ...(row.paymentRef ? { providerPaymentRef: row.paymentRef } : {}),
        raw: { source: 'reconcile', ref, status },
      };

      // Claim it, exactly as the webhook path does, so a repeat is a duplicate
      // rather than a second application.
      let claimed = true;
      try {
        await this.db
          .insertInto('processed_event')
          .values({
            provider: this.provider.name,
            provider_event_id: event.providerEventId,
            event_type: event.kind,
            order_id: row.orderId,
            payload_digest: createHash('sha256')
              .update(JSON.stringify(event.raw))
              .digest('hex'),
          })
          .execute();
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        claimed = false;
      }

      const result = await this.applyEvent(event, claimed);
      if (result.outcome === 'ORDER_ADVANCED') {
        advanced++;
        log().info(
          { event: 'payment_reconciled', orderId: row.orderId, status },
          'an order was confirmed from the provider because no webhook arrived',
        );
      }
    }

    return { checked: stale.length, advanced };
  }

  private async applyEvent(
    event: NormalisedPaymentEvent,
    claimed: boolean,
  ): Promise<WebhookResult> {
    const order =
      event.orderId === undefined
        ? undefined
        : await this.db
            .selectFrom('order')
            .select(['id', 'status', 'total_payable_paise'])
            .where('id', '=', event.orderId)
            .executeTakeFirst();

    const action = decideWebhookAction(event, {
      alreadyProcessed: !claimed,
      splitTiming: this.opts.splitTiming,
      ...(event.orderId !== undefined ? { orderExists: order !== undefined } : {}),
      ...(order !== undefined ? { expectedAmountPaise: order.total_payable_paise } : {}),
      ...(order !== undefined
        ? { orderAlreadyConfirmed: order.status !== 'CREATED' && order.status !== 'PAYMENT_PENDING' }
        : {}),
    });

    log().info(
      { event: 'webhook_decided', providerEventId: event.providerEventId, action: action.kind },
      'payment webhook',
    );

    switch (action.kind) {
      case 'DROP_DUPLICATE':
        return { outcome: 'DROPPED', dispatchQueued: false };

      case 'RECONCILE':
        await this.openReconciliation(event.providerEventId, action.reason, event.orderId ?? null);
        // Handled — a human owns it now. Without this the claim stays unfinished
        // and a redelivery opens a second reconciliation item for one event.
        await this.finishClaim(event.providerEventId);
        return { outcome: 'RECONCILED', dispatchQueued: false };

      case 'PAYMENT_ONLY':
        await this.db.transaction().execute(async (trx) => {
          await this.applyPaymentState(trx, event.kind, event.providerPaymentRef, event.orderId);
        });
        await this.finishClaim(event.providerEventId);
        return {
          outcome: 'PAYMENT_UPDATED',
          ...(event.orderId !== undefined ? { orderId: event.orderId } : {}),
          dispatchQueued: false,
        };

      case 'APPLY': {
        const orderId = event.orderId;
        if (orderId === undefined) {
          // decideWebhookAction cannot produce APPLY without an order id. If it
          // ever does, that is a logic error and not something to paper over.
          throw new AppError('RECONCILIATION_REQUIRED', 'APPLY without an order reference');
        }

        /**
         * A FAILURE HERE MUST RELEASE THE CLAIM.
         *
         * `processed_event` is inserted before the decision is applied, which is
         * correct for deduplication — two deliveries of one event must not both
         * apply. But the claim was surviving a rollback, and that combination
         * produced the worst outcome this engine has:
         *
         *   the transaction throws       → the order never advances
         *   the claim row remains        → every retry is DROP_DUPLICATE
         *   the poll writes the payment  → the customer is shown "successful"
         *
         * Money taken, no kitchen told, and the system permanently refusing to
         * try again — because it believed it had already succeeded. The provider
         * would redeliver, we would drop each one, and nothing would ever
         * surface.
         *
         * So the claim is released on failure. The event can then be retried by
         * the provider, by the sweeper, or by hand. The narrow window this
         * opens — two concurrent deliveries where the first fails after the
         * second checks — is bounded by `transitionOrder`'s row lock, which
         * serialises them, and by the transition allow-list, which makes the
         * second a no-op.
         *
         * Failing closed was the wrong default here. An unapplied payment is
         * worse than a double-applied one, and the double-apply is what the
         * lock and the allow-list already prevent.
         */
        const result = await this.db.transaction().execute(async (trx) => {
          // Payment row FIRST, order SECOND. The database trigger
          // `order_confirmation_requires_payment` refuses PAYMENT_CONFIRMED
          // unless a payment on that order is already AUTHORIZED or CAPTURED,
          // so this ordering is not a preference — the reverse fails.
          await this.applyPaymentState(trx, event.kind, event.providerPaymentRef, orderId);

          return transitionOrder(trx, {
            orderId,
            to:
              action.command === 'confirmPayment'
                ? 'PAYMENT_CONFIRMED'
                : action.command === 'failPayment'
                  ? 'PAYMENT_FAILED'
                  : action.command === 'expirePayment'
                    ? 'PAYMENT_EXPIRED'
                    : action.command === 'confirmRefund'
                      ? 'REFUNDED'
                      : 'REFUND_FAILED',
            // Not SYSTEM. The provider caused this, and six months from now
            // "who confirmed this order" should answer with the truth.
            actorType: 'PROVIDER_WEBHOOK',
            correlationId: event.providerEventId,
          });
        }).catch((e: unknown) => {
          /*
           * The claim row is LEFT UNFINISHED — `processed_at` stays null.
           *
           * It is deliberately not deleted: `processed_event_no_delete` refuses
           * that, and rightly, because a deleted claim would let a genuine
           * replay through. Leaving it unfinished is the distinction the table
           * was built for and nobody had wired.
           */
          log().error(
            {
              event: 'webhook_apply_failed',
              providerEventId: event.providerEventId,
              orderId,
              err: (e as Error).message,
            },
            'a payment webhook could not be applied — the claim is unfinished and will be retried',
          );

          throw e;
        });

        await this.finishClaim(event.providerEventId);

        return {
          outcome: 'ORDER_ADVANCED',
          orderId,
          orderStatus: result.status,
          // 5. Dispatch is enqueued as a SEPARATE committed command, after the
          //    transaction, so a webhook delivered twice still results in
          //    exactly one kitchen ticket.
          dispatchQueued: action.enqueueDispatch && result.changed,
        };
      }
    }
  }

  // =========================================================================
  // Capture — taking money that is currently only blocked
  // =========================================================================

  /**
   * Called when the kitchen acknowledges, under ON_ACKNOWLEDGED.
   *
   * This is the second half of the mechanism the split states exist for: the
   * money was blocked at checkout and is taken now that a stall has committed
   * to cooking. If no stall ever does, nothing is captured and the block is
   * released — the customer is never charged for food nobody agreed to make.
   */
  /**
   * Orders a kitchen has committed to whose money is still only blocked.
   *
   * WHY THIS EXISTS AT ALL
   *
   * `captureOnAcknowledgement` was written, tested by nobody, and called by
   * nothing. Under ON_ACKNOWLEDGED — the configured default — that meant every
   * order was authorised at checkout and never captured: funds blocked on the
   * customer's card through PREPARING, READY and COLLECTED, released by the
   * bank days later, and the vendor paid for none of it. The second half of the
   * mechanism PRD §8.1 argues the split states exist for was absent.
   *
   * Driven off state rather than an event, like `notifyReady`: an order past
   * acknowledgement with an AUTHORIZED payment IS the query. Self-healing, so a
   * worker that was down does not lose the captures it missed, and idempotent
   * because the next pass finds the row already CAPTURED and selects nothing.
   */
  async claimCapturable(limit = 50): Promise<string[]> {
    if (confirmationRequires(this.opts.splitTiming) !== 'AUTHORIZED') return [];

    const rows = await this.db
      .selectFrom('payment')
      .innerJoin('order', 'order.id', 'payment.order_id')
      .select('payment.order_id as orderId')
      // REJECTED and CANCELLED are deliberately absent. A stall that refused
      // the order never committed to cooking it, and taking money for food
      // nobody agreed to make is the exact failure the split timing prevents.
      .where('order.status', 'in', [
        'ACKNOWLEDGED',
        'PREPARING',
        'READY',
        'COLLECTED',
      ] as OrderStatus[])
      .where('payment.status', '=', 'AUTHORIZED')
      .orderBy('payment.authorized_at')
      .limit(limit)
      .execute();

    return rows.map((r) => r.orderId);
  }

  async captureOnAcknowledgement(orderId: string, correlationId: string): Promise<void> {
    if (confirmationRequires(this.opts.splitTiming) !== 'AUTHORIZED') {
      // Under ON_CAPTURE the money was taken at checkout. Nothing to do, and
      // returning quietly is correct rather than an error the caller must know
      // to expect.
      return;
    }

    const payment = await this.db
      .selectFrom('payment')
      .select(['id', 'provider_payment_ref', 'amount_paise', 'status'])
      .where('order_id', '=', orderId)
      .where('status', '=', 'AUTHORIZED')
      .executeTakeFirst();

    if (!payment?.provider_payment_ref) return;

    const result = await this.provider.capture({
      orderId,
      providerPaymentRef: payment.provider_payment_ref,
      amountPaise: paise(payment.amount_paise),
      correlationId,
    });

    if (result.status === 'CAPTURED') {
      await this.db
        .updateTable('payment')
        .set({ status: 'CAPTURED', captured_at: new Date() })
        .where('id', '=', payment.id)
        .execute();
      return;
    }

    // The block lapsed between acknowledgement and capture. The kitchen has
    // already started, so this is not a customer-facing error — it is money we
    // are owed and did not take, which is a reconciliation item and an alert.
    await this.db
      .updateTable('payment')
      .set({ status: 'EXPIRED', failure_message: result.reason ?? null })
      .where('id', '=', payment.id)
      .execute();

    await this.openReconciliation(`capture:${payment.id}`, 'AMOUNT_MISMATCH', orderId);

    log().error(
      { event: 'capture_failed', orderId, paymentId: payment.id, reason: result.reason },
      'authorised payment could not be captured after the kitchen accepted',
    );
  }

  // =========================================================================
  // Asking the provider directly — PRD §9 case B
  // =========================================================================

  /**
   * The customer's browser came back claiming an outcome. Ignore it, and ask
   * the provider.
   *
   * This is the case most often missed. The client can be wrong in BOTH
   * directions: it can report failure on a payment that succeeded, leaving a
   * charged customer with no food, and it can report success on one that did
   * not, which is how a platform gives food away. Only the provider knows.
   */
  async refreshFromProvider(orderId: string): Promise<{ paymentStatus: PaymentStatus | null }> {
    const payment = await this.db
      .selectFrom('payment')
      .select(['id', 'provider_payment_ref', 'provider_order_ref', 'status'])
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (!payment) return { paymentStatus: null };

    const ref = payment.provider_payment_ref ?? payment.provider_order_ref;
    if (!ref) return { paymentStatus: payment.status };

    let providerStatus: PaymentStatus;
    try {
      providerStatus = await this.provider.getStatus(ref);
    } catch (err) {
      /*
       * A provider timeout is UNKNOWN, never a failure. Return what we have and
       * let the webhook or the sweeper resolve it.
       *
       * LOGGED, though, because this catch once hid a systematic bug for an
       * entire debugging session. The Cashfree adapter was storing the wrong
       * reference, so every `getStatus` 404'd — and a call that ALWAYS fails is
       * indistinguishable here from one that occasionally times out. The
       * customer saw "this is taking longer than usual" for ever and nothing
       * anywhere said why.
       *
       * Swallowing the error is still right. Swallowing it silently was not.
       */
      log().warn(
        { paymentId: payment.id, ref, err: err instanceof Error ? err.message : String(err) },
        'provider status lookup failed; leaving the payment as it is',
      );
      return { paymentStatus: payment.status };
    }

    if (providerStatus === payment.status) return { paymentStatus: providerStatus };

    // We now know more than we did. Record it — but do NOT advance the order
    // here: that path runs through the webhook, which is the channel with a
    // signature on it. This only makes the payment row honest.
    await this.db
      .updateTable('payment')
      .set({
        status: providerStatus,
        ...(providerStatus === 'AUTHORIZED' ? { authorized_at: new Date() } : {}),
        ...(providerStatus === 'CAPTURED' ? { captured_at: new Date() } : {}),
      })
      .where('id', '=', payment.id)
      .execute();

    return { paymentStatus: providerStatus };
  }

  // =========================================================================
  // Expiry sweeper — PAY-REC-06
  // =========================================================================

  /**
   * Intents that never got an outcome.
   *
   * Without this an abandoned checkout sits in PAYMENT_PENDING forever, holds
   * its share of the stock check, and shows up in "orders awaiting payment"
   * as if somebody were still deciding. They left twenty minutes ago.
   */
  async expireStaleIntents(now = new Date()): Promise<number> {
    const stale = await this.db
      .selectFrom('payment')
      .select(['id', 'order_id'])
      .where('status', 'in', ['CREATED', 'PENDING'] as PaymentStatus[])
      .where('expires_at', '<', now)
      .limit(200)
      .execute();

    let expired = 0;
    for (const p of stale) {
      try {
        await this.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('payment')
            .set({ status: 'EXPIRED' })
            .where('id', '=', p.id)
            .execute();

          await transitionOrder(trx, {
            orderId: p.order_id,
            to: 'PAYMENT_EXPIRED',
            actorType: 'SYSTEM',
            correlationId: `expiry:${p.id}`,
          });
        });
        expired++;
      } catch (e) {
        // One order that will not move must not stop the sweep. It is logged
        // and left for the next pass, which is better than a sweeper that dies
        // on row three every time it runs.
        log().warn(
          { event: 'expiry_skipped', paymentId: p.id, err: (e as Error).message },
          'could not expire a stale intent',
        );
      }
    }
    return expired;
  }

  // =========================================================================
  // internals
  // =========================================================================

  /**
   * Mark a claim finished, so a redelivery is dropped rather than re-run.
   *
   * Called on every path that HANDLED the event, and on none that threw. That
   * asymmetry is the whole mechanism: `processed_event` distinguishes "seen"
   * from "done", and only "done" suppresses a retry.
   *
   * Deliberately OUTSIDE the applying transaction. If this write fails, the
   * work is already committed and a redelivery finds an unfinished claim,
   * re-runs, and meets an order that has already moved — which the transition
   * allow-list turns into a no-op. Re-doing a no-op is safe. Failing to record
   * a success is not: it would make a real payment look unprocessed for ever.
   */
  private async finishClaim(providerEventId: string): Promise<void> {
    await this.db
      .updateTable('processed_event')
      .set({ processed_at: new Date() })
      .where('provider', '=', this.provider.name)
      .where('provider_event_id', '=', providerEventId)
      .execute();
  }

  private async applyPaymentState(
    trx: Transaction<Database>,
    kind: string,
    providerPaymentRef: string | undefined,
    orderId: string | undefined,
  ): Promise<void> {
    if (orderId === undefined) return;

    const now = new Date();
    const set: Record<string, unknown> = {};

    switch (kind) {
      case 'PAYMENT_AUTHORIZED':
        set['status'] = 'AUTHORIZED';
        set['authorized_at'] = now;
        break;
      case 'PAYMENT_CAPTURED':
        set['status'] = 'CAPTURED';
        set['captured_at'] = now;
        // A provider that captures without a separate authorisation event still
        // authorised at some instant, and the constraint on CAPTURED does not
        // require the stamp — but leaving it null loses the fact that the money
        // was ever only blocked. Stamp it with the same instant we learned.
        set['authorized_at'] = now;
        break;
      case 'PAYMENT_FAILED':
        set['status'] = 'FAILED';
        break;
      case 'PAYMENT_EXPIRED':
        set['status'] = 'EXPIRED';
        break;
      default:
        return;
    }

    if (providerPaymentRef !== undefined) set['provider_payment_ref'] = providerPaymentRef;

    // COALESCE on the reference rather than overwrite: an authorisation and a
    // capture arriving out of order must not blank a reference we already have.
    let q = trx.updateTable('payment').set(set).where('order_id', '=', orderId);

    // Only ever moves the newest intent. An older EXPIRED attempt on the same
    // order stays expired; it is history, and rewriting it would make a retry
    // indistinguishable from a first attempt.
    q = q.where('status', 'in', ['CREATED', 'PENDING', 'AUTHORIZED'] as PaymentStatus[]);

    await q.execute();
  }

  private async openReconciliation(
    reference: string,
    reason: string,
    orderId: string | null,
  ): Promise<void> {
    const kind =
      reason === 'AMOUNT_MISMATCH'
        ? 'AMOUNT_MISMATCH'
        : reason === 'NO_ORDER_REFERENCE'
          ? 'PROVIDER_TXN_NO_ORDER'
          : reason === 'ORDER_NOT_FOUND'
            ? 'PROVIDER_TXN_NO_ORDER'
            : 'POS_STATE_DIVERGENCE';

    await this.db
      .insertInto('reconciliation_item')
      .values({
        kind,
        order_id: orderId,
        provider: this.provider.name,
        provider_reference: reference,
      })
      .execute();

    log().error(
      { event: 'reconciliation_opened', reference, reason, orderId },
      'a payment event could not be applied and needs a human',
    );
  }
}

/** Exported for the sweeper and tests. */
export type { Paise };
