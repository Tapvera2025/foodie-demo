import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUSES,
  ORDER_COMMANDS,
  ALLOWED_TRANSITIONS,
  COMMAND_SPECS,
  canTransition,
  assertTransitionAllowed,
  assertCommandAllowed,
  isTerminal,
  isRejectable,
  isPaid,
  isAwaitingAcknowledgement,
  type OrderStatus,
} from './state-machine.js';
import { PERMISSION_MATRIX, type Permission } from '../identity/permissions.js';
import { AppError } from '../platform/errors.js';

describe('the transition allow-list is exhaustive and closed (ORD-SM-01)', () => {
  it('every status has an entry', () => {
    for (const s of ORDER_STATUSES) {
      expect(ALLOWED_TRANSITIONS[s], `missing entry for ${s}`).toBeDefined();
    }
  });

  it('never names a status that does not exist', () => {
    const known = new Set<string>(ORDER_STATUSES);
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of tos) {
        expect(known.has(to), `${from} -> ${to} names an unknown status`).toBe(true);
      }
    }
  });

  it('enumerates every from/to pair and rejects the ones not listed', () => {
    // PRD ORD-SM-01: a unit test enumerates every pair; unlisted pairs are
    // rejected. 16 x 16 = 256 combinations, checked explicitly.
    let allowed = 0;
    let rejected = 0;
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (ALLOWED_TRANSITIONS[from].includes(to)) {
          expect(canTransition(from, to)).toBe(true);
          allowed++;
        } else {
          expect(canTransition(from, to)).toBe(false);
          expect(() => assertTransitionAllowed(from, to)).toThrow(AppError);
          rejected++;
        }
      }
    }
    expect(allowed + rejected).toBe(ORDER_STATUSES.length ** 2);
    expect(allowed).toBeGreaterThan(0);
  });

  it('no status transitions to itself', () => {
    for (const s of ORDER_STATUSES) {
      expect(canTransition(s, s), `${s} loops to itself`).toBe(false);
    }
  });

  it('an illegal transition throws INVALID_TRANSITION, never silently no-ops', () => {
    try {
      assertTransitionAllowed('COLLECTED', 'PREPARING');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_TRANSITION');
      expect((e as AppError).httpStatus).toBe(409);
    }
  });
});

describe('terminal states', () => {
  it('are exactly the four we expect', () => {
    const terminal = ORDER_STATUSES.filter(isTerminal);
    // PAYMENT_EXPIRED joins the list rather than folding into PAYMENT_FAILED.
    // Nothing was declined, so there is nothing to retry and nothing to explain
    // — but it is a different number, and the difference is how many customers
    // walked away mid-payment. PRD §7.2.
    expect([...terminal].sort()).toEqual([
      'COLLECTED',
      'PAYMENT_EXPIRED',
      'PAYMENT_FAILED',
      'REFUNDED',
    ]);
  });

  it('cannot be left', () => {
    for (const s of ORDER_STATUSES.filter(isTerminal)) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(s, to)).toBe(false);
      }
    }
  });
});

