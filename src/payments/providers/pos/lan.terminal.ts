/**
 * ============================================================================
 * A CARD MACHINE REACHED OVER THE INTRANET, BY HTTP
 * ============================================================================
 *
 * Every integrated terminal sold into Indian food courts — Pine Labs Plutus
 * Smart, Ezetap, Paytm EDC, Mswipe — exposes broadly this shape on the local
 * network: a small HTTP or TCP listener on the device, a JSON request naming an
 * amount and a merchant-side reference, and a JSON response carrying an
 * approval code and a retrieval reference number.
 *
 * What differs between them is field NAMES and a header or two. What does not
 * differ is the shape, the failure modes, or a single line of the logic below.
 * So the transport, the timeouts, the idempotency and the unknown-handling live
 * here once, and the vendor-specific part is confined to `toWire` and
 * `fromWire` at the bottom of this file.
 *
 * ----------------------------------------------------------------------------
 * ⚠ THE FIELD NAMES BELOW ARE A PLACEHOLDER AND MUST BE VERIFIED
 * ----------------------------------------------------------------------------
 *
 * They are written to the common shape, not to a specific vendor's document,
 * because the terminal model for this deployment has not been named yet. Two
 * methods and a URL path change when it is; nothing else in this file, this
 * directory, or this codebase does.
 *
 * Until they are verified against the real integration guide, this adapter
 * refuses to run in production — see the constructor. A terminal adapter that
 * silently posts the wrong field names would get an HTTP 200 back with an error
 * body and, read carelessly, look like a decline. That is the failure mode this
 * whole module is organised against.
 */

import { paise } from '../../../platform/money.js';
import { log } from '../../../platform/logger.js';
import type {
  ChargeRequest,
  PosTerminal,
  ReversalResult,
  ReverseRequest,
  TerminalOutcome,
  TerminalResult,
} from './terminal.port.js';

export interface LanTerminalOptions {
  /** The terminal's address on the intranet. Host and port, no scheme. */
  readonly host: string;
  readonly port: number;
  /** Identifies this till to the terminal. From the vendor's onboarding. */
  readonly terminalId: string;
  readonly merchantId: string;
  /**
   * Set once the field mapping below has been checked against the vendor's
   * integration guide. Until then this adapter will not start in production.
   */
  readonly wireFormatVerified: boolean;
  readonly nodeEnv: string;
}

/**
 * How long to wait for a human.
 *
 * ============================================================================
 * THIS IS NOT THE API'S 8-SECOND TIMEOUT AND MUST NOT BE CONFUSED WITH IT
 * ============================================================================
 *
 * `apps/pwa/src/lib/api.ts` times every browser request out at 8 seconds,
 * correctly: nobody should watch a spinner longer than that.
 *
 * A charge is a different kind of wait. The customer has to be handed the
 * machine, choose card or UPI, dip or tap, enter a PIN, and possibly retry
 * because the first tap did not read. Two minutes is not generous; it is the
 * realistic upper end of that, and cutting it short does not cancel the
 * transaction — the terminal carries on and takes the money regardless. It
 * only cancels our ability to SEE the outcome, converting a clean approval
 * into an `UNKNOWN` we then have to reconcile.
 *
 * So the timeout is long, and the counter screen is what tells the cashier that
 * something is taking a while.
 */
const CHARGE_TIMEOUT_MS = 120_000;

/** A lookup asks a question the terminal can answer from its own memory. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** A ping that has not answered in two seconds is a ping that failed. */
const PING_TIMEOUT_MS = 2_000;

export class LanTerminal implements PosTerminal {
  readonly name: string;

  private readonly base: string;
  private readonly opts: LanTerminalOptions;

