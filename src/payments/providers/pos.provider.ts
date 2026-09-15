/**
 * ============================================================================
 * PAYMENT BY CARD MACHINE, FOR A COURT WITH NO ROUTE TO THE INTERNET
 * ============================================================================
 *
 * The deployment this exists for: API, worker, Postgres and the three frontends
 * all on one box on the food court's own LAN, phones joining the court wi-fi,
 * and nothing on that network able to reach the outside world. The card
 * terminal at the counter has its own SIM and its own path to the acquiring
 * bank, so it — not our server — is where the money leaves the building.
 *
 * ----------------------------------------------------------------------------
 * THE ONE HARD PROBLEM THIS FILE SOLVES
 * ----------------------------------------------------------------------------
 *
 * Everything downstream of payment in this codebase is driven by webhooks. An
 * order reaches PAYMENT_CONFIRMED because `ingestWebhook` received a signed
 * event, `decideWebhookAction` classified it, and one transaction moved the
 * payment and the order together (../webhook.ts, steps 1–5).
 *
 * A card terminal sends no webhooks. It answers on the socket we opened, once,
 * and then forgets we exist.
 *
 * The tempting fix is to let the POS path write order state directly. That
 * would be a second way for an order to become confirmed, bypassing the
 * duplicate-event guard, the amount check, and the reconciliation branch — all
 * of the machinery that exists because payment is where this product can hurt
 * somebody.
 *
 * So instead: the terminal's answer is normalised into exactly the event shape
 * an aggregator would have posted, signed with the same secret, and pushed
 * through the same `ingestWebhook`. `StubPaymentProvider.signedWebhook` already
 * established this pattern for the development simulate-payment route; this is
 * that pattern carrying real money. Nothing in `ordering/` learns that a card
 * machine exists.
 *
 * ----------------------------------------------------------------------------
 * WHAT A TERMINAL CANNOT DO, STATED HONESTLY
 * ----------------------------------------------------------------------------
 *
 * `applySplit`   nothing. The money lands in whichever merchant account the
 *                terminal is bound to, in one lump. Vendor settlement becomes
 *                an off-platform arrangement.
 * settlement     no report. Ledger entries are ADVISORY, as in VENDOR_DIRECT.
 * refunds        frequently ADVISORY too — see `refund`. This is the one that
 *                changes what the product may promise a customer.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { AppError } from '../../platform/errors.js';
import { log } from '../../platform/logger.js';
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
import type { PosTerminal, TerminalResult } from './pos/terminal.port.js';

export interface PosProviderOptions {
  readonly terminal: PosTerminal;
  /**
   * Signs the events this provider generates, and verifies them on the way
   * back in. The SAME secret the ingest path already uses — a second secret
   * would mean a second trust decision, and the point of routing through
   * `verifyAndParseWebhook` is that there is exactly one.
   */
  readonly secret: string;
  /**
   * Whose merchant account the terminal deposits into.
   *
   * PLATFORM_COLLECT for one terminal at a central counter, which is the usual
   * food-court arrangement. VENDOR_DIRECT if each stall has its own machine
   * bound to its own account — in which case the platform never touches the
   * money and every refund is advisory by construction.
   */
  readonly mode?: SettlementMode;
}

/**
 * What the counter needs to know after pressing Charge.
 *
 * Returned to the till screen rather than logged, because the person who has
 * to act on a decline is standing at the machine and cannot read our logs.
 */
export interface PosChargeOutcome {
  readonly outcome: TerminalResult['outcome'];
  /** Feed this to `ingestWebhook`. Absent when there is nothing to report. */
  readonly event: { rawBody: Buffer; headers: Record<string, string> } | null;
  /** What to put on the till screen, in words a cashier can act on. */
  readonly message: string;
  readonly approvalCode?: string;
  readonly rrn?: string;
}

export class PosPaymentProvider implements PaymentProvider {
  readonly name = 'pos';
  readonly mode: SettlementMode;

