import { describe, it, expect } from 'vitest';
import {
  decideCreditConsumption,
  decideRefundConfirmation,
  afterRefundCancelAttempt,
  assertConsumable,
  violatesMutualExclusion,
  type CreditRecord,
  type RefundRecord,
  type CreditStatus,
  type RefundStatus,
} from './credit.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';

const NOW = new Date('2026-08-10T12:30:00Z');

function credit(over: Partial<CreditRecord> = {}): CreditRecord {
  return {
    id: 'cr-1',
    originOrderId: 'order-1',
    amountPaise: paise(26_840),
    status: 'ISSUED',
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000),
    ...over,
  };
}

function refund(over: Partial<RefundRecord> = {}): RefundRecord {
  return {
    id: 'rf-1',
    orderId: 'order-1',
    amountPaise: paise(26_840),
    status: 'PENDING',
    ...over,
  };
}

describe('spending credit', () => {
  it('is allowed when no refund exists', () => {
    expect(decideCreditConsumption(credit(), undefined, NOW)).toEqual({ kind: 'CONSUME' });
  });

  it('REFUSES when the refund already reached the bank', () => {
    // The whole point. Spending here would pay the customer twice.
    const d = decideCreditConsumption(credit(), refund({ status: 'SUCCEEDED' }), NOW);
    expect(d).toEqual({ kind: 'REFUSE', code: 'CREDIT_ALREADY_REFUNDED' });
  });

  it('requires an in-flight refund to be cancelled first', () => {
    for (const status of ['REQUESTED', 'PENDING'] as RefundStatus[]) {
      const d = decideCreditConsumption(credit(), refund({ status }), NOW);
      expect(d).toEqual({ kind: 'CANCEL_REFUND_THEN_CONSUME', refundId: 'rf-1' });
    }
  });

  it('allows spending when the refund failed for good — the credit is the only remedy', () => {
    for (const status of ['FAILED', 'ABANDONED'] as RefundStatus[]) {
      expect(decideCreditConsumption(credit(), refund({ status }), NOW)).toEqual({
        kind: 'CONSUME',
      });
    }
  });

  it('refuses credit that is not in ISSUED state', () => {
    for (const status of ['CONSUMED', 'EXPIRED', 'VOIDED'] as CreditStatus[]) {
      expect(decideCreditConsumption(credit({ status }), undefined, NOW)).toEqual({
        kind: 'REFUSE',
        code: 'CREDIT_NOT_AVAILABLE',
      });
    }
  });

  it('refuses expired credit', () => {
    const expired = credit({ expiresAt: new Date(NOW.getTime() - 1000) });
    expect(decideCreditConsumption(expired, undefined, NOW)).toEqual({
      kind: 'REFUSE',
      code: 'CREDIT_EXPIRED',
    });
  });

  it('checks credit state before looking at the refund at all', () => {
    // Ordering matters: a consumed credit is refused as unavailable, not as
    // already-refunded, so the customer message is accurate.
    const d = decideCreditConsumption(
      credit({ status: 'CONSUMED' }),
      refund({ status: 'SUCCEEDED' }),
      NOW,
    );
    expect(d).toEqual({ kind: 'REFUSE', code: 'CREDIT_NOT_AVAILABLE' });
  });
});

describe('when the provider will not stop an in-flight refund', () => {
  it('the bank refund wins, because we cannot un-send money', () => {
    expect(afterRefundCancelAttempt(false)).toEqual({
      kind: 'REFUSE',
      code: 'CREDIT_ALREADY_REFUNDED',
    });
  });

  it('the credit wins if the cancel succeeded', () => {
    expect(afterRefundCancelAttempt(true)).toEqual({ kind: 'CONSUME' });
  });
});

describe('assertConsumable()', () => {
  it('throws with the right code for the client', () => {
    try {
      assertConsumable({ kind: 'REFUSE', code: 'CREDIT_ALREADY_REFUNDED' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('CREDIT_ALREADY_REFUNDED');
      expect((e as AppError).httpStatus).toBe(409);
    }
  });

  it('passes through both allowing decisions', () => {
    expect(() => assertConsumable({ kind: 'CONSUME' })).not.toThrow();
    expect(() =>
      assertConsumable({ kind: 'CANCEL_REFUND_THEN_CONSUME', refundId: 'rf-1' }),
    ).not.toThrow();
  });
});

describe('confirming a refund', () => {
  it('confirms cleanly when no credit was issued', () => {
    expect(decideRefundConfirmation(undefined, refund())).toEqual({ kind: 'CONFIRM' });
  });

  it('voids unspent credit — the money went to the bank instead', () => {
    expect(decideRefundConfirmation(credit({ status: 'ISSUED' }), refund())).toEqual({
      kind: 'CONFIRM',
      voidCreditId: 'cr-1',
    });
  });

  it('does nothing extra for already-expired or voided credit', () => {
    for (const status of ['EXPIRED', 'VOIDED'] as CreditStatus[]) {
      expect(decideRefundConfirmation(credit({ status }), refund())).toEqual({ kind: 'CONFIRM' });
    }
  });

  it('reports DOUBLE_PAYOUT if the credit was already spent', () => {
    // Unreachable by design — decideCreditConsumption cancels in-flight refunds
    // before allowing a spend. Reaching here means a defect, so it must be loud
    // rather than silently absorbed.
    const d = decideRefundConfirmation(credit({ status: 'CONSUMED' }), refund());
    expect(d).toEqual({ kind: 'DOUBLE_PAYOUT', creditId: 'cr-1', refundId: 'rf-1' });
  });
});

describe('the invariant that must always hold', () => {
  it('detects the forbidden state', () => {
    // Mirrors v_credit_refund_conflict in schema.sql.
    expect(
      violatesMutualExclusion(credit({ status: 'CONSUMED' }), refund({ status: 'SUCCEEDED' })),
    ).toBe(true);
  });

  it('is false for every legal combination', () => {
    const creditStates: CreditStatus[] = ['ISSUED', 'CONSUMED', 'EXPIRED', 'VOIDED'];
    const refundStates: RefundStatus[] = [
      'REQUESTED',
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'ABANDONED',
    ];
    for (const c of creditStates) {
      for (const r of refundStates) {
        const forbidden = c === 'CONSUMED' && r === 'SUCCEEDED';
        expect(violatesMutualExclusion(credit({ status: c }), refund({ status: r }))).toBe(
          forbidden,
        );
      }
    }
  });

  it('is false when either side is absent', () => {
    expect(violatesMutualExclusion(undefined, refund({ status: 'SUCCEEDED' }))).toBe(false);
    expect(violatesMutualExclusion(credit({ status: 'CONSUMED' }), undefined)).toBe(false);
  });
});

describe('the two paths can never both complete', () => {
  it('exhaustively: following the decisions never reaches the forbidden state', () => {
    const creditStates: CreditStatus[] = ['ISSUED', 'CONSUMED', 'EXPIRED', 'VOIDED'];
    const refundStates: RefundStatus[] = [
      'REQUESTED',
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'ABANDONED',
    ];

    for (const c of creditStates) {
      for (const r of refundStates) {
        const decision = decideCreditConsumption(credit({ status: c }), refund({ status: r }), NOW);
        if (decision.kind === 'CONSUME') {
          // A straight CONSUME is only ever offered when no completed refund
          // exists — otherwise we would be authorising a double payout.
          expect(r).not.toBe('SUCCEEDED');
        }
      }
    }
  });
});
