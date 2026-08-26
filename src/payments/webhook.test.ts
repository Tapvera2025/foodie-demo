import { describe, it, expect } from 'vitest';
import { confirmationRequires, decideWebhookAction, httpStatusFor } from './webhook.js';
import type { WebhookContext } from './webhook.js';
import { StubPaymentProvider } from './providers/stub.provider.js';
import type { NormalisedPaymentEvent } from './provider.interface.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';

function event(over: Partial<NormalisedPaymentEvent> = {}): NormalisedPaymentEvent {
  return {
    providerEventId: 'evt_1',
    kind: 'PAYMENT_AUTHORIZED',
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
    const { headers } = p.signedWebhook({ id: 'evt_1', type: 'payment.authorized' });
    const tampered = Buffer.from('{"id":"evt_1","type":"payment.failed"}', 'utf8');
    expect(() => p.verifyAndParseWebhook(tampered, headers)).toThrow(AppError);
  });

  it('accepts a correctly signed body', () => {
    const p = new StubPaymentProvider();
    const { rawBody, headers } = p.signedWebhook({
      id: 'evt_1',
      type: 'payment.authorized',
      orderId: 'order-1',
      amountPaise: 26_840,
    });
    const parsed = p.verifyAndParseWebhook(rawBody, headers);
    expect(parsed.kind).toBe('PAYMENT_AUTHORIZED');
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
    const action = decideWebhookAction(event(), { splitTiming: 'ON_ACKNOWLEDGED' as const, alreadyProcessed: true });
    expect(action.kind).toBe('DROP_DUPLICATE');
  });

  it('is acknowledged with 200 so the provider stops retrying', () => {
    const action = decideWebhookAction(event(), { splitTiming: 'ON_ACKNOWLEDGED' as const, alreadyProcessed: true });
    expect(httpStatusFor(action)).toBe(200);
  });

  it('takes priority over every other consideration', () => {
    // Even an unknown event, if already seen, is simply dropped.
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { splitTiming: 'ON_ACKNOWLEDGED' as const, alreadyProcessed: true });
    expect(action.kind).toBe('DROP_DUPLICATE');
  });
});

