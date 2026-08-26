/**
 * Webhook handling — the decision half.
 *
 * The order of operations is not negotiable (TDD §5.4):
 *
 *   1. VERIFY the signature before the body is parsed.
 *   2. Claim the provider event id. A duplicate is acknowledged and dropped —
 *      the guarantee is a unique constraint on `processed_event`, not a
 *      lookup-then-insert, which races.
 *   3. An UNKNOWN event opens reconciliation. It is never mapped to FAILED.
 *   4. Payment state and order state change in ONE transaction.
 *   5. Dispatch is enqueued as a SEPARATE committed command, so a webhook
 *      delivered twice still results in exactly one dispatch.
 *
 * This module owns steps 2 and 3 as a pure decision function so they can be
 * tested exhaustively. Steps 4 and 5 belong to the order service, which owns
 * the transaction.
 */

import type { NormalisedPaymentEvent } from './provider.interface.js';
import type { OrderCommand } from '../ordering/state-machine.js';

export type WebhookAction =
  /** Already processed. Acknowledge with 200 so the provider stops retrying. */
  | { readonly kind: 'DROP_DUPLICATE'; readonly providerEventId: string }
  /** Ambiguous. Open a reconciliation item, acknowledge, change no state. */
  | {
      readonly kind: 'RECONCILE';
      readonly providerEventId: string;
      readonly reason: ReconcileReason;
    }
  /**
   * Real money news that moves the payment but not the order — a capture
   * arriving after the authorisation already confirmed, or an authorisation
   * under ON_CAPTURE where the money has not moved yet.
   *
   * Distinct from DROP_DUPLICATE, which discards. This one is recorded.
   */
  | { readonly kind: 'PAYMENT_ONLY'; readonly providerEventId: string }
  /** Apply a state change, then enqueue any follow-up separately. */
  | {
      readonly kind: 'APPLY';
      readonly providerEventId: string;
      readonly command: OrderCommand;
      readonly enqueueDispatch: boolean;
    };

export type ReconcileReason =
  'UNRECOGNISED_EVENT' | 'NO_ORDER_REFERENCE' | 'AMOUNT_MISMATCH' | 'ORDER_NOT_FOUND';

export type SplitTiming = 'ON_CAPTURE' | 'ON_ACKNOWLEDGED';

/**
 * Which payment state is sufficient to confirm an order.
 *
 * PRD §8.2 states the binding rule as "PAYMENT.AUTHORIZED or PAYMENT.CAPTURED,
 * whichever the split timing requires" — and insists the dependency be explicit
 * rather than implied by the ordering of code. This function is that
 * explicitness. It is one line and it exists so that the reason cannot be lost
 * in a chain of ternaries.
 *
 *   ON_ACKNOWLEDGED  block at checkout, take when the kitchen accepts.
 *                    Authorisation confirms; capture comes later.
 *   ON_CAPTURE       take at checkout. Authorisation alone confirms nothing,
 *                    because the money has not moved and might not.
 */
export function confirmationRequires(timing: SplitTiming): 'AUTHORIZED' | 'CAPTURED' {
  return timing === 'ON_ACKNOWLEDGED' ? 'AUTHORIZED' : 'CAPTURED';
}

export interface WebhookContext {
  /** True if this provider event id has already been recorded. */
  readonly alreadyProcessed: boolean;
  /** Amount the platform expects, if the order is known. */
  readonly expectedAmountPaise?: number;
  readonly orderExists?: boolean;
  /** Config PAYMENTS_SPLIT_TIMING. Decides which payment state confirms. */
  readonly splitTiming: SplitTiming;
  /** True once the order has already reached PAYMENT_CONFIRMED. */
  readonly orderAlreadyConfirmed?: boolean;
}

