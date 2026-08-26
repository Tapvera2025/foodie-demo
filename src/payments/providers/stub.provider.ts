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

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../platform/errors.js';
import { paise, type Paise } from '../../platform/money.js';
import type { SettlementMode } from '../../pricing/fee-engine.js';
import type {
  CaptureInput,
  CaptureResult,
  CreateIntentInput,
  NormalisedEventKind,
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
  /** Capture is declined after a successful authorisation — the block lapsed. */
  readonly failCapture?: boolean;
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
  capturedPaise: Paise;
}

export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  readonly mode: SettlementMode;

  private readonly secret: string;
  private readonly faults: StubFaults;
  private readonly payments = new Map<string, Recorded>();
  private readonly splits = new Map<string, SplitResult>();

  /**
   * A per-process prefix, so references never repeat across a restart.
   *
   * ==========================================================================
   * THIS IS THE FIX FOR "PAYMENT TAKEN, THE STALL WAS NEVER TOLD"
   * ==========================================================================
   *
   * The reference used to be `stub_pay_${++this.seq}` with `seq` starting at 0.
   * In memory. `tsx --watch` restarts the API on every file save, so the
   * counter restarted too, and the second life of the process handed out
   * `stub_pay_1` all over again — a string an earlier order's payment row was
   * already holding.
   *
   * What that produced, end to end:
   *
   *   1. order A takes stub_pay_1, pays, and stores it in provider_payment_ref
   *   2. a file is saved; the API restarts; seq is 0 again
   *   3. order B is issued stub_pay_1 as its provider_ORDER_ref — nothing
   *      complains, because that column carries no unique index
   *   4. order B pays. `applyPaymentState` copies the ref into
   *      provider_payment_REF, which does have one:
   *      `payment_provider_ref_uq ON payment (provider, provider_payment_ref)`
   *   5. 23505. The whole transaction rolls back, so the order never leaves
   *      PAYMENT_PENDING
   *   6. the payment screen polls, `refreshFromProvider` asks the stub, the
   *      stub says AUTHORIZED — it is holding order B's state in memory quite
   *      correctly — and that gets written to the payment row ALONE, because
   *      the poll deliberately never moves the order
   *
   * Money secured, no ticket at the stall, and every diagnosis pointing at the
   * webhook engine, which was behaving perfectly throughout. The bug was three
   * layers away in a test double, and it only fired after a restart, which is
   * why it looked intermittent and unreproducible.
   *
   * The comment on `getStatus` below already describes a SIBLING of this bug —
   * an unknown reference after a restart. That one was found and fixed; this
   * one is the same in-memory state failing in the opposite direction, and it
   * survived because a repeated reference is not a missing reference and
   * nothing was looking for it.
   *
   * `randomUUID` rather than a bigger counter or a timestamp: the property that
   * matters is uniqueness across process lifetimes, and only a random source
   * gives that without coordination. A timestamp collides when two instances
   * start in the same millisecond, which is exactly what a restart loop does.
   */
  private readonly run = randomUUID().slice(0, 8);
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
    // The sequence still appears, because a readable ordering in a log is worth
    // keeping. The RUN prefix is what makes it unique. See the note on `run`.
    const ref = `stub_pay_${this.run}_${++this.seq}`;
    this.payments.set(ref, {
      orderId: input.orderId,
      amountPaise: input.amountPaise,
      status: 'PENDING',
      capturedPaise: paise(0),
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

    const known = this.payments.get(providerPaymentRef);

    /**
     * A REFERENCE WE DO NOT RECOGNISE IS "I DO NOT KNOW", NOT A VERDICT.
     *
     * This used to `?? 'RECONCILIATION_REQUIRED'`, returning an ambiguity as
     * though it were an observation. `refreshFromProvider` believes whatever
     * this returns and WRITES it to the payment row, so one poll turned a
     * healthy PENDING payment into a terminal state nobody asked for.
     *
     * That happened routinely, because this map is in memory and `npm run dev`
     * restarts the API on every file save. The sequence was: create an intent,
     * save a file, tap Pay — and the order was stuck in PAYMENT_PENDING for
     * ever, with no ticket at the stall and no error anywhere.
     *
     * Throwing routes into the caller's existing "a provider timeout is UNKNOWN,
     * never a failure" branch, which leaves the stored status alone. It is the
     * same distinction PRD §15 draws: the provider is the authority on money
     * moved, and a provider that has never heard of a reference has not
     * asserted anything about it.
     */
    if (!known) {
      throw new AppError(
        'RECONCILIATION_REQUIRED',
        `stub: unknown payment reference ${providerPaymentRef} — in-memory state does not survive a restart`,
      );
    }

    return known.status;
  }

  /**
   * Idempotent on the payment reference, not on a caller-supplied key.
   *
   * A capture is retried precisely when the first attempt timed out, which is
   * the case where the platform does not know whether money moved. Re-running
   * it must be free. Returning the recorded result rather than calling again is
   * the only version of that which is true.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    let p = this.payments.get(input.providerPaymentRef);

    /**
     * A capture request carries enough to reconstruct the record it names.
     *
     * `getStatus` answers "I do not know" for a reference it has forgotten,
     * because the question is open and inventing an answer poisons a payment
     * row. A capture is not an open question: the only way a caller reaches
     * here is holding a `payment` row this provider issued, already AUTHORIZED,
     * for a stated amount. So the stub adopts it rather than reporting a
     * decline it has no basis for.
     *
     * This matters because the API and the worker are separate processes with
     * separate copies of this map. The worker captures on acknowledgement and
     * has never seen a reference the API handed out. Returning FAILED there
     * would mark real money uncapturable on the strength of a process boundary.
     *
     * A real provider answers from its own ledger and the platform reconciles
     * on disagreement. This is a property of the stub, not of the interface.
     */
    if (!p) {
      p = {
        orderId: input.orderId,
        amountPaise: input.amountPaise,
        status: 'AUTHORIZED',
        capturedPaise: paise(0),
      };
      this.payments.set(input.providerPaymentRef, p);
    }

    if (p.status === 'CAPTURED') {
      return { status: 'CAPTURED', capturedPaise: p.capturedPaise, providerFeePaise: paise(0) };
    }
    if (p.status === 'EXPIRED') {
      return { status: 'EXPIRED', reason: 'stub: authorisation lapsed before capture' };
    }
    if (p.status !== 'AUTHORIZED') {
      return { status: 'FAILED', reason: `stub: cannot capture from ${p.status}` };
    }
    if (this.faults.failCapture) {
      p.status = 'EXPIRED';
      return { status: 'EXPIRED', reason: 'stub: capture declined, block released' };
    }

    p.status = 'CAPTURED';
    p.capturedPaise = input.amountPaise;
    return { status: 'CAPTURED', capturedPaise: input.amountPaise, providerFeePaise: paise(0) };
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

    // Deliberately a lookup, not a ternary chain. Under authorise-then-capture
    // there are two distinct money events plus an expiry, and a chain that deep
    // is where someone eventually folds "authorized" into "captured" because
    // the indentation made them look adjacent.
    const KINDS: Readonly<Record<string, NormalisedEventKind>> = {
      'payment.authorized': 'PAYMENT_AUTHORIZED',
      'payment.captured': 'PAYMENT_CAPTURED',
      'payment.failed': 'PAYMENT_FAILED',
      'payment.expired': 'PAYMENT_EXPIRED',
      'refund.succeeded': 'REFUND_SUCCEEDED',
      'refund.failed': 'REFUND_FAILED',
      'transfer.settled': 'TRANSFER_SETTLED',
    };

    const kind: NormalisedEventKind = KINDS[String(body['type'] ?? '')] ?? 'UNKNOWN';

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
      // Only CAPTURED. An authorised payment is money we could take, not money
      // we took, and a settlement report that counts it is a report of income
      // that does not exist yet.
      transactions: [...this.payments.entries()]
        .filter(([, p]) => p.status === 'CAPTURED')
        .map(([reference, p]) => ({
          reference,
          amountPaise: p.amountPaise,
          feePaise: paise(0),
        })),
    };
  }

  // ---- test helpers -------------------------------------------------------

  /**
   * Simulate the customer completing the payment step: funds blocked, not
   * taken. There is deliberately no `markPaid` — "paid" is the ambiguity this
   * whole split exists to remove, and a helper named that would reintroduce it
   * in every test that used it.
   */
  markAuthorized(
    providerPaymentRef: string,
    /**
     * Re-adopt a reference this process has forgotten.
     *
     * The durable record of a payment is the `payment` row; this map is a
     * convenience that dies with the process. Without this, a restart between
     * "create intent" and "pay" left the stub silently no-opping — the webhook
     * still fired and the order still advanced, but `getStatus` and `capture`
     * then disagreed with it, and capture-on-acknowledgement failed.
     */
    readopt?: { orderId: string; amountPaise: Paise },
  ): void {
    const p = this.payments.get(providerPaymentRef);
    if (p) {
      p.status = 'AUTHORIZED';
      return;
    }
    if (readopt) {
      this.payments.set(providerPaymentRef, {
        orderId: readopt.orderId,
        amountPaise: readopt.amountPaise,
        status: 'AUTHORIZED',
        capturedPaise: paise(0),
      });
    }
  }

  /** Simulate the authorisation window lapsing with no capture. */
  markExpired(providerPaymentRef: string): void {
    const p = this.payments.get(providerPaymentRef);
    if (p) p.status = 'EXPIRED';
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