  private readonly terminal: PosTerminal;
  private readonly secret: string;

  constructor(opts: PosProviderOptions) {
    this.terminal = opts.terminal;
    this.secret = opts.secret;
    this.mode = opts.mode ?? 'PLATFORM_COLLECT';
  }

  /**
   * Reserve a reference. DO NOT TOUCH THE TERMINAL.
   *
   * ==========================================================================
   * WHY CREATING AN INTENT MUST NOT START A CHARGE
   * ==========================================================================
   *
   * `createIntent` runs when the customer taps Pay on their phone, wherever
   * they happen to be sitting. The card machine is at the counter and there is
   * nobody in front of it. Starting a transaction here would lock the terminal
   * against a customer who has not begun walking, and block every other
   * customer's payment while it timed out.
   *
   * So this is bookkeeping only: it mints the reference that the eventual
   * charge will be idempotent on, and returns a payload telling the phone to go
   * and pay at the counter. The physical charge is triggered by `charge()`,
   * from the till, with the customer present.
   *
   * That makes the POS flow one step longer than the UPI flow, and the step is
   * a walk rather than a redirect. `checkoutPayload` carries what the Pay
   * screen needs to say so.
   */
  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    /*
     * Unique per intent, and per process lifetime, for exactly the reason
     * `stub.provider.ts` documents at length on its `run` field: a reference
     * that repeats after a restart collides with
     * `payment_provider_ref_uq ON payment (provider, provider_payment_ref)`,
     * the transaction rolls back, and an order sits in PAYMENT_PENDING with
     * the money taken and no ticket at the stall.
     */
    const ref = `pos_${randomUUID()}`;