  constructor(opts: LanTerminalOptions) {
    if (opts.nodeEnv === 'production' && !opts.wireFormatVerified) {
      throw new Error(
        'LanTerminal started in production with wireFormatVerified=false. The request and ' +
          'response field names in lan.terminal.ts are a placeholder written to the common ' +
          'shape, not to your terminal vendor’s integration guide. Check them against that ' +
          'guide, then set POS_TERMINAL_WIRE_VERIFIED=true. Shipping unverified means a ' +
          'malformed charge comes back as an error body inside an HTTP 200 and reads as a ' +
          'decline — a customer refused at the counter for no reason, or worse.',
      );
    }

    this.opts = opts;
    // http, not https: this is a device on a private LAN with no certificate
    // and no name in any DNS. The confidentiality that matters here is physical
    // — it is the same wire the kitchen board is on.
    this.base = `http://${opts.host}:${opts.port}`;
    this.name = `lan-terminal(${opts.host}:${opts.port})`;
  }

  async charge(req: ChargeRequest): Promise<TerminalResult> {
    const body = this.toWire(req);

    const res = await this.post('/transaction', body, CHARGE_TIMEOUT_MS, req.correlationId);

    if (res === null) {
      /*
       * ====================================================================
       * THE MOST IMPORTANT FOUR LINES IN THIS FILE
       * ====================================================================
       *
       * We asked the terminal to take money and we did not hear back. The card
       * may well have been charged. Returning DECLINED here would tell the
       * customer their payment failed while their bank tells them it did not,
       * and would leave no refund, no order, and no record that anything was
       * owed to anybody.
       *
       * UNKNOWN sends the provider down the reconciliation path, where
       * `lookup` asks the terminal what actually happened before anyone
       * concludes anything.
       */
      return { outcome: 'UNKNOWN', message: 'no response from terminal' };
    }

    return this.fromWire(res);
  }

  async lookup(reference: string): Promise<TerminalResult> {
    const res = await this.post(
      '/transaction/status',
      { merchantId: this.opts.merchantId, terminalId: this.opts.terminalId, reference },
      LOOKUP_TIMEOUT_MS,
      reference,
    );

    if (res === null) return { outcome: 'UNKNOWN', message: 'terminal did not answer lookup' };
    return this.fromWire(res);
  }

  async reverse(req: ReverseRequest): Promise<ReversalResult> {
    const res = await this.post(
      '/transaction/reverse',
      {
        merchantId: this.opts.merchantId,
        terminalId: this.opts.terminalId,
        reference: req.reference,
        reversalReference: req.reversalId,
        amount: req.amountPaise,
        ...(req.rrn !== undefined ? { rrn: req.rrn } : {}),
      },
      CHARGE_TIMEOUT_MS,
      req.correlationId,
    );

    if (res === null) {
      // Same argument as `charge`. A reversal we cannot see the end of is
      // PENDING, never FAILED — declaring it failed would start a second
      // reversal against a transaction that may already be reversed.
      return {
        status: 'PENDING',
        authority: 'ADVISORY',
        reason: 'terminal did not answer; reversal state unknown',
      };
    }

    const outcome = this.fromWire(res);

    if (outcome.outcome === 'APPROVED') {
      /*
       * VOID OR REFUND — AND WE DO NOT GET TO CHOOSE.
       *
       * The terminal decides based on whether its batch has settled, and it
       * tells us which it did. That distinction is not cosmetic: a VOID is
       * final and invisible to the customer, a REFUND is a fresh transaction
       * that on most terminals needed the card present. Reporting a settled
       * refund as AUTHORITATIVE would have the platform promise money back
       * that nobody can send. See `ReversalResult` in terminal.port.ts.
       */
      const kind = String(res['type'] ?? '').toUpperCase() === 'VOID' ? 'VOID' : 'REFUND';
      return {
        status: 'SUCCEEDED',
        kind,
        authority: kind === 'VOID' ? 'AUTHORITATIVE' : 'ADVISORY',
        ...(outcome.rrn !== undefined ? { providerRefundRef: outcome.rrn } : {}),
      };
    }

    if (outcome.outcome === 'UNKNOWN') {
      return { status: 'PENDING', authority: 'ADVISORY', reason: outcome.message ?? 'unknown' };
    }

    return {
      status: 'FAILED',
      authority: 'AUTHORITATIVE',
      reason: outcome.message ?? `terminal returned ${outcome.outcome}`,
    };
  }

  async ping(): Promise<boolean> {
    const res = await this.post(
      '/status',
      { merchantId: this.opts.merchantId, terminalId: this.opts.terminalId },
      PING_TIMEOUT_MS,
      'ping',
    );
    return res !== null;
  }

