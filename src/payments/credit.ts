/**
 * Platform credit, and its mutual exclusion with refund-to-source.
 *
 * THE MOST DANGEROUS LOGIC IN THE PLATFORM.
 *
 * PRD REF-05 requires that a customer can never both spend instant platform
 * credit AND receive the refund to their bank. Getting this wrong means paying
 * out twice, silently, on precisely the orders where the customer is already
 * unhappy — so nobody complains and nobody notices.
 *
 * Why credit exists at all: a UPI refund to source lands somewhere between the
 * next day and a week later. A customer sitting at a table who has just been
 * told their food is not coming will not accept "two to seven working days".
 * So we credit instantly and refund in the background — and then we must make
 * absolutely sure only one of those two ever completes.
 *
 * LOCK ORDERING — the one rule that prevents deadlock:
 *
 *     ALWAYS lock platform_credit BEFORE refund. In every code path. No
 *     exceptions.
 *
 * The decision logic lives here as pure functions so every branch can be tested
 * exhaustively. The transaction and the row locks belong to the service.
 *
 * TDD §6.
 */

import { AppError } from '../platform/errors.js';
import type { Paise } from '../platform/money.js';

export type CreditStatus = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'VOIDED';
export type RefundStatus = 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED';

export interface CreditRecord {
  readonly id: string;
  readonly originOrderId: string;
  readonly amountPaise: Paise;
  readonly status: CreditStatus;
  readonly expiresAt: Date;
}

export interface RefundRecord {
  readonly id: string;
  readonly orderId: string;
  readonly amountPaise: Paise;
  readonly status: RefundStatus;
  readonly providerRefundRef?: string;
}

/* ------------------------------------------------------------------------- */
/* Spending credit                                                            */
/* ------------------------------------------------------------------------- */

export type ConsumeDecision =
  /** Safe to spend. No refund exists, or it already failed for good. */
  | { readonly kind: 'CONSUME' }
  /**
   * A refund is in flight. Try to cancel it with the provider first; only if
   * that succeeds may the credit be spent.
   */
  | { readonly kind: 'CANCEL_REFUND_THEN_CONSUME'; readonly refundId: string }
  /** Refuse, with the reason the customer should be shown. */
  | { readonly kind: 'REFUSE'; readonly code: ConsumeRefusal };

export type ConsumeRefusal = 'CREDIT_NOT_AVAILABLE' | 'CREDIT_EXPIRED' | 'CREDIT_ALREADY_REFUNDED';

export function decideCreditConsumption(
  credit: CreditRecord,
  refund: RefundRecord | undefined,
  now: Date,
): ConsumeDecision {
  if (credit.status !== 'ISSUED') {
    return { kind: 'REFUSE', code: 'CREDIT_NOT_AVAILABLE' };
  }
  if (credit.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'REFUSE', code: 'CREDIT_EXPIRED' };
  }

  if (refund === undefined) return { kind: 'CONSUME' };

  switch (refund.status) {
    case 'SUCCEEDED':
      // The money is already back in their bank. Spending the credit too would
      // pay them twice.
      return { kind: 'REFUSE', code: 'CREDIT_ALREADY_REFUNDED' };

    case 'REQUESTED':
    case 'PENDING':
      // Still in flight. It must be stopped before the credit can be spent.
      return { kind: 'CANCEL_REFUND_THEN_CONSUME', refundId: refund.id };

    case 'FAILED':
    case 'ABANDONED':
      // No money went back. The credit is the customer's only remedy.
      return { kind: 'CONSUME' };
  }
}

/**
 * Called after attempting to cancel an in-flight refund with the provider.
 * If the provider would not stop it, the credit loses — the bank refund wins,
 * because we cannot un-send money.
 */
export function afterRefundCancelAttempt(cancelled: boolean): ConsumeDecision {
  return cancelled ? { kind: 'CONSUME' } : { kind: 'REFUSE', code: 'CREDIT_ALREADY_REFUNDED' };
}

export function assertConsumable(decision: ConsumeDecision): void {
  if (decision.kind === 'REFUSE') {
    const detail =
      decision.code === 'CREDIT_ALREADY_REFUNDED'
        ? 'the refund has already reached the customer'
        : 'credit is not available';
    throw new AppError(decision.code, detail);
  }
}

/* ------------------------------------------------------------------------- */
/* Confirming a refund                                                        */
/* ------------------------------------------------------------------------- */

export type RefundConfirmDecision =
  /** Normal. Mark the refund succeeded; void any unspent credit. */
  | { readonly kind: 'CONFIRM'; readonly voidCreditId?: string }
  /**
   * UNREACHABLE BY DESIGN — the customer has already spent the credit AND the
   * bank refund landed. `decideCreditConsumption` is supposed to have cancelled
   * the refund before allowing the spend, so arriving here means a defect.
   *
   * Do not silently absorb it: open a reconciliation item and page someone.
   * `v_credit_refund_conflict` in schema.sql exists to catch the same state.
   */
  | { readonly kind: 'DOUBLE_PAYOUT'; readonly creditId: string; readonly refundId: string };

export function decideRefundConfirmation(
  credit: CreditRecord | undefined,
  refund: RefundRecord,
): RefundConfirmDecision {
  if (credit === undefined) return { kind: 'CONFIRM' };

  if (credit.status === 'CONSUMED') {
    return { kind: 'DOUBLE_PAYOUT', creditId: credit.id, refundId: refund.id };
  }

  if (credit.status === 'ISSUED') {
    // Unspent. Void it — the money went back to the bank instead.
    return { kind: 'CONFIRM', voidCreditId: credit.id };
  }

  // Already expired or voided. Nothing to do.
  return { kind: 'CONFIRM' };
}

/* ------------------------------------------------------------------------- */
/* Invariant                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The property that must hold for every order, forever.
 *
 * Mirrors `v_credit_refund_conflict`. Asserted in tests and in the nightly
 * invariant job. A single violation is a paging incident, not a tuning problem.
 */
export function violatesMutualExclusion(
  credit: CreditRecord | undefined,
  refund: RefundRecord | undefined,
): boolean {
  if (credit === undefined || refund === undefined) return false;
  return credit.status === 'CONSUMED' && refund.status === 'SUCCEEDED';
}

/** Credit is a liability from the moment it is issued. Never revenue. */
export const CREDIT_LEDGER_ENTRY = {
  issued: 'PLATFORM_CREDIT_ISSUED',
  consumed: 'PLATFORM_CREDIT_CONSUMED',
  expired: 'PLATFORM_CREDIT_EXPIRED',
} as const;
