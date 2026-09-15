/**
 * The POS provider, and mostly one question: what happens when the card machine
 * does not answer.
 *
 * The ordinary paths — approved, declined — are tested because they should be.
 * The ambiguous ones are tested because they are the reason this provider is
 * shaped the way it is, and because they cannot be reproduced on demand with
 * real hardware. `MockTerminal.vanishMidCharge` is the only way anyone gets to
 * see the "customer charged, we never heard" case before a customer does.
 */

import { describe, it, expect } from 'vitest';

import { paise } from '../../platform/money.js';
import { AppError } from '../../platform/errors.js';
import { decideWebhookAction } from '../webhook.js';
import { PosPaymentProvider } from './pos.provider.js';
import { MockTerminal, type MockTerminalFaults } from './pos/mock.terminal.js';

const AMOUNT = paise(26_840);
const SECRET = 'pos-test-secret';

function build(faults: MockTerminalFaults = {}) {
  const terminal = new MockTerminal(faults);
  const provider = new PosPaymentProvider({ terminal, secret: SECRET });
  return { terminal, provider };
}

const chargeInput = {
  orderId: 'order-1',
  orderNumber: 'A-042',
  providerOrderRef: 'pos_ref_1',
  amountPaise: AMOUNT,
  correlationId: 'corr-1',
};

/** Round-trip an emitted event back through the provider, as ingest would. */
function parse(provider: PosPaymentProvider, event: { rawBody: Buffer; headers: Record<string, string> }) {
  return provider.verifyAndParseWebhook(event.rawBody, event.headers);
}

describe('creating an intent does not touch the terminal', () => {
  it('mints a reference and charges nobody', async () => {
    const { terminal, provider } = build();

    await provider.createIntent({
      orderId: 'order-1',
      vendorId: 'vendor-1',
      amountPaise: AMOUNT,
      correlationId: 'corr-1',
    });

    // The customer is still at their table. Locking the machine here would
    // block every other customer's payment behind one who has not moved.
    expect(terminal.chargeCount).toBe(0);
  });

  it('tells the client to send the customer to the counter', async () => {
    const { provider } = build();
    const intent = await provider.createIntent({
      orderId: 'order-1',
      vendorId: 'vendor-1',
      amountPaise: AMOUNT,
      correlationId: 'corr-1',
    });

    expect(intent.checkoutPayload['method']).toBe('PAY_AT_COUNTER');
    expect(intent.amountPaise).toBe(AMOUNT);
  });

  it('never repeats a reference across intents', async () => {
    const { provider } = build();
    const mk = () =>
      provider.createIntent({
        orderId: 'order-1',
        vendorId: 'vendor-1',
        amountPaise: AMOUNT,
        correlationId: 'corr-1',
      });

    const [a, b] = await Promise.all([mk(), mk()]);
    // A repeated reference collides with payment_provider_ref_uq and rolls back
    // the confirming transaction — money taken, no ticket at the stall. See the
    // long note on `run` in stub.provider.ts, which is the same bug.
    expect(a.providerOrderRef).not.toBe(b.providerOrderRef);
  });
});

describe('an approved charge confirms the order through the normal ingest path', () => {
  it('emits a captured event carrying the order and the amount', async () => {
    const { provider } = build();
    const outcome = await provider.charge(chargeInput);

    expect(outcome.outcome).toBe('APPROVED');
    expect(outcome.event).not.toBeNull();

    const parsed = parse(provider, outcome.event!);
    expect(parsed.kind).toBe('PAYMENT_CAPTURED');
    expect(parsed.orderId).toBe('order-1');
    expect(parsed.amountPaise).toBe(AMOUNT);
  });

  it('is CAPTURED and not AUTHORIZED, so it confirms under either split timing', async () => {
    const { provider } = build();
    const outcome = await provider.charge(chargeInput);
    const parsed = parse(provider, outcome.event!);

    for (const splitTiming of ['ON_CAPTURE', 'ON_ACKNOWLEDGED'] as const) {
      const action = decideWebhookAction(parsed, {
        alreadyProcessed: false,
        orderExists: true,
        expectedAmountPaise: AMOUNT,
        splitTiming,
      });
      expect(action.kind).toBe('APPLY');
      if (action.kind === 'APPLY') {
        expect(action.command).toBe('confirmPayment');
        expect(action.enqueueDispatch).toBe(true);
      }
    }
  });

  it('reports the terminal amount, so a machine charging the wrong figure is caught', async () => {
    // Not echoing back what we asked for is the whole point: the mismatch has
    // to be visible to decideWebhookAction, which already knows how to refuse.
    const { provider } = build({ chargeInsteadPaise: 99_900 });
    const outcome = await provider.charge(chargeInput);
    const parsed = parse(provider, outcome.event!);

    const action = decideWebhookAction(parsed, {
      alreadyProcessed: false,
      orderExists: true,
      expectedAmountPaise: AMOUNT,
      splitTiming: 'ON_ACKNOWLEDGED',
    });

    expect(action.kind).toBe('RECONCILE');
    if (action.kind === 'RECONCILE') expect(action.reason).toBe('AMOUNT_MISMATCH');
  });
});

describe('a decline is a clean answer', () => {
  it('emits a failed event', async () => {
    const { provider } = build({ decline: true });
    const outcome = await provider.charge(chargeInput);

    expect(outcome.outcome).toBe('DECLINED');
    expect(parse(provider, outcome.event!).kind).toBe('PAYMENT_FAILED');
  });
});

