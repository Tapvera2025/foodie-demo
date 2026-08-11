import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LADDER,
  buildLadder,
  decideLadderStep,
  firstRunAt,
  cancellationOffered,
  isValidLadder,
} from './escalation.js';
import { ORDER_STATUSES } from '../ordering/state-machine.js';

const DISPATCHED_AT = new Date('2026-08-10T12:30:00Z');
const at = (s: number): Date => new Date(DISPATCHED_AT.getTime() + s * 1000);

describe('the ladder matches PRD §11.4', () => {
  it('fires at 15, 45, 90 and 180 seconds', () => {
    expect(buildLadder().map((r) => r.atSeconds)).toEqual([15, 45, 90, 180]);
  });

  it('escalates in the specified order', () => {
    expect(buildLadder().map((r) => r.action)).toEqual([
      'RETRY_DISPATCH',
      'RETRY_DISPATCH_AND_ALARM',
      'BLOCK_VENDOR_AND_ALERT_MANAGER',
      'FAIL_DISPATCH_AND_OFFER_CANCEL',
    ]);
  });

  it('changes nothing the customer can see until the final rung', () => {
    // ESC-02. Steps 1-3 escalate loudly on the vendor side while the customer
    // still sees a neutral "order placed".
    const ladder = buildLadder();
    expect(ladder.slice(0, 3).every((r) => !r.customerVisible)).toBe(true);
    expect(ladder[3]!.customerVisible).toBe(true);
  });

  it('schedules the first rung at dispatch time', () => {
    expect(firstRunAt(DISPATCHED_AT)).toEqual(at(15));
  });
});

describe('running a rung', () => {
  it('runs step 1 and schedules step 2', () => {
    const d = decideLadderStep({
      orderStatus: 'DISPATCHED',
      step: 1,
      dispatchedAt: DISPATCHED_AT,
      now: at(15),
    });
    expect(d.kind).toBe('RUN');
    expect(d.kind === 'RUN' && d.rung.action).toBe('RETRY_DISPATCH');
    expect(d.kind === 'RUN' && d.nextRunAt).toEqual(at(45));
  });

  it('blocks the vendor at step 3', () => {
    const d = decideLadderStep({
      orderStatus: 'DISPATCHED',
      step: 3,
      dispatchedAt: DISPATCHED_AT,
      now: at(90),
    });
    expect(d.kind === 'RUN' && d.rung.action).toBe('BLOCK_VENDOR_AND_ALERT_MANAGER');
  });

  it('offers cancellation at step 4 and schedules nothing further', () => {
    const d = decideLadderStep({
      orderStatus: 'DISPATCHED',
      step: 4,
      dispatchedAt: DISPATCHED_AT,
      now: at(180),
    });
    expect(d.kind === 'RUN' && d.rung.action).toBe('FAIL_DISPATCH_AND_OFFER_CANCEL');
    expect(d.kind === 'RUN' && d.nextRunAt).toBeNull();
  });
});

describe('acknowledgement cancels the ladder at any point', () => {
  it('cancels once the order is acknowledged', () => {
    for (const step of [1, 2, 3, 4]) {
      const d = decideLadderStep({
        orderStatus: 'ACKNOWLEDGED',
        step,
        dispatchedAt: DISPATCHED_AT,
        now: at(200),
      });
      expect(d.kind).toBe('CANCEL');
    }
  });

  it('unblocks the vendor if the block had already been applied', () => {
    // Acknowledging at 179s must undo the step-3 block, or the stall stays
    // shut out of new orders for no reason.
    const late = decideLadderStep({
      orderStatus: 'ACKNOWLEDGED',
      step: 4,
      dispatchedAt: DISPATCHED_AT,
      now: at(179),
    });
    expect(late).toEqual({ kind: 'CANCEL', unblockVendor: true });

    const early = decideLadderStep({
      orderStatus: 'ACKNOWLEDGED',
      step: 2,
      dispatchedAt: DISPATCHED_AT,
      now: at(46),
    });
    expect(early).toEqual({ kind: 'CANCEL', unblockVendor: false });
  });

  it('cancels for every non-DISPATCHED status', () => {
    // ESC-01: the ladder is durable, so a rung can arrive long after the order
    // moved on. Every one of those cases must be a clean cancel.
    for (const status of ORDER_STATUSES) {
      const d = decideLadderStep({
        orderStatus: status,
        step: 2,
        dispatchedAt: DISPATCHED_AT,
        now: at(45),
      });
      expect(d.kind).toBe(status === 'DISPATCHED' ? 'RUN' : 'CANCEL');
    }
  });

  it('cancels rather than crashing if the step is past the end of the ladder', () => {
    const d = decideLadderStep({
      orderStatus: 'DISPATCHED',
      step: 9,
      dispatchedAt: DISPATCHED_AT,
      now: at(500),
    });
    expect(d).toEqual({ kind: 'CANCEL', unblockVendor: false });
  });
});

describe('cancellation offer (ESC-03)', () => {
  it('is not offered before 180 seconds', () => {
    expect(cancellationOffered('DISPATCHED', DISPATCHED_AT, at(179))).toBe(false);
  });

  it('is offered at exactly 180 seconds', () => {
    expect(cancellationOffered('DISPATCHED', DISPATCHED_AT, at(180))).toBe(true);
  });

  it('is offered once the order has failed dispatch', () => {
    expect(cancellationOffered('DISPATCH_FAILED', DISPATCHED_AT, at(200))).toBe(true);
  });

  it('is never offered for an acknowledged order, however long it takes', () => {
    // Once the kitchen has it, the customer cannot unilaterally cancel — the
    // stall may already be cooking.
    expect(cancellationOffered('ACKNOWLEDGED', DISPATCHED_AT, at(9999))).toBe(false);
    expect(cancellationOffered('PREPARING', DISPATCHED_AT, at(9999))).toBe(false);
  });

  it('is not offered before dispatch has happened', () => {
    expect(cancellationOffered('PAYMENT_CONFIRMED', null, at(9999))).toBe(false);
  });
});

describe('ladder configuration', () => {
  it('accepts the default', () => {
    expect(isValidLadder(DEFAULT_LADDER)).toBe(true);
  });

  it('rejects a non-increasing ladder', () => {
    // A ladder that fires out of order can block a vendor before the first
    // redispatch has even been attempted.
    expect(
      isValidLadder({ step1Seconds: 45, step2Seconds: 15, step3Seconds: 90, step4Seconds: 180 }),
    ).toBe(false);
    expect(
      isValidLadder({ step1Seconds: 15, step2Seconds: 45, step3Seconds: 45, step4Seconds: 180 }),
    ).toBe(false);
    expect(
      isValidLadder({ step1Seconds: 0, step2Seconds: 45, step3Seconds: 90, step4Seconds: 180 }),
    ).toBe(false);
  });

  it('honours a custom per-court ladder (ESC-04)', () => {
    const slow = { step1Seconds: 30, step2Seconds: 60, step3Seconds: 120, step4Seconds: 300 };
    expect(isValidLadder(slow)).toBe(true);
    expect(buildLadder(slow).map((r) => r.atSeconds)).toEqual([30, 60, 120, 300]);
    expect(cancellationOffered('DISPATCHED', DISPATCHED_AT, at(299), slow)).toBe(false);
    expect(cancellationOffered('DISPATCHED', DISPATCHED_AT, at(300), slow)).toBe(true);
  });
});