describe('the happy path', () => {
  it('walks CREATED to COLLECTED without an accept step', () => {
    // PRD §9: the vendor never accepts. ACKNOWLEDGED is a machine event.
    const path: OrderStatus[] = [
      'CREATED',
      'PAYMENT_PENDING',
      'PAYMENT_CONFIRMED',
      'DISPATCHED',
      'ACKNOWLEDGED',
      'PREPARING',
      'READY',
      'COLLECTED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('lets a fast item skip preparing', () => {
    // A stall selling packaged drinks goes straight to ready.
    expect(canTransition('ACKNOWLEDGED', 'READY')).toBe(true);
  });

  it('never dispatches before payment is confirmed', () => {
    expect(canTransition('CREATED', 'DISPATCHED')).toBe(false);
    expect(canTransition('PAYMENT_PENDING', 'DISPATCHED')).toBe(false);
  });
});

describe('rejection window (KDS-REJ-01)', () => {
  it('is open from dispatched through preparing', () => {
    expect(isRejectable('DISPATCHED')).toBe(true);
    expect(isRejectable('ACKNOWLEDGED')).toBe(true);
    expect(isRejectable('PREPARING')).toBe(true);
  });

  it('closes once the food is ready', () => {
    expect(isRejectable('READY')).toBe(false);
    expect(isRejectable('COLLECTED')).toBe(false);
  });

  it('is not open before the customer has paid', () => {
    expect(isRejectable('CREATED')).toBe(false);
    expect(isRejectable('PAYMENT_PENDING')).toBe(false);
  });
});

describe('refund paths', () => {
  it('rejection and cancellation both lead to a refund', () => {
    expect(canTransition('REJECTED', 'REFUND_PENDING')).toBe(true);
    expect(canTransition('CANCELLED', 'REFUND_PENDING')).toBe(true);
  });

  it('a failed refund can be retried and never dead-ends', () => {
    expect(canTransition('REFUND_FAILED', 'REFUND_PENDING')).toBe(true);
    expect(canTransition('REFUND_FAILED', 'RECONCILIATION_REQUIRED')).toBe(true);
    expect(isTerminal('REFUND_FAILED')).toBe(false);
  });

  it('reconciliation can always be resolved somewhere', () => {
    expect(ALLOWED_TRANSITIONS.RECONCILIATION_REQUIRED.length).toBeGreaterThan(0);
  });
});

describe('isPaid()', () => {
  it('is false only before money is committed', () => {
    expect(isPaid('CREATED')).toBe(false);
    expect(isPaid('PAYMENT_PENDING')).toBe(false);
    expect(isPaid('PAYMENT_FAILED')).toBe(false);
  });

  it('is true from payment confirmation onwards, including rejected orders', () => {
    // A rejected order has still taken the customer's money.
    expect(isPaid('PAYMENT_CONFIRMED')).toBe(true);
    expect(isPaid('REJECTED')).toBe(true);
    expect(isPaid('REFUNDED')).toBe(true);
  });
});

describe('the state the escalation ladder watches', () => {
  it('is DISPATCHED and nothing else', () => {
    // A paid order that nobody has confirmed the kitchen received. PRD §11.4.
    for (const s of ORDER_STATUSES) {
      expect(isAwaitingAcknowledgement(s)).toBe(s === 'DISPATCHED');
    }
  });
});

describe('command catalogue', () => {
  it('every command has a spec', () => {
    for (const c of ORDER_COMMANDS) {
      expect(COMMAND_SPECS[c], `missing spec for ${c}`).toBeDefined();
    }
  });

  it('every permission a command names exists in the RBAC matrix (RBAC-02)', () => {
    for (const c of ORDER_COMMANDS) {
      const p = COMMAND_SPECS[c].permission;
      if (p !== undefined) {
        expect(
          PERMISSION_MATRIX[p as Permission],
          `${c} names unknown permission ${p}`,
        ).toBeDefined();
      }
    }
  });

  it('acknowledge carries the device-only permission', () => {
    expect(COMMAND_SPECS.acknowledge.permission).toBe('order.acknowledge');
    expect(Object.keys(PERMISSION_MATRIX['order.acknowledge'])).toEqual(['DEVICE']);
  });

  it('rejection and forced actions require a reason', () => {
    expect(COMMAND_SPECS.reject.requiresReason).toBe(true);
    expect(COMMAND_SPECS.forceCancel.requiresReason).toBe(true);
    expect(COMMAND_SPECS.flagReconciliation.requiresReason).toBe(true);
  });

  it('routine vendor actions do not', () => {
    expect(COMMAND_SPECS.markReady.requiresReason).toBe(false);
    expect(COMMAND_SPECS.acknowledge.requiresReason).toBe(false);
  });
});

describe('assertCommandAllowed()', () => {
  it('accepts a legal command and returns the target state', () => {
    expect(assertCommandAllowed({ command: 'markReady', from: 'PREPARING' })).toBe('READY');
  });

  it('refuses a command that is illegal from the current state', () => {
    expect(() => assertCommandAllowed({ command: 'markReady', from: 'CREATED' })).toThrow(AppError);
  });

  it('refuses a rejection with no reason', () => {
    expect(() => assertCommandAllowed({ command: 'reject', from: 'PREPARING' })).toThrow(AppError);
    expect(() =>
      assertCommandAllowed({ command: 'reject', from: 'PREPARING', reason: '   ' }),
    ).toThrow(AppError);
    expect(
      assertCommandAllowed({ command: 'reject', from: 'PREPARING', reason: 'out of stock' }),
    ).toBe('REJECTED');
  });

  it('lets createOrder run with no prior state', () => {
    expect(assertCommandAllowed({ command: 'createOrder', from: 'CREATED' })).toBe('CREATED');
  });
});
