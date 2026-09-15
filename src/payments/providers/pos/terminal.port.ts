/**
 * ============================================================================
 * A CARD MACHINE ON THE LAN, BEHIND ONE INTERFACE
 * ============================================================================
 *
 * This is the intranet equivalent of `StoragePort`: the thing above it does not
 * know whether the terminal is a Pine Labs Plutus, an Ezetap, a Paytm EDC, or a
 * mock in a unit test. `PosPaymentProvider` speaks this and nothing else, so
 * changing terminal vendor costs one adapter and no order code.
 *
 * ----------------------------------------------------------------------------
 * WHY A CARD MACHINE IS NOT AN AGGREGATOR, AND WHY THAT CHANGES THE SHAPE
 * ----------------------------------------------------------------------------
 *
 * Cashfree is asynchronous, remote and webhook-driven: we create an intent, the
 * customer disappears into a UPI app, and the truth arrives later over a signed
 * HTTP callback we did not initiate.
 *
 * A terminal is synchronous, local and physical. Somebody is standing in front
 * of it. We open a TCP connection to a box thirty metres away, it prints a
 * slip, and it answers on the same connection. There is no webhook because
 * there is no third party to send one, and there is no "customer redirect"
 * because the customer never left.
 *
 * The consequences that actually matter:
 *
 *   1. AUTHORIZE AND CAPTURE ARE THE SAME INSTANT. A terminal does not block
 *      funds for later collection the way a UPI mandate does. The card is
 *      swiped, the acquirer approves, the money is taken. So this port has one
 *      `charge`, not an authorise/capture pair, and the provider above reports
 *      `PAYMENT_CAPTURED` — which confirms an order under either setting of
 *      PAYMENTS_SPLIT_TIMING (see `confirmationRequires` in ../../webhook.ts).
 *
 *   2. THE TERMINAL IS THE INTERNET. This whole exercise is about a food court
 *      whose LAN has no route to the outside. The terminal has its own SIM and
 *      its own path to the acquiring bank. We are not making payment work
 *      offline — that is not a thing card payments can do — we are moving the
 *      internet dependency off our server and onto a device that already has
 *      one. Our server talks only to the intranet.
 *
 *   3. A REFUND MAY NEED THE CARD BACK. See `reverse` below. This is the single
 *      biggest behavioural difference from an aggregator and it propagates all
 *      the way up to what the customer can be promised.
 */

import type { Paise } from '../../../platform/money.js';

/**
 * What the terminal did.
 *
 * ============================================================================
 * `UNKNOWN` IS THE WHOLE REASON THIS IS AN ENUM AND NOT A BOOLEAN
 * ============================================================================
 *
 * The dangerous outcome of a card transaction is not a decline. A decline is
 * clean: no money moved, tell the customer, try another card. The dangerous
 * outcome is the one where we stop being able to see.
 *
 * The socket to the terminal drops after the card is dipped and before the
 * response comes back. The terminal is holding a live transaction with the
 * acquirer. It may complete. It may not. We cannot tell from here, and the
 * customer's phone is showing a spinner.
 *
 * Mapping that to DECLINED is how a customer is charged for an order that was
 * never placed and never refunded — the exact failure shape PRD §12.2 forbids
 * for aggregator responses, arriving through a different door. Every adapter
 * implementing this port MUST return `UNKNOWN` rather than guessing, and the
 * provider above turns `UNKNOWN` into a reconciliation item rather than a
 * verdict.
 *
 * `CANCELLED` is separated from `DECLINED` deliberately: the cashier pressing
 * the red button and the bank refusing the card are different events, one of
 * which is worth counting against a card and one of which is not.
 */
export type TerminalOutcome = 'APPROVED' | 'DECLINED' | 'CANCELLED' | 'UNKNOWN';

/**
 * What a terminal tells us about a completed transaction.
 *
 * Everything except `outcome` is optional because terminals differ wildly in
 * what they return, and a field this port insisted on would be a field some
 * adapter had to invent. An invented RRN is worse than a missing one: it looks
 * like a reconciliation handle and matches nothing in the bank's file.
 */
export interface TerminalResult {
  readonly outcome: TerminalOutcome;

  /**
   * The acquirer's approval code, printed on the customer's slip.
   *
   * This is the number a human uses to match our order against a bank
   * statement when something has gone wrong, so it is stored even though
   * nothing reads it programmatically today.
   */
  readonly approvalCode?: string;

  /**
   * Retrieval Reference Number — the acquirer's own transaction id.
   *
   * The strongest reconciliation handle available, and the one the end-of-day
   * settlement file is keyed on. Where a terminal offers it, the adapter must
   * pass it through.
   */
  readonly rrn?: string;

  /** The terminal's internal id for the transaction, for its own audit trail. */
  readonly terminalTxnId?: string;

  /** `CARD`, `UPI`, `WALLET` — whatever the terminal reports, uppercased. */
  readonly instrument?: string;

  /** Last four digits, for the slip and for support calls. Never the full PAN. */
  readonly cardLast4?: string;