export function decideWebhookAction(
  event: NormalisedPaymentEvent,
  ctx: WebhookContext,
): WebhookAction {
  // 2. Duplicate. Acknowledge and drop, before anything else is considered.
  if (ctx.alreadyProcessed) {
    return { kind: 'DROP_DUPLICATE', providerEventId: event.providerEventId };
  }

  // 3. Ambiguity is never failure.
  if (event.kind === 'UNKNOWN') {
    return {
      kind: 'RECONCILE',
      providerEventId: event.providerEventId,
      reason: 'UNRECOGNISED_EVENT',
    };
  }

  // A settlement notification carries no order state change.
  if (event.kind === 'TRANSFER_SETTLED') {
    return {
      kind: 'RECONCILE',
      providerEventId: event.providerEventId,
      reason: 'UNRECOGNISED_EVENT',
    };
  }

  if (event.orderId === undefined) {
    // The provider charged someone and we cannot say who. This is the
    // "customer charged, no order" case — the most dangerous one there is.
    return {
      kind: 'RECONCILE',
      providerEventId: event.providerEventId,
      reason: 'NO_ORDER_REFERENCE',
    };
  }

  if (ctx.orderExists === false) {
    return {
      kind: 'RECONCILE',
      providerEventId: event.providerEventId,
      reason: 'ORDER_NOT_FOUND',
    };
  }

  const isMoneyEvent = event.kind === 'PAYMENT_AUTHORIZED' || event.kind === 'PAYMENT_CAPTURED';

  // Money moved for the wrong amount is not money moved. Applies to both
  // authorisation and capture: a block for the wrong figure is as wrong as a
  // charge for the wrong figure, and it is cheaper to catch before the food.
  if (
    isMoneyEvent &&
    ctx.expectedAmountPaise !== undefined &&
    event.amountPaise !== undefined &&
    event.amountPaise !== ctx.expectedAmountPaise
  ) {
    return {
      kind: 'RECONCILE',
      providerEventId: event.providerEventId,
      reason: 'AMOUNT_MISMATCH',
    };
  }

  // Does this event carry the order across the confirmation line?
  //
  // Under ON_ACKNOWLEDGED the authorisation does it and the later capture is
  // bookkeeping on an order that is already cooking. Under ON_CAPTURE the
  // authorisation is real but insufficient — the money has not moved and the
  // provider may yet fail to take it — so the order waits.
  const sufficient = confirmationRequires(ctx.splitTiming);
  const confirms =
    (sufficient === 'AUTHORIZED' && isMoneyEvent) || event.kind === 'PAYMENT_CAPTURED';

  // A capture arriving after the order was confirmed by its authorisation is
  // expected traffic under ON_ACKNOWLEDGED, not a duplicate and not an error.
  // It updates the payment and leaves the order where it is.
  if (confirms && ctx.orderAlreadyConfirmed === true) {
    return { kind: 'PAYMENT_ONLY', providerEventId: event.providerEventId };
  }

  if (isMoneyEvent && !confirms) {
    // An authorisation under ON_CAPTURE. Real, recorded, and not yet a reason
    // to cook anything.
    return { kind: 'PAYMENT_ONLY', providerEventId: event.providerEventId };
  }

  const command: OrderCommand = confirms
    ? 'confirmPayment'
    : event.kind === 'PAYMENT_FAILED'
      ? 'failPayment'
      : event.kind === 'PAYMENT_EXPIRED'
        ? 'expirePayment'
        : event.kind === 'REFUND_SUCCEEDED'
          ? 'confirmRefund'
          : 'failRefund';

  return {
    kind: 'APPLY',
    providerEventId: event.providerEventId,
    command,
    // 5. Only a confirmed payment leads to dispatch, and it is enqueued after
    //    commit rather than inside the transaction.
    enqueueDispatch: confirms,
  };
}

/**
 * Every branch acknowledges with 200.
 *
 * A provider that keeps retrying because we returned 500 on an event we have
 * already decided about turns one problem into a queue of them. The only case
 * that is not a 200 is a failed signature check, which never reaches here.
 */
export function httpStatusFor(_action: WebhookAction): 200 {
  return 200;
}