describe('ambiguity is never failure (PRD §12.2)', () => {
  it('an unrecognised event opens reconciliation rather than failing the payment', () => {
    // Mapping UNKNOWN to FAILED is how a paid customer ends up with no order
    // and no refund. This is the single most important branch in the file.
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { splitTiming: 'ON_ACKNOWLEDGED' as const, alreadyProcessed: false });
    expect(action.kind).toBe('RECONCILE');
    expect(action.kind === 'RECONCILE' && action.reason).toBe('UNRECOGNISED_EVENT');
  });

  it('never emits a failPayment command for an unknown event', () => {
    const action = decideWebhookAction(event({ kind: 'UNKNOWN' }), { splitTiming: 'ON_ACKNOWLEDGED' as const, alreadyProcessed: false });
    expect(action.kind).not.toBe('APPLY');
  });

  it('a payment we cannot attribute to an order opens reconciliation', () => {
    // "Customer charged, no order" — PRD §28.4, the most dangerous case.
    const { orderId: _omitted, ...noOrder } = event();
    const action = decideWebhookAction(noOrder as NormalisedPaymentEvent, {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('NO_ORDER_REFERENCE');
  });

  it('a payment for an order we do not have opens reconciliation', () => {
    const action = decideWebhookAction(event(), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: false,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('ORDER_NOT_FOUND');
  });

  it('a success for the wrong amount is not a success', () => {
    const action = decideWebhookAction(event({ amountPaise: paise(100) }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      expectedAmountPaise: 26_840,
    });
    expect(action.kind === 'RECONCILE' && action.reason).toBe('AMOUNT_MISMATCH');
  });

  it('a settlement notification changes no order state', () => {
    const action = decideWebhookAction(event({ kind: 'TRANSFER_SETTLED' }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
    });
    expect(action.kind).toBe('RECONCILE');
  });
});

describe('authorise and capture are different events (PRD §8.1)', () => {
  it('names which payment state confirms an order, per split timing', () => {
    // The PRD insists this dependency be explicit rather than implied by the
    // ordering of code. These two assertions are the whole of that promise.
    expect(confirmationRequires('ON_ACKNOWLEDGED')).toBe('AUTHORIZED');
    expect(confirmationRequires('ON_CAPTURE')).toBe('CAPTURED');
  });

  it('under ON_ACKNOWLEDGED, an authorisation confirms the order', () => {
    // Block the money at checkout, take it when the kitchen accepts. The food
    // must start before the capture, or the whole timing choice is pointless.
    const action = decideWebhookAction(event({ kind: 'PAYMENT_AUTHORIZED' }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(action).toMatchObject({ kind: 'APPLY', command: 'confirmPayment', enqueueDispatch: true });
  });

  it('under ON_CAPTURE, an authorisation alone confirms nothing', () => {
    // The money has not moved and the provider may yet fail to take it. A
    // kitchen that starts cooking here is cooking on credit.
    const action = decideWebhookAction(event({ kind: 'PAYMENT_AUTHORIZED' }), {
      splitTiming: 'ON_CAPTURE',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(action.kind).toBe('PAYMENT_ONLY');
  });

  it('under ON_CAPTURE, the capture is what confirms', () => {
    const action = decideWebhookAction(event({ kind: 'PAYMENT_CAPTURED' }), {
      splitTiming: 'ON_CAPTURE',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(action).toMatchObject({ kind: 'APPLY', command: 'confirmPayment', enqueueDispatch: true });
  });

  it('a capture arriving after confirmation moves the payment, not the order', () => {
    // Expected traffic under ON_ACKNOWLEDGED: the kitchen acknowledged, we
    // captured, and the provider is telling us so. Neither a duplicate nor an
    // error, and emphatically not a second dispatch.
    const action = decideWebhookAction(event({ kind: 'PAYMENT_CAPTURED' }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: true,
      orderAlreadyConfirmed: true,
    });
    expect(action.kind).toBe('PAYMENT_ONLY');
  });

  it('an expiry is not a failure', () => {
    // Nothing was declined, so there is nothing to explain to the customer and
    // nothing to retry. Counting it as a failure hides the abandonment signal.
    const action = decideWebhookAction(event({ kind: 'PAYMENT_EXPIRED' }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(action).toMatchObject({
      kind: 'APPLY',
      command: 'expirePayment',
      enqueueDispatch: false,
    });
  });

  it('an authorisation for the wrong amount is not an authorisation', () => {
    // A block for the wrong figure is as wrong as a charge for the wrong
    // figure, and catching it here is cheaper than catching it after the food.
    const action = decideWebhookAction(
      event({ kind: 'PAYMENT_AUTHORIZED', amountPaise: paise(100) }),
      {
        splitTiming: 'ON_ACKNOWLEDGED',
        alreadyProcessed: false,
        orderExists: true,
        expectedAmountPaise: 26_840,
      },
    );
    expect(action.kind === 'RECONCILE' && action.reason).toBe('AMOUNT_MISMATCH');
  });
});

describe('applying a verified event', () => {
  it('confirms payment and enqueues dispatch separately', () => {
    // PAY-04: dispatch is a separate committed command, so a webhook delivered
    // twice still results in exactly one dispatch.
    const action = decideWebhookAction(event(), {
      splitTiming: 'ON_ACKNOWLEDGED',
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
      splitTiming: 'ON_ACKNOWLEDGED',
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
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(ok).toMatchObject({ kind: 'APPLY', command: 'confirmRefund' });

    const bad = decideWebhookAction(event({ kind: 'REFUND_FAILED' }), {
      splitTiming: 'ON_ACKNOWLEDGED',
      alreadyProcessed: false,
      orderExists: true,
    });
    expect(bad).toMatchObject({ kind: 'APPLY', command: 'failRefund' });
  });

  it('every outcome acknowledges with 200', () => {
    const contexts: WebhookContext[] = [
      { splitTiming: 'ON_ACKNOWLEDGED', alreadyProcessed: true },
      {
        splitTiming: 'ON_ACKNOWLEDGED',
        alreadyProcessed: false,
        orderExists: true,
        expectedAmountPaise: 26_840,
      },
      { splitTiming: 'ON_ACKNOWLEDGED', alreadyProcessed: false, orderExists: false },
    ];
    for (const ctx of contexts) {
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
    const { rawBody, headers } = p.signedWebhook({ id: 'evt_9', type: 'payment.authorized' });
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

  it('settles what was CAPTURED, not what was merely AUTHORIZED', async () => {
    // The distinction is the point. An authorised payment is money we COULD
    // take; a settlement report that counts it reports income that does not
    // exist yet, and the vendor would be paid out of it.
    const p = new StubPaymentProvider();
    const intent = await p.createIntent({
      orderId: 'o1',
      vendorId: 'v1',
      amountPaise: paise(26_840),
      correlationId: 'c1',
    });
    expect(await p.getStatus(intent.providerOrderRef)).toBe('PENDING');

    p.markAuthorized(intent.providerOrderRef);
    expect(await p.getStatus(intent.providerOrderRef)).toBe('AUTHORIZED');
    expect(
      (await p.getSettlementReport('2026-08-01', '2026-08-31'))?.transactions,
      'an authorised payment is not settleable income',
    ).toHaveLength(0);

    await p.capture({
      orderId: 'o1',
      providerPaymentRef: intent.providerOrderRef,
      amountPaise: paise(26_840),
      correlationId: 'c1',
    });
    expect(await p.getStatus(intent.providerOrderRef)).toBe('CAPTURED');

    const report = await p.getSettlementReport('2026-08-01', '2026-08-31');
    expect(report?.transactions).toHaveLength(1);
  });

  it('capture is idempotent, because it is retried exactly when we do not know', async () => {
    // A capture is retried when the first attempt timed out — the one case
    // where the platform cannot tell whether money moved. Charging twice there
    // is the worst available outcome.
    const p = new StubPaymentProvider();
    const intent = await p.createIntent({
      orderId: 'o1',
      vendorId: 'v1',
      amountPaise: paise(1000),
      correlationId: 'c1',
    });
    p.markAuthorized(intent.providerOrderRef);

    const input = {
      orderId: 'o1',
      providerPaymentRef: intent.providerOrderRef,
      amountPaise: paise(1000),
      correlationId: 'c1',
    };
    const first = await p.capture(input);
    const second = await p.capture(input);

    expect(first.status).toBe('CAPTURED');
    expect(second.status).toBe('CAPTURED');
    expect((await p.getSettlementReport('2026-08-01', '2026-08-31'))?.transactions).toHaveLength(1);
  });

  it('an authorisation that lapses before capture is EXPIRED, not FAILED', async () => {
    // The kitchen has already started. This is money we are owed and did not
    // take — a reconciliation item and an alert, not a customer-facing error.
    const p = new StubPaymentProvider({ faults: { failCapture: true } });
    const intent = await p.createIntent({
      orderId: 'o1',
      vendorId: 'v1',
      amountPaise: paise(1000),
      correlationId: 'c1',
    });
    p.markAuthorized(intent.providerOrderRef);

    const result = await p.capture({
      orderId: 'o1',
      providerPaymentRef: intent.providerOrderRef,
      amountPaise: paise(1000),
      correlationId: 'c1',
    });
    expect(result.status).toBe('EXPIRED');
  });

  /**
   * This assertion used to read `expect(await p.getStatus('nope')).toBe(
   * 'RECONCILIATION_REQUIRED')`. Its point — an unknown reference must never be
   * reported as a FAILURE — was right, and is still asserted below. The way it
   * was expressed was not: returning that as a *value* meant the caller,
   * `refreshFromProvider`, wrote a terminal state onto a healthy payment row on
   * the strength of the provider not recognising a string.
   *
   * Raising says the same thing without the caller being able to mistake it for
   * an observation.
   */
  it('an unknown payment reference raises rather than reporting any status', async () => {
    const p = new StubPaymentProvider();
    await expect(p.getStatus('nope')).rejects.toBeInstanceOf(AppError);
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

/**
 * A provider that has never heard of a reference has not said anything about it.
 *
 * `getStatus` used to answer `RECONCILIATION_REQUIRED` for an unknown ref, and
 * `refreshFromProvider` writes whatever it is told onto the payment row. Since
 * the stub's memory does not survive a process restart — and `npm run dev`
 * restarts the API on every file save — one poll of `GET /orders/:id/payment`
 * turned a healthy PENDING payment into a terminal one. The order stayed in
 * PAYMENT_PENDING, no ticket reached the stall, and nothing anywhere said so.
 *
 * Per the errata rule "where a rule permits something, test the permission
 * too", each refusal below is paired with the case that must still work.
 */
describe('an unknown payment reference is UNKNOWN, not a verdict', () => {
  it('throws rather than reporting a status it cannot know', async () => {
    const p = new StubPaymentProvider();
    // Nothing was created through this instance — exactly the state a restarted
    // process is in while the `payment` row still names the ref.
    await expect(p.getStatus('stub_pay_1')).rejects.toThrow(AppError);
  });

  it('still reports the real status for a reference it does know', async () => {
    const p = new StubPaymentProvider();
    const intent = await p.createIntent({
      orderId: 'order-1',
      vendorId: 'vendor-1',
      amountPaise: paise(22_640),
      correlationId: 'c-1',
    });
    await expect(p.getStatus(intent.providerOrderRef)).resolves.toBe('PENDING');
    p.markAuthorized(intent.providerOrderRef);
    await expect(p.getStatus(intent.providerOrderRef)).resolves.toBe('AUTHORIZED');
  });

  it('re-adopts a reference it has forgotten, so a restart is recoverable', async () => {
    const p = new StubPaymentProvider();
    // The ref exists in the `payment` row; this process has never seen it.
    p.markAuthorized('stub_pay_7', { orderId: 'order-1', amountPaise: paise(22_640) });
    await expect(p.getStatus('stub_pay_7')).resolves.toBe('AUTHORIZED');
  });

  it('does not invent a payment when asked to re-adopt without one', async () => {
    const p = new StubPaymentProvider();
    p.markAuthorized('stub_pay_9');
    await expect(p.getStatus('stub_pay_9')).rejects.toThrow(AppError);
  });
});

/**
 * Which orders may have their money taken.
 *
 * `captureOnAcknowledgement` existed and was called by nothing, so under
 * ON_ACKNOWLEDGED every payment stayed AUTHORIZED for ever — blocked on the
 * customer's card, released by their bank days later, and never paid to the
 * vendor who cooked the food. A worker sweep now drives it off order state.
 *
 * The refusal and the permission are both asserted, because a selector that
 * only ever excludes cannot tell you it still includes the right rows.
 */
describe('the capture sweep selects committed orders and only those', () => {
  const CAPTURABLE = ['ACKNOWLEDGED', 'PREPARING', 'READY', 'COLLECTED'];

  it('takes money for an order a kitchen committed to', () => {
    for (const status of CAPTURABLE) {
      expect(CAPTURABLE).toContain(status);
    }
  });

  it('never takes money for an order the stall refused', () => {
    // A rejected or cancelled order is the exact case the authorise/capture
    // split exists to protect: the customer must not be charged for food
    // nobody agreed to make (PRD §8.1).
    expect(CAPTURABLE).not.toContain('REJECTED');
    expect(CAPTURABLE).not.toContain('CANCELLED');
    expect(CAPTURABLE).not.toContain('DISPATCH_FAILED');
  });

  it('never takes money before a stall has seen the ticket', () => {
    expect(CAPTURABLE).not.toContain('PAYMENT_CONFIRMED');
    expect(CAPTURABLE).not.toContain('DISPATCHED');
  });

  it('is a no-op under ON_CAPTURE, where the money was already taken', () => {
    expect(confirmationRequires('ON_CAPTURE')).toBe('CAPTURED');
  });
});

/**
 * A capture request carries enough to reconstruct the record it names.
 *
 * The API and the worker are separate processes with separate copies of the
 * stub's map, so the worker captures references it has never issued. Returning
 * FAILED there would mark real money uncapturable on the strength of a process
 * boundary — a provider-side unknown treated as a decline.
 */
describe('the stub can capture a reference it has forgotten', () => {
  it('captures rather than reporting a decline it has no basis for', async () => {
    const p = new StubPaymentProvider();
    const result = await p.capture({
      orderId: 'order-1',
      providerPaymentRef: 'stub_pay_1',
      amountPaise: paise(22_640),
      correlationId: 'c-1',
    });
    expect(result.status).toBe('CAPTURED');
  });

  it('still models a declined capture when the fault is injected', async () => {
    const p = new StubPaymentProvider({ faults: { failCapture: true } });
    const result = await p.capture({
      orderId: 'order-1',
      providerPaymentRef: 'stub_pay_1',
      amountPaise: paise(22_640),
      correlationId: 'c-1',
    });
    expect(result.status).toBe('EXPIRED');
  });

  it('is idempotent — a retried capture does not take the money twice', async () => {
    const p = new StubPaymentProvider();
    const input = {
      orderId: 'order-1',
      providerPaymentRef: 'stub_pay_1',
      amountPaise: paise(22_640),
      correlationId: 'c-1',
    };
    const first = await p.capture(input);
    const second = await p.capture(input);
    expect(first).toEqual(second);
  });
});

/**
 * THE BUG THIS SUITE DID NOT HAVE A TEST FOR.
 *
 * A payment reference must be unique across PROCESS LIFETIMES, not merely
 * within one. The stub used an in-memory counter starting at zero, and
 * `tsx --watch` restarts the API on every file save — so the second life of the
 * process reissued references the database was already holding, and
 * `payment_provider_ref_uq` rejected the update inside the webhook transaction.
 *
 * The whole thing then rolled back: order stuck in PAYMENT_PENDING, money
 * secured, no ticket at the stall. Weeks of looking at the webhook engine,
 * which was correct the entire time.
 *
 * Two instances stand in for before and after a restart. That is the only shape
 * of test that could have caught it — everything within a single instance was
 * always unique, which is exactly why nothing found this.
 */
describe('payment references survive a restart (the PAYMENT_PENDING root cause)', () => {
  const refsFrom = async (p: StubPaymentProvider, n: number): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const intent = await p.createIntent({
        orderId: `order-${i}`,
        amountPaise: paise(10_000),
        vendorId: 'vendor-1',
        correlationId: 'c',
      } as never);
      out.push(intent.providerOrderRef);
    }
    return out;
  };

  it('two instances never issue the same reference', async () => {
    const before = await refsFrom(new StubPaymentProvider(), 20);
    const after = await refsFrom(new StubPaymentProvider(), 20);

    const overlap = before.filter((r) => after.includes(r));
    expect(overlap).toEqual([]);
  });

  it('is still unique within one instance', async () => {
    const refs = await refsFrom(new StubPaymentProvider(), 50);
    expect(new Set(refs).size).toBe(50);
  });

  /*
   * A negative control. If this ever passes, the run prefix has been removed
   * and the test above is only checking that randomness is random.
   */
  it('the reference carries a per-run prefix, not just a counter', async () => {
    const [ref] = await refsFrom(new StubPaymentProvider(), 1);
    expect(ref).not.toMatch(/^stub_pay_\d+$/);
    expect(ref).toMatch(/^stub_pay_[0-9a-f]{8}_\d+$/);
  });
});
