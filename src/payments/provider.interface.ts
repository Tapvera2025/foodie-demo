/**
 * The payment provider abstraction.
 *
 * PRD PAY-MODE-02: no order, cart or KDS code imports a provider SDK. Everything
 * goes through this interface, and `vendor.settlementMode` picks the
 * implementation. The provider choice is therefore reversible at the cost of
 * one adapter — which matters, because it is still an open decision (PRD §31.1).
 *
 * TDD §5.1.
 */

import type { Paise } from '../platform/money.js';
import type { SettlementMode } from '../pricing/fee-engine.js';

/**
 * The payment's own lifecycle. PRD §8.
 *
 * AUTHORIZED and CAPTURED are separate states, and that separation is the whole
 * mechanism rather than a detail: PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED means
 * block the money at checkout, take it when the kitchen accepts, release it
 * instantly if no stall ever does. A single SUCCESS state cannot represent the
 * interval between those two events, and that interval is where every order
 * that no stall accepts lives.
 *
 * It is also the shape of UPI single-block-multi-debit, which PRD §19.1 names
 * as the correct long-term primitive. Collapsing the two would make the target
 * architecture unimplementable and hide the difference between "the customer
 * has been charged" and "the customer could be charged".
 */
export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUND_FAILED'
  | 'RECONCILIATION_REQUIRED';

export type SplitParty = 'VENDOR' | 'OPERATOR' | 'PLATFORM_TAX_RESERVE' | 'PLATFORM';

export interface SplitAllocation {
  readonly party: SplitParty;
  /** Required for VENDOR and OPERATOR in Mode A. */
  readonly linkedAccountId?: string;
  readonly amountPaise: Paise;
}

export interface SplitInput {
  readonly orderId: string;
  /** Platform-generated. The idempotency key — a retry must not double-pay. */
  readonly transferId: string;
  readonly totalPaise: Paise;
  readonly allocations: readonly SplitAllocation[];
}

export interface SplitResult {
  readonly applied: boolean;
  readonly reason?: string;
  readonly providerTransferIds?: readonly string[];
}

export interface CreateIntentInput {
  readonly orderId: string;
  readonly vendorId: string;
  readonly amountPaise: Paise;
  readonly correlationId: string;
  /** Attached at capture in Mode A; ignored in Mode B. */
  readonly split?: SplitInput;
}

export interface PaymentIntent {
  readonly providerOrderRef: string;
  readonly amountPaise: Paise;
  /** Opaque payload the client hands to the provider's checkout SDK. */
  readonly checkoutPayload: Readonly<Record<string, unknown>>;
}

export interface CaptureInput {
  readonly orderId: string;
  readonly providerPaymentRef: string;
  /** May be less than the authorised amount where a line was rejected. */
  readonly amountPaise: Paise;
  readonly correlationId: string;
}

export interface CaptureResult {
  readonly status: 'CAPTURED' | 'FAILED' | 'EXPIRED';
  readonly capturedPaise?: Paise;
  readonly providerFeePaise?: Paise;
  readonly reason?: string;
}

export interface RefundInput {
  /** Platform-generated BEFORE the provider call, so a timeout is retryable. */
  readonly refundId: string;
  readonly orderId: string;
  readonly providerPaymentRef: string;
  readonly amountPaise: Paise;
  readonly reason: string;
  /** Mode A: claw back the vendor transfer rather than absorbing the refund. */
  readonly reverseVendorTransfer: boolean;
}

export interface RefundResult {
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  readonly providerRefundRef?: string;
  /** ADVISORY in Mode B — the platform cannot enforce a vendor-executed refund. */
  readonly authority: 'AUTHORITATIVE' | 'ADVISORY';
  readonly reason?: string;
}

export type NormalisedEventKind =
  /** Funds blocked, not taken. Under ON_ACKNOWLEDGED this is what confirms an order. */
  | 'PAYMENT_AUTHORIZED'
  /** Funds taken. Under ON_CAPTURE this is what confirms an order. */
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_FAILED'
  /**
   * No outcome inside the window; any block released. Not a failure — nothing
   * was declined, so there is nothing to explain to the customer. PAY-REC-06.
   */
  | 'PAYMENT_EXPIRED'
  | 'REFUND_SUCCEEDED'
  | 'REFUND_FAILED'
  | 'TRANSFER_SETTLED'
  /**
   * Anything we do not recognise.
   *
   * PRD §12.2: an unrecognised provider response is AMBIGUOUS. It is never a
   * success and never a failure. Mapping it to FAILED is how a paid customer
   * ends up with no order and no refund.
   */
  | 'UNKNOWN';

export interface NormalisedPaymentEvent {
  /** Idempotency key. Backed by a unique constraint on `processed_event`. */
  readonly providerEventId: string;
  readonly kind: NormalisedEventKind;
  readonly providerPaymentRef?: string;
  readonly providerRefundRef?: string;
  readonly orderId?: string;
  readonly amountPaise?: Paise;
  readonly providerFeePaise?: Paise;
  /** The provider's clock. Stored separately; never merged with ours. */
  readonly providerTimestamp?: string;
  readonly raw: unknown;
}

export interface SettlementReport {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly transactions: readonly {
    readonly reference: string;
    readonly amountPaise: Paise;
    readonly feePaise: Paise;
  }[];
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: SettlementMode;

  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;

  /**
   * Ask the provider directly what happened.
   *
   * PRD §9 case B — the frontend reports failure and the payment actually
   * succeeded. The client redirect and the webhook are independent channels,
   * the client can be wrong in both directions, and only the webhook is
   * authenticated. This is how the server stops believing either of them.
   */
  getStatus(providerPaymentRef: string): Promise<PaymentStatus>;

  /**
   * Take money that is currently only blocked.
   *
   * Called when the kitchen acknowledges, under ON_ACKNOWLEDGED. Idempotent on
   * `providerPaymentRef`: a retry after a timeout must not charge twice, and a
   * timeout is exactly when a retry happens.
   */
  capture(input: CaptureInput): Promise<CaptureResult>;

  /** Mode A executes transfers to linked accounts. Mode B is a no-op. */
  applySplit(input: SplitInput): Promise<SplitResult>;

  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Verify the signature BEFORE parsing the body. An unsigned payload is never
   * deserialised. PRD PAY-03.
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): NormalisedPaymentEvent;

  /** Null means no authoritative report — ledger entries are marked ADVISORY. */
  getSettlementReport(periodStart: string, periodEnd: string): Promise<SettlementReport | null>;
}
