import { describe, it, expect } from 'vitest';
import {
  RETRY_SCHEDULE,
  MAX_ATTEMPTS,
  stepFor,
  nextRetryAt,
  isExhausted,
  decideRefundNextAction,
  customerCopyKey,
  initiatedInTime,
  INITIATE_WITHIN_SECONDS,
} from './refund.js';

const NOW = new Date('2026-08-10T12:30:00Z');
const after = (s: number): Date => new Date(NOW.getTime() + s * 1000);

describe('the retry schedule matches TDD §6.4', () => {
  it('has five attempts at the stated delays', () => {
    expect(RETRY_SCHEDULE.map((s) => s.delaySeconds)).toEqual([0, 120, 480, 1800, 7200]);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('fires the first attempt immediately, not on a scheduler', () => {
    // REF-01 promises 60 seconds. That cannot depend on queue latency, so
    // attempt 1 runs from the committed rejection event with zero delay.
    expect(stepFor(1)?.delaySeconds).toBe(0);
  });

  it('changes the customer message at attempt 4, not before', () => {
    // Up to 30 minutes the customer is told the refund is on its way, which is
    // true. Beyond that they are told it is delayed, which is also true.
    expect(stepFor(1)?.customerCopyKey).toBe('refund.pending');
    expect(stepFor(3)?.customerCopyKey).toBe('refund.pending');
    expect(stepFor(4)?.customerCopyKey).toBe('refund.delayed');
    expect(stepFor(5)?.customerCopyKey).toBe('refund.delayed');
  });

  it('alerts ops from attempt 4', () => {
    expect(RETRY_SCHEDULE.filter((s) => s.alertsOps).map((s) => s.attempt)).toEqual([4, 5]);
  });

  it('escalates monotonically', () => {
    for (let i = 1; i < RETRY_SCHEDULE.length; i++) {
      expect(RETRY_SCHEDULE[i]!.delaySeconds).toBeGreaterThan(RETRY_SCHEDULE[i - 1]!.delaySeconds);
    }
  });
});

describe('nextRetryAt()', () => {
  it('schedules the next attempt at its configured delay', () => {
    expect(nextRetryAt(1, NOW)).toEqual(after(120));
    expect(nextRetryAt(3, NOW)).toEqual(after(1800));
  });

  it('returns null once the schedule is exhausted', () => {
    expect(nextRetryAt(5, NOW)).toBeNull();
    expect(isExhausted(5)).toBe(true);
    expect(isExhausted(4)).toBe(false);
  });
});

describe('deciding what happens after an attempt', () => {
  it('stops on success', () => {
    expect(decideRefundNextAction('SUCCEEDED', 1, NOW)).toEqual({ kind: 'DONE' });
  });

  it('retries a failure with backoff', () => {
    expect(decideRefundNextAction('FAILED', 1, NOW)).toEqual({
      kind: 'RETRY',
      at: after(120),
      attempt: 2,
      alertsOps: false,
    });
  });

  it('alerts ops when the retry lands on attempt 4', () => {
    expect(decideRefundNextAction('FAILED', 3, NOW)).toMatchObject({
      kind: 'RETRY',
      attempt: 4,
      alertsOps: true,
    });
  });

  it('opens reconciliation when retries are exhausted — never abandons silently', () => {
    // REF-03: a refund never silently stops being attempted.
    expect(decideRefundNextAction('FAILED', 5, NOW)).toEqual({
      kind: 'RECONCILE',
      reason: 'RETRIES_EXHAUSTED',
    });
  });

  it('keeps polling a PENDING refund rather than treating it as a failure', () => {
    // The provider has it and will call back. Pending is not failure.
    expect(decideRefundNextAction('PENDING', 1, NOW)).toMatchObject({
      kind: 'RETRY',
      attempt: 2,
    });
  });

  it('eventually reconciles a refund that never confirms', () => {
    // The "stuck refund" path — the one the stub can inject.
    expect(decideRefundNextAction('PENDING', 5, NOW)).toEqual({
      kind: 'RECONCILE',
      reason: 'RETRIES_EXHAUSTED',
    });
  });
});

describe('customer-facing status (REF-04 / CUS-TRK-05)', () => {
  it('never leaves the customer without an explanation', () => {
    for (const attempt of [1, 2, 3, 4, 5, 99]) {
      expect(customerCopyKey('FAILED', attempt)).toBeTruthy();
      expect(customerCopyKey('PENDING', attempt)).toBeTruthy();
    }
  });

  it('confirms when the money is back', () => {
    expect(customerCopyKey('SUCCEEDED', 3)).toBe('refund.done');
  });

  it('points at the credit when the refund was abandoned in its favour', () => {
    expect(customerCopyKey('ABANDONED', 1)).toBe('refund.credit.issued');
  });

  it('says "delayed" only once it genuinely is', () => {
    expect(customerCopyKey('PENDING', 1)).toBe('refund.pending');
    expect(customerCopyKey('PENDING', 4)).toBe('refund.delayed');
  });
});

describe('the 60-second guarantee (REF-01)', () => {
  it('passes when initiated promptly', () => {
    expect(initiatedInTime(NOW, after(45))).toBe(true);
    expect(initiatedInTime(NOW, after(INITIATE_WITHIN_SECONDS))).toBe(true);
  });

  it('fails when it took longer — this is a measured pilot metric', () => {
    expect(initiatedInTime(NOW, after(61))).toBe(false);
  });
});
