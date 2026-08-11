import { describe, it, expect } from 'vitest';
import { decideWebhookAction, httpStatusFor } from './webhook.js';
import { StubPaymentProvider } from './providers/stub.provider.js';
import type { NormalisedPaymentEvent } from './provider.interface.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';

function event(over: Partial<NormalisedPaymentEvent> = {}): NormalisedPaymentEvent {
  return {
    providerEventId: 'evt_1',
    kind: 'PAYMENT_SUCCEEDED',
    orderId: 'order-1',
    providerPaymentRef: 'pay_1',
    amountPaise: paise(26_840),
    raw: {},
    ...over,
  };
}

describe('signature verification happens before parsing (PAY-03)', () => {
  it('rejects an unsigned body without deserialising it', () => {
    const p = new StubPaymentProvider();
    const rawBody = Buffer.from('{"id":"evt_1","type":"payment.succeeded"}', 'utf8');
    expect(() => p.verifyAndParseWebhook(rawBody, {})).toThrow(AppError);
  });

  it('rejects a body that was tampered with after signing', () => {
    const p = new StubPaymentProvider();
    const { headers } = p.signedWebhook({ id: 'evt_1', type: 'payment.succeeded' });
    const tampered = Buffer.from('{"id":"evt_1","type":"payment.failed"}', 'utf8');
    expect(() => p.verifyAndParseWebhook(tampered, headers)).toThrow(AppError);
  });

  it('accepts a correctly signed body', () => {
    const p = new StubPaymentProvider();
    const { rawBody, headers } = p.signedWebhook({
      id: 'evt_1',
      type: 'payment.succeeded',
      orderId: 'order-1',
      amountPaise: 26_840,
    });
    const parsed = p.verifyAndParseWebhook(rawBody, headers);
    expect(parsed.kind).toBe('PAYMENT_SUCCEEDED');
    expect(parsed.orderId).toBe('order-1');
    expect(parsed.amountPaise).toBe(26_840);
  });

  it('throws a signature error whose status is 401, not 400', () => {
    const p = new StubPaymentProvider();
    try {
      p.verifyAndParseWebhook(Buffer.from('{}'), { 'x-provider-signature': 'nonsense' });
    } catch (e) {
      expect((e as AppError).code).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect((e as AppError).httpStatus).toBe(401);
    }
  });
});

describe('duplicate delivery', () => {
  it('is dropped, not reprocessed', () => {
    const action = decideWebhookAction(event(), { alreadyProcessed: true });
    expect(action.kind).toBe('DROP_DUPLICATE');
  });

  it('is acknowledged with 200 so the provider stops retrying', () => {
    const action = decideWebhookAction(event(), { alreadyProcessed: true });
    expect(httpStatusFor(action)).toBe(200);
  });

  it('takes priority over every other consideration', () => {
    // Even an unknown event, if already seen, is simply dropped.
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { alreadyProcessed: true });
    expect(action.kind).toBe('DROP_DUPLICATE');
  });
});

