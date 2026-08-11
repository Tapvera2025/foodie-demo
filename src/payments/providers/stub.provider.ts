/**
 * The stub payment provider.
 *
 * This is not a toy. PRD §4.6 makes sandbox fidelity a provider selection
 * criterion, and says plainly: if you cannot simulate a failed refund, a delayed
 * webhook and a duplicate webhook, then failure testing is theatre.
 *
 * The real provider is still an open decision (PRD §31.1). This stub lets weeks
 * 5–7 — order lifecycle, refunds, dispatch escalation — be built and chaos-tested
 * against the interface without waiting for it.
 *
 * TDD §17.2.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../platform/errors.js';
import { paise, type Paise } from '../../platform/money.js';
import type { SettlementMode } from '../../pricing/fee-engine.js';
import type {
  CreateIntentInput,
  NormalisedPaymentEvent,
  PaymentIntent,
  PaymentProvider,
  PaymentStatus,
  RefundInput,
  RefundResult,
  SettlementReport,
  SplitInput,
  SplitResult,
} from '../provider.interface.js';

/** Everything the chaos suite needs to bend. */
export interface StubFaults {
  /** Reject createIntent outright. */
  readonly failCreateIntent?: boolean;
  /** Refund returns FAILED, so the retry schedule is exercised. */
  readonly failRefund?: boolean;
  /** Refund stays PENDING forever — the "stuck refund" alert path. */
  readonly refundNeverConfirms?: boolean;
  /** applySplit fails, so the transfer-reversal path is exercised. */
  readonly failSplit?: boolean;
  /** getStatus throws, simulating a provider timeout. */
  readonly statusTimesOut?: boolean;
  /** Emit an event kind we do not recognise. Must NOT become FAILED. */
  readonly emitUnknownEvent?: boolean;
  /** No settlement report, as in Mode B. Ledger entries become ADVISORY. */
  readonly noSettlementReport?: boolean;
}

export interface StubOptions {
  readonly mode?: SettlementMode;
  readonly secret?: string;
  readonly faults?: StubFaults;
}

interface Recorded {
  readonly orderId: string;
  readonly amountPaise: Paise;
  status: PaymentStatus;
}

export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  readonly mode: SettlementMode;

  private readonly secret: string;
  private readonly faults: StubFaults;
  private readonly payments = new Map<string, Recorded>();
  private readonly splits = new Map<string, SplitResult>();
  private seq = 0;

  constructor(opts: StubOptions = {}) {
    this.mode = opts.mode ?? 'PLATFORM_COLLECT';
    this.secret = opts.secret ?? 'stub-secret';
    this.faults = opts.faults ?? {};
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    if (this.faults.failCreateIntent) {
      throw new AppError('RECONCILIATION_REQUIRED', 'stub: createIntent failed');
    }
    const ref = `stub_pay_${++this.seq}`;
    this.payments.set(ref, {
      orderId: input.orderId,
      amountPaise: input.amountPaise,
      status: 'PENDING',
    });
    return {
      providerOrderRef: ref,
      amountPaise: input.amountPaise,
      checkoutPayload: { provider: 'stub', ref },
    };
  }

  async getStatus(providerPaymentRef: string): Promise<PaymentStatus> {
    if (this.faults.statusTimesOut) {
      // A timeout is an UNKNOWN, never a failure. The caller must reconcile.
      throw new AppError('RECONCILIATION_REQUIRED', 'stub: provider timed out');
    }
    return this.payments.get(providerPaymentRef)?.status ?? 'RECONCILIATION_REQUIRED';
  }

  async applySplit(input: SplitInput): Promise<SplitResult> {
    if (this.mode === 'VENDOR_DIRECT') {
      return { applied: false, reason: 'NOT_APPLICABLE' };
    }
    if (this.faults.failSplit) {
      return { applied: false, reason: 'stub: split failed' };
    }
    // Idempotent on the platform transfer id: a retry must not double-pay.
    const existing = this.splits.get(input.transferId);
    if (existing) return existing;

    const result: SplitResult = {
      applied: true,
      providerTransferIds: input.allocations.map((_, i) => `stub_trf_${input.transferId}_${i}`),
    };
    this.splits.set(input.transferId, result);
    return result;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (this.faults.failRefund) {
      return { status: 'FAILED', authority: 'AUTHORITATIVE', reason: 'stub: refund declined' };
    }
    if (this.faults.refundNeverConfirms) {
      return { status: 'PENDING', authority: 'AUTHORITATIVE' };
    }
    if (this.mode === 'VENDOR_DIRECT') {
      // The platform cannot debit the vendor's account. It records an
      // obligation and tracks it — advisory only. PRD REF-08.
      return { status: 'PENDING', authority: 'ADVISORY', reason: 'awaiting vendor' };
    }
    return {
      status: 'SUCCEEDED',
      providerRefundRef: `stub_rfnd_${input.refundId}`,
      authority: 'AUTHORITATIVE',
    };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): NormalisedPaymentEvent {
    // VERIFY BEFORE PARSE. An unsigned body is never deserialised. PRD PAY-03.
    const provided = headers['x-provider-signature'] ?? '';
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'stub: bad signature');
    }

    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    if (this.faults.emitUnknownEvent) {
      return { providerEventId: String(body['id'] ?? 'unknown'), kind: 'UNKNOWN', raw: body };
    }

    const type = String(body['type'] ?? '');
    const kind =
      type === 'payment.succeeded'
        ? 'PAYMENT_SUCCEEDED'
        : type === 'payment.failed'
          ? 'PAYMENT_FAILED'
          : type === 'refund.succeeded'
            ? 'REFUND_SUCCEEDED'
            : type === 'refund.failed'
              ? 'REFUND_FAILED'
              : type === 'transfer.settled'
                ? 'TRANSFER_SETTLED'
                : ('UNKNOWN' as const);

    const amount = body['amountPaise'];

    return {
      providerEventId: String(body['id']),
      kind,
      ...(body['paymentRef'] !== undefined
        ? { providerPaymentRef: String(body['paymentRef']) }
        : {}),
      ...(body['refundRef'] !== undefined ? { providerRefundRef: String(body['refundRef']) } : {}),
      ...(body['orderId'] !== undefined ? { orderId: String(body['orderId']) } : {}),
      ...(typeof amount === 'number' ? { amountPaise: paise(amount) } : {}),
      ...(body['timestamp'] !== undefined ? { providerTimestamp: String(body['timestamp']) } : {}),
      raw: body,
    };
  }

  async getSettlementReport(
    periodStart: string,
    periodEnd: string,
  ): Promise<SettlementReport | null> {
    if (this.faults.noSettlementReport || this.mode === 'VENDOR_DIRECT') return null;
    return {
      periodStart,
      periodEnd,
      transactions: [...this.payments.entries()]
        .filter(([, p]) => p.status === 'SUCCESS')
        .map(([reference, p]) => ({
          reference,
          amountPaise: p.amountPaise,
          feePaise: paise(0),
        })),
    };
  }

  // ---- test helpers -------------------------------------------------------

  /** Simulate the customer completing payment. */
  markPaid(providerPaymentRef: string): void {
    const p = this.payments.get(providerPaymentRef);
    if (p) p.status = 'SUCCESS';
  }

  /** Build a correctly signed webhook body, for tests. */
  signedWebhook(body: Record<string, unknown>): {
    rawBody: Buffer;
    headers: Record<string, string>;
  } {
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const signature = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return { rawBody, headers: { 'x-provider-signature': signature } };
  }
}
