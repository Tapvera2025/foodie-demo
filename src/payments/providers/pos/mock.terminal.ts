/**
 * A card machine that is not there.
 *
 * This is the `StubPaymentProvider` of terminals, and the same argument
 * applies: PRD §4.6 makes it a selection criterion that failure can be
 * simulated, and a POS integration has failure modes an aggregator does not.
 * You cannot unplug Cashfree mid-transaction. You can absolutely unplug a
 * terminal, and somebody eventually will.
 *
 * The faults below exist because each one has a different correct handling and
 * they are indistinguishable from the counter's point of view:
 *
 *   declined       the bank said no.        Customer tries another card.
 *   cancelled      the cashier pressed red. Nothing happened. Try again.
 *   vanishes       the socket died.         WE DO NOT KNOW IF MONEY MOVED.
 *
 * The third is the one worth building a test double for. It is rare, it is
 * unreproducible on demand with real hardware, and it is the only one that can
 * charge a customer for food nobody is cooking.
 */

import { randomUUID } from 'node:crypto';

import { paise, type Paise } from '../../../platform/money.js';
import type {
  ChargeRequest,
  PosTerminal,
  ReversalResult,
  ReverseRequest,
  TerminalResult,
} from './terminal.port.js';

export interface MockTerminalFaults {
  /** The bank refuses. A clean no. */
  readonly decline?: boolean;
  /** The cashier aborts at the machine. */
  readonly cancel?: boolean;
  /**
   * The socket dies after the card is dipped.
   *
   * Returns UNKNOWN and — critically — STILL RECORDS THE CHARGE INTERNALLY, so
   * a subsequent `lookup` finds an approved transaction. That is the real
   * shape: the money moved and we did not hear about it. A mock that forgot
   * the charge would make the reconciliation path look like it worked when it
   * had nothing to reconcile.
   */
  readonly vanishMidCharge?: boolean;
  /** The machine is unplugged or on another subnet. */
  readonly unreachable?: boolean;
  /** The batch has settled, so a reversal needs the card back. */
  readonly batchSettled?: boolean;
  /** Charge a different figure than asked, to exercise AMOUNT_MISMATCH. */
  readonly chargeInsteadPaise?: number;
}

interface Recorded {
  readonly amountPaise: Paise;
  readonly result: TerminalResult;
}

export class MockTerminal implements PosTerminal {
  readonly name = 'mock-terminal';

  private readonly faults: MockTerminalFaults;

  /**
   * Keyed by the platform reference, which is what makes a retry idempotent.
   *
   * In memory, and that is a real limitation rather than a shortcut: it dies
   * with the process, exactly like `StubPaymentProvider`'s map, and for the
   * same reason it must answer "I do not know" rather than inventing a verdict
   * for a reference it has forgotten. See `lookup`.
   */
  private readonly charges = new Map<string, Recorded>();
  private readonly reversals = new Map<string, ReversalResult>();

  constructor(faults: MockTerminalFaults = {}) {
    this.faults = faults;
  }

  async charge(req: ChargeRequest): Promise<TerminalResult> {
    if (this.faults.unreachable) {
      // Nothing was dipped, so this is genuinely "we could not ask" rather
      // than an ambiguity. Still UNKNOWN: the provider decides what to do with
      // not-knowing, and this adapter is not entitled to declare a decline.
      return { outcome: 'UNKNOWN', message: 'mock: terminal unreachable' };
    }

    /*
     * IDEMPOTENCY, AND WHY IT IS CHECKED BEFORE THE FAULTS.
     *
     * A retry must return what the first attempt did, including when the first
     * attempt vanished. Putting this check after the fault switches would make
     * `vanishMidCharge` fire twice and produce two charges from one reference,
     * which is precisely the bug the reference exists to prevent.
     */
    const existing = this.charges.get(req.reference);
    if (existing) return existing.result;

    if (this.faults.cancel) {
      return { outcome: 'CANCELLED', message: 'mock: cancelled at the terminal' };
    }

    if (this.faults.decline) {
      return { outcome: 'DECLINED', message: 'mock: issuer declined' };
    }

    const charged = paise(this.faults.chargeInsteadPaise ?? req.amountPaise);

    const approved: TerminalResult = {
      outcome: 'APPROVED',
      approvalCode: String(100000 + Math.floor(Math.random() * 899999)),
      rrn: randomUUID().replace(/-/g, '').slice(0, 12),
      terminalTxnId: `mock_${req.reference}`,
      instrument: 'CARD',
      cardLast4: '4242',
      amountPaise: charged,
      message: 'mock: approved',
    };

    this.charges.set(req.reference, { amountPaise: charged, result: approved });

    if (this.faults.vanishMidCharge) {
      // Recorded above, reported as unknown. The money moved; we did not hear.
      return { outcome: 'UNKNOWN', message: 'mock: connection lost after dip' };
    }

    return approved;
  }

  async lookup(reference: string): Promise<TerminalResult> {
    if (this.faults.unreachable) {
      return { outcome: 'UNKNOWN', message: 'mock: terminal unreachable' };
    }
    return (
      this.charges.get(reference)?.result ?? {
        outcome: 'UNKNOWN',
        message: `mock: no record of ${reference}`,
      }
    );
  }

  async reverse(req: ReverseRequest): Promise<ReversalResult> {
    const prior = this.reversals.get(req.reversalId);
    if (prior) return prior;

    const charge = this.charges.get(req.reference);
    if (!charge || charge.result.outcome !== 'APPROVED') {
      const result: ReversalResult = {
        status: 'FAILED',
        authority: 'AUTHORITATIVE',
        reason: 'mock: nothing approved under that reference to reverse',
      };
      this.reversals.set(req.reversalId, result);
      return result;
    }

    const result: ReversalResult = this.faults.batchSettled
      ? {
          // The honest answer once the batch is closed. Nobody can press a
          // button and make this money come back; the card has to return.
          status: 'PENDING',
          kind: 'REFUND',
          authority: 'ADVISORY',
          reason: 'mock: batch settled — refund requires the card at the terminal',
        }
      : {
          status: 'SUCCEEDED',
          kind: 'VOID',
          authority: 'AUTHORITATIVE',
          providerRefundRef: `mock_void_${req.reversalId}`,
        };

    this.reversals.set(req.reversalId, result);
    return result;
  }

  async ping(): Promise<boolean> {
    return !this.faults.unreachable;
  }

  // ---- test helpers -------------------------------------------------------

  /** Did this reference ever actually charge anybody? */
  wasCharged(reference: string): boolean {
    return this.charges.get(reference)?.result.outcome === 'APPROVED';
  }

  /** How many distinct references this terminal has taken money against. */
  get chargeCount(): number {
    return [...this.charges.values()].filter((c) => c.result.outcome === 'APPROVED').length;
  }
}