describe('cancelling at the machine records nothing', () => {
  it('emits no event, so the order stays payable', async () => {
    const { terminal, provider } = build({ cancel: true });
    const outcome = await provider.charge(chargeInput);

    expect(outcome.outcome).toBe('CANCELLED');
    // PAYMENT_FAILED is terminal in this state machine. Emitting one here would
    // make the customer standing at the counter re-place their whole order
    // because a cashier pressed the wrong button.
    expect(outcome.event).toBeNull();
    expect(terminal.wasCharged(chargeInput.providerOrderRef)).toBe(false);
  });
});

describe('THE AMBIGUOUS CHARGE — the case this provider exists for', () => {
  it('does not emit a failure when the terminal goes silent', async () => {
    const { provider } = build({ vanishMidCharge: true });
    const outcome = await provider.charge(chargeInput);

    expect(outcome.outcome).toBe('UNKNOWN');
    // The customer may have been charged. A payment.failed here leaves them
    // debited, with no order and no refund — PRD §12.2's worst case, reached
    // through a card machine instead of a webhook.
    expect(outcome.event).toBeNull();
  });

  it('tells the cashier not to charge again', async () => {
    const { provider } = build({ vanishMidCharge: true });
    const outcome = await provider.charge(chargeInput);
    expect(outcome.message).toMatch(/DO NOT charge again/);
  });

  it('resolves to an approval once the terminal is asked directly', async () => {
    // The money did move. The socket died before we heard about it, which is
    // exactly what makes this survivable rather than a permanently stuck order.
    const { terminal, provider } = build({ vanishMidCharge: true });

    await provider.charge(chargeInput);
    expect(terminal.wasCharged(chargeInput.providerOrderRef)).toBe(true);

    const resolved = await provider.resolve(chargeInput);
    expect(resolved.outcome).toBe('APPROVED');
    expect(parse(provider, resolved.event!).kind).toBe('PAYMENT_CAPTURED');
  });

  it('charges exactly once when the counter presses the button twice', async () => {
    const { terminal, provider } = build({ vanishMidCharge: true });

    await provider.charge(chargeInput);
    await provider.charge(chargeInput);

    // The reference is minted at checkout and reused, so the terminal
    // recognises the repeat. A fresh reference per attempt would have debited
    // this customer twice for one plate of food.
    expect(terminal.chargeCount).toBe(1);
  });

  it('refuses to turn an unknown status into a verdict', async () => {
    const { provider } = build({ unreachable: true });
    // refreshFromProvider writes whatever getStatus returns onto the payment
    // row. Returning a status here would make an ambiguity durable.
    await expect(provider.getStatus('pos_ref_1')).rejects.toThrow(AppError);
  });
});

describe('what a card machine cannot do, reported honestly', () => {
  it('applies no split', async () => {
    const { provider } = build();
    const result = await provider.applySplit({
      orderId: 'order-1',
      transferId: 'trf-1',
      totalPaise: AMOUNT,
      allocations: [],
    });

    // Claiming a split that never happened would make the ledger describe
    // money sitting in accounts it is not in.
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/NOT_APPLICABLE_POS/);
  });

  it('produces no settlement report, so ledger entries stay advisory', async () => {
    const { provider } = build();
    expect(await provider.getSettlementReport()).toBeNull();
  });

  it('voids an unsettled charge authoritatively', async () => {
    const { provider } = build();
    await provider.charge(chargeInput);

    const refund = await provider.refund({
      refundId: 'rfnd-1',
      orderId: 'order-1',
      providerPaymentRef: chargeInput.providerOrderRef,
      amountPaise: AMOUNT,
      reason: 'stall never accepted',
      reverseVendorTransfer: false,
    });

    expect(refund.status).toBe('SUCCEEDED');
    expect(refund.authority).toBe('AUTHORITATIVE');
  });

  it('reports a settled-batch refund as ADVISORY rather than done', async () => {
    const { provider } = build({ batchSettled: true });
    await provider.charge(chargeInput);

    const refund = await provider.refund({
      refundId: 'rfnd-1',
      orderId: 'order-1',
      providerPaymentRef: chargeInput.providerOrderRef,
      amountPaise: AMOUNT,
      reason: 'stall never accepted',
      reverseVendorTransfer: false,
    });

    // The escalation ladder promises "your refund is on its way". Once the
    // batch has settled, most terminals need the card back to send it — so the
    // platform records an obligation a human must discharge, rather than a
    // refund rate that lies.
    expect(refund.status).toBe('PENDING');
    expect(refund.authority).toBe('ADVISORY');
  });
});

describe('events re-enter through the one ingest door', () => {
  it('refuses an unsigned body', async () => {
    const { provider } = build();
    const outcome = await provider.charge(chargeInput);
    expect(() => provider.verifyAndParseWebhook(outcome.event!.rawBody, {})).toThrow(AppError);
  });

  it('refuses a body tampered with after signing', async () => {
    const { provider } = build();
    const outcome = await provider.charge(chargeInput);
    const tampered = Buffer.from(
      outcome.event!.rawBody.toString('utf8').replace('26840', '1'),
      'utf8',
    );
    expect(() => provider.verifyAndParseWebhook(tampered, outcome.event!.headers)).toThrow(
      AppError,
    );
  });

  it('gives every emission a distinct id, so a later refund is not read as a duplicate', async () => {
    const { provider } = build();
    const a = await provider.charge(chargeInput);
    const b = await provider.resolve(chargeInput);

    expect(parse(provider, a.event!).providerEventId).not.toBe(
      parse(provider, b.event!).providerEventId,
    );
  });
});