  // ---- transport ----------------------------------------------------------

  /**
   * One POST, with a timeout, returning `null` for every kind of not-hearing.
   *
   * Deliberately collapses "connection refused", "timed out" and "not JSON"
   * into the same `null`, because callers must treat all three identically:
   * they are all "we do not know", and a caller given three of them will
   * eventually branch on one and get it wrong. The DIFFERENCE between them is
   * for the log, which is where it goes.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    correlationId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        log().warn(
          { event: 'pos_terminal_http_error', status: res.status, path, correlationId },
          'terminal answered with a non-2xx status',
        );
        return null;
      }

      return (await res.json()) as Record<string, unknown>;
    } catch (cause) {
      log().warn(
        {
          event: 'pos_terminal_unreachable',
          path,
          correlationId,
          host: this.opts.host,
          port: this.opts.port,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        'no usable response from the card terminal',
      );
      return null;
    }
  }

  // ---- ⚠ vendor-specific: the only two methods that change per terminal ----

  /**
   * Our charge request in the terminal's vocabulary.
   *
   * `amount` is sent in PAISE. Check this first when adapting to a real
   * terminal — several send rupees as a decimal string, and an amount field
   * read with the wrong scale is a hundredfold error that looks like a
   * successful transaction. `src/platform/money.ts` exists so that this is the
   * only place in the codebase where the question can even be asked.
   */
  private toWire(req: ChargeRequest): Record<string, unknown> {
    return {
      merchantId: this.opts.merchantId,
      terminalId: this.opts.terminalId,
      transactionType: 'SALE',
      amount: req.amountPaise,
      /*
       * The platform reference, echoed back on the response and on the
       * settlement file. This is what makes a retry idempotent AT THE
       * TERMINAL, and it is the only field here that must not be dropped
       * during adaptation, however differently the vendor names it.
       */
      reference: req.reference,
      /* Printed on the customer's slip so it can be matched to the order. */
      printLabel: `Order ${req.orderNumber}`,
    };
  }

  /**
   * The terminal's answer in ours.
   *
   * The mapping is a lookup rather than a chain of conditionals for the same
   * reason `stub.provider.ts` gives for its event kinds: with four outcomes,
   * one of which must never be confused with another, a ternary chain is where
   * somebody eventually folds UNKNOWN into DECLINED because the indentation
   * made them look adjacent.
   *
   * Anything unrecognised falls to UNKNOWN, never to DECLINED. A terminal
   * firmware update that adds a status code must not be able to tell a
   * customer their card was refused.
   */
  private fromWire(res: Record<string, unknown>): TerminalResult {
    const OUTCOMES: Readonly<Record<string, TerminalOutcome>> = {
      APPROVED: 'APPROVED',
      SUCCESS: 'APPROVED',
      DECLINED: 'DECLINED',
      FAILED: 'DECLINED',
      CANCELLED: 'CANCELLED',
      ABORTED: 'CANCELLED',
      USER_CANCELLED: 'CANCELLED',
      TIMEOUT: 'UNKNOWN',
      IN_PROGRESS: 'UNKNOWN',
    };

    const raw = String(res['status'] ?? '').toUpperCase();
    const outcome: TerminalOutcome = OUTCOMES[raw] ?? 'UNKNOWN';

    const amount = res['amount'];

    return {
      outcome,
      ...(res['approvalCode'] !== undefined
        ? { approvalCode: String(res['approvalCode']) }
        : {}),
      ...(res['rrn'] !== undefined ? { rrn: String(res['rrn']) } : {}),
      ...(res['transactionId'] !== undefined
        ? { terminalTxnId: String(res['transactionId']) }
        : {}),
      ...(res['paymentMode'] !== undefined
        ? { instrument: String(res['paymentMode']).toUpperCase() }
        : {}),
      ...(res['cardLastFour'] !== undefined ? { cardLast4: String(res['cardLastFour']) } : {}),
      ...(typeof amount === 'number' ? { amountPaise: paise(amount) } : {}),
      ...(res['message'] !== undefined ? { message: String(res['message']) } : {}),
    };
  }
}
