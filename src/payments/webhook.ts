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
  /** Apply a state change, then enqueue any follow-up separately. */
  | {
      readonly kind: 'APPLY';
      readonly providerEventId: string;
      readonly command: OrderCommand;
      readonly enqueueDispatch: boolean;
    };

export type ReconcileReason =
  'UNRECOGNISED_EVENT' | 'NO_ORDER_REFERENCE' | 'AMOUNT_MISMATCH' | 'ORDER_NOT_FOUND';

export interface WebhookContext {
  /** True if this provider event id has already been recorded. */
  readonly alreadyProcessed: boolean;
  /** Amount the platform expects, if the order is known. */
  readonly expectedAmountPaise?: number;
  readonly orderExists?: boolean;
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

  // A success for the wrong amount is not a success.
  if (
    event.kind === 'PAYMENT_SUCCEEDED' &&
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

  const command: OrderCommand =
    event.kind === 'PAYMENT_SUCCEEDED'
      ? 'confirmPayment'
      : event.kind === 'PAYMENT_FAILED'
        ? 'failPayment'
        : event.kind === 'REFUND_SUCCEEDED'
          ? 'confirmRefund'
          : 'failRefund';

  return {
    kind: 'APPLY',
    providerEventId: event.providerEventId,
    command,
    // 5. Only a confirmed payment leads to dispatch, and it is enqueued after
    //    commit rather than inside the transaction.
    enqueueDispatch: event.kind === 'PAYMENT_SUCCEEDED',
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
