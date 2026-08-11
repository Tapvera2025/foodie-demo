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

export type PaymentStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
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
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
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
  getStatus(providerPaymentRef: string): Promise<PaymentStatus>;

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