describe('ambiguity is never failure (PRD §12.2)', () => {
  it('an unrecognised event opens reconciliation rather than failing the payment', () => {
    // Mapping UNKNOWN to FAILED is how a paid customer ends up with no order
    // and no refund. This is the single most important branch in the file.
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { alreadyProcessed: false });
    expect(action.kind).toBe('RECONCILE');
    expect(action.kind === 'RECONCILE' && action.reason).toBe('UNRECOGNISED_EVENT');
  });

  it('never emits a failPayment command for an unknown event', () => {
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { alreadyProcessed: false });
    expect(action.kind).not.toBe('APPLY');
  });

  it('a payment we cannot attribute to an order opens reconciliation', () => {
    // "Customer charged, no order" — PRD §28.4, the most dangerous case.
    const { orderId: _omitted, ...noOrder } = event();
    const action = decideWebhookAction(noOrder as NormalisedPaymentEvent, {
      alreadyProcessed: false,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('NO_ORDER_REFERENCE');
  });

  it('a payment for an order we do not have opens reconciliation', () => {
    const action = decideWebhookAction(event(), {
      alreadyProcessed: false,
      orderExists: false,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('ORDER_NOT_FOUND');
  });

  it('a success for the wrong amount is not a success', () => {
    const action = decideWebhookAction(event({ amountPaise: paise(100) }), {
      alreadyProcessed: false,
      expectedAmountPaise: 26_840,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('AMOUNT_MISMATCH');
  });

  it('a settlement notification changes no order state', () => {
    const action = decideWebhookAction(event({ kind: 'TRANSFER_SETTLED' }), {
      alreadyProcessed: false,
    });
    expect(action.kind).toBe('RECONCILE');
  });
});

describe('applying a verified event', () => {
  it('confirms payment and enqueues dispatch separately', () => {
    // PAY-04: dispatch is a separate committed command, so a webhook delivered
    // twice still results in exactly one dispatch.
    const action = decideWebhookAction(event(), {
      alreadyProcessed: false,
      expectedAmountPaise: 26_840,
      orderExists: true,
    });
    expect(action).toMatchObject({
      kind: 'APPLY',
      command: 'confirmPayment',
      enqueueDispatch: true,
    });
  });

  it('a failed payment does not enqueue dispatch', () => {
    const action = decideWebhookAction(event({ kind: 'PAYMENT_FAILED' }), {
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(action).toMatchObject({
      kind: 'APPLY',
      command: 'failPayment',
      enqueueDispatch: false,
    });
  });

  it('maps refund outcomes to their commands', () => {
    const ok = decideWebhookAction(event({ kind: 'REFUND_SUCCEEDED' }), {
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(ok).toMatchObject({ kind: 'APPLY', command: 'confirmRefund' });

    const bad = decideWebhookAction(event({ kind: 'REFUND_FAILED' }), {
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(bad).toMatchObject({ kind: 'APPLY', command: 'failRefund' });
  });

  it('every outcome acknowledges with 200', () => {
    for (const ctx of [
      { alreadyProcessed: true },
      { alreadyProcessed: false, orderExists: true, expectedAmountPaise: 26_840 },
      { alreadyProcessed: false, orderExists: false },
    ]) {
      expect(httpStatusFor(decideWebhookAction(event(), ctx))).toBe(200);
    }
  });
});

describe('the stub can inject the failures the chaos suite needs (PRD §4.6)', () => {
  it('simulates a declined refund', async () => {
    const p = new StubPaymentProvider({ faults: { failRefund: true } });
    const r = await p.refund({
      refundId: 'r1',
      orderId: 'o1',
      providerPaymentRef: 'pay_1',
      amountPaise: paise(1000),
      reason: 'rejected',
      reverseVendorTransfer: true,
    });
    expect(r.status).toBe('FAILED');
  });

  it('simulates a refund that never confirms', async () => {
    const p = new StubPaymentProvider({ faults: { refundNeverConfirms: true } });
    const r = await p.refund({
      refundId: 'r1',
      orderId: 'o1',
      providerPaymentRef: 'pay_1',
      amountPaise: paise(1000),
      reason: 'rejected',
      reverseVendorTransfer: true,
    });
    expect(r.status).toBe('PENDING');
  });

  it('simulates a provider timeout as ambiguity, not failure', async () => {
    const p = new StubPaymentProvider({ faults: { statusTimesOut: true } });
    await expect(p.getStatus('pay_1')).rejects.toBeInstanceOf(AppError);
  });

  it('emits an unrecognised event on demand', () => {
    const p = new StubPaymentProvider({ faults: { emitUnknownEvent: true } });
    const { rawBody, headers } = p.signedWebhook({ id: 'evt_9', type: 'payment.succeeded' });
    expect(p.verifyAndParseWebhook(rawBody, headers).kind).toBe('UNKNOWN');
  });

  it('splits are idempotent on the platform transfer id', async () => {
    // A retried split must never double-pay a vendor.
    const p = new StubPaymentProvider();
    const input = {
      orderId: 'o1',
      transferId: 't1',
      totalPaise: paise(26_840),
      allocations: [
        { party: 'VENDOR' as const, linkedAccountId: 'acc_v', amountPaise: paise(23_820) },
      ],
    };
    const first = await p.applySplit(input);
    const second = await p.applySplit(input);
    expect(second).toEqual(first);
  });

  it('is a no-op split in VENDOR_DIRECT', async () => {
    const p = new StubPaymentProvider({ mode: 'VENDOR_DIRECT' });
    const r = await p.applySplit({
      orderId: 'o1',
      transferId: 't1',
      totalPaise: paise(1000),
      allocations: [],
    });
    expect(r).toEqual({ applied: false, reason: 'NOT_APPLICABLE' });
  });

  it('returns an ADVISORY refund and no settlement report in VENDOR_DIRECT', async () => {
    // The platform cannot debit the vendor's account. PRD REF-08, LED-05.
    const p = new StubPaymentProvider({ mode: 'VENDOR_DIRECT' });
    const r = await p.refund({
      refundId: 'r1',
      orderId: 'o1',
      providerPaymentRef: 'pay_1',
      amountPaise: paise(1000),
      reason: 'rejected',
      reverseVendorTransfer: false,
    });
    expect(r.authority).toBe('ADVISORY');
    expect(await p.getSettlementReport('2026-08-01', '2026-08-31')).toBeNull();
  });

  it('reports a successful payment in the settlement report', async () => {
    const p = new StubPaymentProvider();
    const intent = await p.createIntent({
      orderId: 'o1',
      vendorId: 'v1',
      amountPaise: paise(26_840),
      correlationId: 'c1',
    });
    expect(await p.getStatus(intent.providerOrderRef)).toBe('PENDING');
    p.markPaid(intent.providerOrderRef);
    expect(await p.getStatus(intent.providerOrderRef)).toBe('SUCCESS');

    const report = await p.getSettlementReport('2026-08-01', '2026-08-31');
    expect(report?.transactions).toHaveLength(1);
  });

  it('an unknown payment reference reconciles rather than reporting failure', async () => {
    const p = new StubPaymentProvider();
    expect(await p.getStatus('nope')).toBe('RECONCILIATION_REQUIRED');
  });

  it('can fail intent creation', async () => {
    const p = new StubPaymentProvider({ faults: { failCreateIntent: true } });
    await expect(
      p.createIntent({ orderId: 'o1', vendorId: 'v1', amountPaise: paise(1), correlationId: 'c' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('can fail a split', async () => {
    const p = new StubPaymentProvider({ faults: { failSplit: true } });
    const r = await p.applySplit({
      orderId: 'o1',
      transferId: 't1',
      totalPaise: paise(1000),
      allocations: [],
    });
    expect(r.applied).toBe(false);
  });

  it('can withhold the settlement report', async () => {
    const p = new StubPaymentProvider({ faults: { noSettlementReport: true } });
    expect(await p.getSettlementReport('2026-08-01', '2026-08-31')).toBeNull();
  });
});