  /**
   * What actually moved.
   *
   * Present only on APPROVED. Checked against the expected amount by the
   * provider, because a terminal charging the wrong figure is exactly the
   * `AMOUNT_MISMATCH` case `decideWebhookAction` already knows how to refuse.
   */
  readonly amountPaise?: Paise;

  /** The terminal's own words, for the log and for the counter's screen. */
  readonly message?: string;
}

export interface ChargeRequest {
  /**
   * A PLATFORM-generated reference, stable across retries of one charge.
   *
   * This is the idempotency key of the whole mechanism. If the network drops
   * mid-charge and the counter presses the button again, the adapter must send
   * the SAME reference so the terminal recognises a repeat rather than opening
   * a second transaction against the same customer.
   *
   * Derived from the order's `providerOrderRef`, which is issued once at
   * checkout and persisted — not generated here, where a retry would produce a
   * new one and the guarantee would evaporate.
   */
  readonly reference: string;

  readonly amountPaise: Paise;

  /** Printed on the slip so a customer can match it to their order number. */
  readonly orderNumber: string;

  readonly correlationId: string;
}

export interface ReverseRequest {
  /** The reference of the charge being undone. */
  readonly reference: string;

  /** Platform-generated, so a retried reversal is not a second refund. */
  readonly reversalId: string;

  readonly amountPaise: Paise;

  /**
   * The acquirer's handle for the original transaction, where we have one.
   *
   * Most terminals need this to reverse anything they no longer hold in their
   * open batch. Absent, an adapter is entitled to report that it cannot act.
   */
  readonly rrn?: string;

  readonly correlationId: string;
}

/**
 * How a reversal came out.
 *
 * ============================================================================
 * `authority` IS NOT DECORATION — IT DECIDES WHAT WE MAY TELL THE CUSTOMER
 * ============================================================================
 *
 * A card machine can undo a transaction two ways, and they are not
 * interchangeable:
 *
 *   VOID     the acquirer's batch for the day is still open, the transaction
 *            is pulled out of it, and nothing ever reaches the customer's
 *            statement. Instant, clean, AUTHORITATIVE.
 *
 *   REFUND   the batch has settled. This is a new transaction in the opposite
 *            direction, and on most terminals it REQUIRES THE CARD TO BE
 *            PRESENT AND DIPPED AGAIN. A customer who has walked out of the
 *            building cannot be refunded by any button we press.
 *
 * That second case is why this mirrors the ADVISORY concept from
 * `VENDOR_DIRECT` mode in ../../provider.interface.ts. The platform records an
 * obligation it cannot itself discharge, and somebody at the counter has to
 * complete it with the customer standing there.
 *
 * The escalation ladder in the dispatch worker promises an automatic refund
 * when no stall accepts an order. Under POS that promise cannot be kept
 * unattended, and the honest thing is to say so in the data rather than to
 * report a refund that did not happen. PRD §2.2: a check whose failure mode is
 * silence is not a check.
 */
export interface ReversalResult {
  readonly status: 'SUCCEEDED' | 'PENDING' | 'FAILED';

  /** VOID retracts an unsettled charge; REFUND is a fresh opposing transaction. */
  readonly kind?: 'VOID' | 'REFUND';

  readonly authority: 'AUTHORITATIVE' | 'ADVISORY';

  readonly providerRefundRef?: string;

  readonly reason?: string;
}

/**
 * One card machine, reachable over the intranet.
 *
 * Deliberately small. Everything an aggregator needs and a terminal does not —
 * split transfers, settlement reports, webhook signature verification — lives
 * in `PosPaymentProvider` above, where it can answer honestly that a card
 * machine does not do those things.
 */
export interface PosTerminal {
  /** For logs and for the counter's "which machine" display. */
  readonly name: string;

  /**
   * Take the money. Blocks until the customer has finished at the terminal.
   *
   * MUST NOT THROW for a declined card — a decline is an answer, and callers
   * branch on `outcome`. Reserve exceptions for "this adapter could not even
   * ask", and even then prefer returning `UNKNOWN`, because a thrown error
   * after the card was dipped is indistinguishable from one before it.
   */
  charge(req: ChargeRequest): Promise<TerminalResult>;

  /**
   * Ask the terminal what became of a reference it was given.
   *
   * This is the resolution path for `UNKNOWN`, and it is the reason `UNKNOWN`
   * is survivable rather than a permanent stuck order. Same role as
   * `PaymentProvider.getStatus` — PRD §9 case B, the client and the callback
   * are independent and both can lie, so ask the authority.
   *
   * Returns `UNKNOWN` for a reference the terminal has never heard of. That is
   * "I do not know", not "it failed" — see the long note on the same
   * distinction in ../stub.provider.ts `getStatus`.
   */
  lookup(reference: string): Promise<TerminalResult>;

  /** Void if the batch is open, refund if it is not. See `ReversalResult`. */
  reverse(req: ReverseRequest): Promise<ReversalResult>;

  /**
   * Is the machine there, right now?
   *
   * Called by readiness and by the counter screen before it offers a Charge
   * button. A terminal that is unplugged, asleep or on a different subnet
   * should be discovered by an operator looking at a screen, not by a customer
   * standing at the counter while nothing happens.
   */
  ping(): Promise<boolean>;
}