    return {
      providerOrderRef: ref,
      amountPaise: input.amountPaise,
      checkoutPayload: {
        provider: 'pos',
        ref,
        /*
         * The Pay screen branches on this. There is no SDK to load, no
         * redirect to follow and no deep link to open — the entire client-side
         * payment step is a sentence telling somebody where to walk.
         */
        method: 'PAY_AT_COUNTER',
      },
    };
  }

  /**
   * ==========================================================================
   * TAKE THE MONEY. CALLED FROM THE TILL, WITH THE CUSTOMER PRESENT.
   * ==========================================================================
   *
   * Not part of `PaymentProvider` — no aggregator has an equivalent, because no
   * aggregator has a physical box that somebody presses a button on. The
   * controller reaches this through the concrete type after checking the
   * provider is a POS.
   *
   * Returns a signed event rather than applying anything itself. The caller
   * feeds it to `ingestWebhook`, which is where duplicate suppression, the
   * amount check and the order transition live. This function moves money and
   * decides nothing.
   */
  async charge(input: {
    orderId: string;
    orderNumber: string;
    providerOrderRef: string;
    amountPaise: Paise;
    correlationId: string;
  }): Promise<PosChargeOutcome> {
    const result = await this.terminal.charge({
      // The reference minted at checkout, NOT a fresh one. A second press of
      // Charge after a timeout must reach the same transaction at the terminal
      // rather than open a new one against the same customer.
      reference: input.providerOrderRef,
      amountPaise: input.amountPaise,
      orderNumber: input.orderNumber,
      correlationId: input.correlationId,
    });

    return this.outcomeFrom(result, input);
  }

  /**
   * Resolve an `UNKNOWN` by asking the terminal what it actually did.
   *
   * This is the other half of the guarantee. `charge` returning UNKNOWN leaves
   * an order in PAYMENT_PENDING with a customer who may or may not have been
   * charged; this is what the till's "check again" button and the reconciler
   * both call to close that gap without anybody guessing.
   */
  async resolve(input: {
    orderId: string;
    orderNumber: string;
    providerOrderRef: string;
    amountPaise: Paise;
    correlationId: string;
  }): Promise<PosChargeOutcome> {
    const result = await this.terminal.lookup(input.providerOrderRef);
    return this.outcomeFrom(result, input);
  }

  /**
   * One place that turns a terminal answer into an event, so `charge` and
   * `resolve` cannot drift into disagreeing about what an outcome means.
   */
  private outcomeFrom(
    result: TerminalResult,
    input: { orderId: string; providerOrderRef: string; amountPaise: Paise; correlationId: string },
  ): PosChargeOutcome {
    const paymentRef = result.rrn ?? input.providerOrderRef;

    if (result.outcome === 'APPROVED') {
      /*
       * PAYMENT_CAPTURED, not PAYMENT_AUTHORIZED, and the difference is real.
       *
       * A terminal does not block funds for later collection — the acquirer
       * approves and the money is taken in the same instant. Reporting an
       * authorisation would claim an interval that does not exist, and under
       * PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED the worker would later try to
       * capture money that is already captured.
       *
       * CAPTURED confirms the order under either timing — see `confirms` in
       * `decideWebhookAction`.
       */
      return {
        outcome: 'APPROVED',
        event: this.signedEvent({
          type: 'payment.captured',
          orderId: input.orderId,
          paymentRef,
          // Passed through from the terminal rather than echoed from our
          // request, so that a machine which charged the wrong figure is
          // caught by the AMOUNT_MISMATCH branch instead of being rubber
          // stamped with the amount we hoped for.
          amountPaise: result.amountPaise ?? input.amountPaise,
        }),
        message: `Approved${result.cardLast4 ? ` · card ending ${result.cardLast4}` : ''}`,
        ...(result.approvalCode !== undefined ? { approvalCode: result.approvalCode } : {}),
        ...(result.rrn !== undefined ? { rrn: result.rrn } : {}),
      };
    }

    if (result.outcome === 'DECLINED') {
      return {
        outcome: 'DECLINED',
        event: this.signedEvent({
          type: 'payment.failed',
          orderId: input.orderId,
          paymentRef,
        }),
        message: result.message ?? 'Card declined. Ask for another card.',
      };
    }

    if (result.outcome === 'CANCELLED') {
      /*
       * CANCELLED EMITS NOTHING, AND THAT IS DELIBERATE.
       *
       * The cashier pressed the red button. No money moved and no attempt was
       * made. Emitting `payment.failed` would drive the order to
       * PAYMENT_FAILED — a terminal state under this state machine — and the
       * customer standing at the counter with their card out would have to
       * place their order again from the beginning.
       *
       * Nothing happened, so nothing is recorded, and the Charge button stays
       * live for the retry that is about to occur.
       */
      return {
        outcome: 'CANCELLED',
        event: null,
        message: 'Cancelled at the machine. Nothing was charged — press Charge to retry.',
      };
    }

    /*
     * ======================================================================
     * UNKNOWN. THE CUSTOMER MAY HAVE BEEN CHARGED AND WE CANNOT SEE.
     * ======================================================================
     *
     * No event, because we have nothing to assert. Not `payment.failed`,
     * which would leave a charged customer with a failed order and no refund
     * — the "charged, no order" case PRD §12.2 names as the worst outcome
     * available, and which `decideWebhookAction` refuses to produce from an
     * ambiguous aggregator event. A card machine gets the same refusal.
     *
     * The order stays in PAYMENT_PENDING, which is the truthful state: we
     * asked for money and do not know what happened. `resolve` is how it
     * leaves, and the till screen tells the cashier to use it rather than
     * charging again.
     */
    log().warn(
      {
        event: 'pos_charge_ambiguous',
        orderId: input.orderId,
        reference: input.providerOrderRef,
        correlationId: input.correlationId,
        terminalMessage: result.message,
      },
      'the terminal did not report an outcome — the customer may have been charged',
    );

    return {
      outcome: 'UNKNOWN',
      event: null,
      message:
        'The machine did not answer. DO NOT charge again — press Check status to find out ' +
        'whether the customer was charged.',
    };
  }

  /**
   * Ask the terminal, not our own memory.
   *
   * `refreshFromProvider` writes whatever this returns onto the payment row, so
   * an ambiguity returned as a status becomes a stored verdict. It must throw
   * instead — the same argument, and the same bug, as `stub.provider.ts`
   * `getStatus`, which turned healthy PENDING payments terminal after a
   * restart.
   */
  async getStatus(providerPaymentRef: string): Promise<PaymentStatus> {
    const result = await this.terminal.lookup(providerPaymentRef);

    switch (result.outcome) {
      case 'APPROVED':
        return 'CAPTURED';
      case 'DECLINED':
        return 'FAILED';
      case 'CANCELLED':
        // Nothing was attempted, so the payment is still open for a retry.
        return 'PENDING';
      case 'UNKNOWN':
        throw new AppError(
          'RECONCILIATION_REQUIRED',
          `pos: the terminal has no answer for ${providerPaymentRef}`,
        );
    }
  }

  /**
   * A no-op that reports success, and the comment is why that is correct here.
   *
   * Under PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED the worker captures when the
   * kitchen accepts. With a card terminal the money was taken at the counter
   * minutes earlier — capture and authorisation are the same instant, as
   * `charge` explains. There is nothing left to collect.
   *
   * Returning FAILED because "we did not do anything" would mark real,
   * collected money as uncapturable and send a paid order to reconciliation.
   * Returning CAPTURED is not a polite fiction: the money genuinely is
   * captured, which is the question being asked.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    return {
      status: 'CAPTURED',
      capturedPaise: input.amountPaise,
      // The terminal knows its MDR and does not tell us over this interface.
      // Zero is a placeholder that the settlement file corrects, and the
      // ledger entry is ADVISORY anyway — see `getSettlementReport`.
      providerFeePaise: paise(0),
    };
  }

  /**
   * A card machine has no concept of a split.
   *
   * The money is in the merchant account bound to the terminal, undivided.
   * Whatever the vendor is owed is settled off-platform, by arrangement between
   * the operator and the stall.
   *
   * `applied: false` with a reason, rather than `true`, because the ledger
   * reads this to decide whether a transfer exists. Claiming a split that never
   * happened would make the books describe money in accounts it is not in.
   */
  async applySplit(_input: SplitInput): Promise<SplitResult> {
    return {
      applied: false,
      reason: 'NOT_APPLICABLE_POS: a card terminal settles in one lump to one merchant account',
    };
  }

  /**
   * ==========================================================================
   * THE PROMISE THIS PRODUCT CAN NO LONGER KEEP UNATTENDED
   * ==========================================================================
   *
   * The dispatch escalation ladder refunds a customer automatically when no
   * stall accepts their order within 180 seconds, and the rejection copy in
   * `notify/channel.ts` says so in as many words: "Your refund is on its way."
   *
   * On a card terminal that is only sometimes true. If the acquirer's batch is
   * still open the transaction can be voided outright and nobody is ever
   * debited. Once the batch has settled, a refund is a fresh transaction that
   * on most terminals REQUIRES THE CARD TO BE PRESENT — and the customer left
   * the building an hour ago.
   *
   * So this reports the terminal's own verdict, `authority` and all, and never
   * upgrades a PENDING advisory reversal into a SUCCEEDED one. An operator has
   * to close those with the customer in front of them. The alternative is a
   * platform that reports a 100% refund rate and a queue of people who were
   * never paid back — PRD §2.2, a failure whose signature is silence.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const result = await this.terminal.reverse({
      reference: input.providerPaymentRef,
      reversalId: input.refundId,
      amountPaise: input.amountPaise,
      correlationId: input.refundId,
    });

    if (result.status === 'FAILED') {
      return {
        status: 'FAILED',
        authority: result.authority,
        reason: result.reason ?? 'pos: the terminal refused the reversal',
      };
    }

    return {
      status: result.status,
      authority: result.authority,
      ...(result.providerRefundRef !== undefined
        ? { providerRefundRef: result.providerRefundRef }
        : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }

  /**
   * Verify the signature before parsing, exactly as an aggregator's would.
   *
   * ==========================================================================
   * WHY SIGN AND VERIFY OUR OWN EVENTS
   * ==========================================================================
   *
   * These events are generated in this process and consumed in this process.
   * The signature protects against nobody — there is no third party and no
   * public webhook route open to a terminal on the LAN.
   *
   * It is here so that there is ONE ingest path. `payments.ingestWebhook`
   * verifies, claims the event id against `processed_event`, classifies, and
   * applies inside a transaction. A POS-shaped bypass would need its own copy
   * of the duplicate guard and the amount check — and PRD §2.2's whole list of
   * defects is guards that existed in one path and not the other.
   *
   * The cost is an HMAC over a small buffer. The benefit is that the sentence
   * "an order can only become confirmed through `decideWebhookAction`" stays
   * true with a card machine in the building.
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): NormalisedPaymentEvent {
    const provided = headers['x-provider-signature'] ?? '';
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'pos: bad signature');
    }

    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    // A terminal produces three of these and never the rest. The map is still
    // exhaustive over what we emit, so an event kind added later fails into
    // UNKNOWN — which reconciles — rather than into a wrong branch.
    const KINDS: Readonly<Record<string, NormalisedEventKind>> = {
      'payment.captured': 'PAYMENT_CAPTURED',
      'payment.failed': 'PAYMENT_FAILED',
      'refund.succeeded': 'REFUND_SUCCEEDED',
      'refund.failed': 'REFUND_FAILED',
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

  /**
   * Null, and the ledger is right to become ADVISORY because of it.
   *
   * The terminal settles into a bank account on its own schedule and tells us
   * nothing. The authoritative record is the acquirer's end-of-day file, which
   * arrives by email or an SFTP drop and is a reconciliation job somebody runs,
   * not an API this process can call — least of all from a LAN with no
   * internet.
   *
   * `getSettlementReport` returning null is the interface's existing way of
   * saying exactly that (see the field note in ../provider.interface.ts), so
   * POS needs no new concept. It needs to stop pretending.
   */
  async getSettlementReport(): Promise<SettlementReport | null> {
    return null;
  }

  /** Is the machine reachable? For readiness and for the till screen. */
  async terminalReachable(): Promise<boolean> {
    return this.terminal.ping();
  }

  // ---- event construction -------------------------------------------------

  /**
   * Build a signed event in the shape `ingestWebhook` already accepts.
   *
   * The event id is a fresh UUID per emission rather than derived from the
   * order, and that is load-bearing in both directions:
   *
   *   - `processed_event` has a unique constraint on it, so a DERIVED id would
   *     make a legitimate second event about the same order — a refund after a
   *     capture — silently drop as a duplicate.
   *   - a random id means a genuine double-emission is NOT caught here. It is
   *     caught downstream by `orderAlreadyConfirmed`, which returns
   *     PAYMENT_ONLY and leaves the order where it is. That is the correct
   *     layer for it: the question "has this order already been paid for" is
   *     about the order, not about the message.
   */
  private signedEvent(fields: {
    type: string;
    orderId: string;
    paymentRef: string;
    amountPaise?: Paise;
  }): { rawBody: Buffer; headers: Record<string, string> } {
    const body = {
      id: `pos_evt_${randomUUID()}`,
      type: fields.type,
      orderId: fields.orderId,
      paymentRef: fields.paymentRef,
      ...(fields.amountPaise !== undefined ? { amountPaise: fields.amountPaise } : {}),
      timestamp: new Date().toISOString(),
    };

    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const signature = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return { rawBody, headers: { 'x-provider-signature': signature } };
  }
}
