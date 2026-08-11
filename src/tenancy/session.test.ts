import { describe, it, expect } from 'vitest';
import {
  createSession,
  touch,
  isExpired,
  assertResumable,
  attachCustomer,
  setActiveVendor,
  canStartNewOrder,
} from './session.js';
import { AppError } from '../platform/errors.js';

const NOW = new Date('2026-08-10T12:30:00Z');
const COURT = 'court-a';
const TABLE = 'table-a12';

const session = createSession({ id: 's-1', foodCourtId: COURT, courtTableId: TABLE, now: NOW });

describe('session creation (CUS-SES-01/02)', () => {
  it('is anonymous — no identity is collected before checkout', () => {
    // PRD §8.2: no OTP, and no customer record until a phone is captured.
    expect(session.customerId).toBeNull();
    expect(session.activeVendorId).toBeNull();
  });

  it('is scoped to one court and one table', () => {
    expect(session.foodCourtId).toBe(COURT);
    expect(session.courtTableId).toBe(TABLE);
  });
});

describe('resume on refresh or reconnect', () => {
  it('resumes for the same table', () => {
    expect(() =>
      assertResumable(session, { foodCourtId: COURT, courtTableId: TABLE }, NOW),
    ).not.toThrow();
  });

  it('refuses to walk a session to another table', () => {
    // Otherwise a replayed token moves a live session around the floor.
    expect(() =>
      assertResumable(session, { foodCourtId: COURT, courtTableId: 'table-b03' }, NOW),
    ).toThrow(AppError);
  });

  it('refuses to walk a session to another court', () => {
    expect(() =>
      assertResumable(session, { foodCourtId: 'court-b', courtTableId: TABLE }, NOW),
    ).toThrow(AppError);
  });

  it('refuses to resume an expired session', () => {
    const late = new Date(NOW.getTime() + 5 * 60 * 60_000);
    expect(() =>
      assertResumable(session, { foodCourtId: COURT, courtTableId: TABLE }, late),
    ).toThrow(AppError);
  });
});

describe('expiry', () => {
  it('slides forward on activity so a slow diner is not cut off', () => {
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const touched = touch(session, later);
    expect(touched.expiresAt.getTime()).toBeGreaterThan(session.expiresAt.getTime());
    expect(touched.lastSeenAt).toEqual(later);
  });

  it('does not revive an already expired session', () => {
    const late = new Date(NOW.getTime() + 5 * 60 * 60_000);
    expect(isExpired(session, late)).toBe(true);
    expect(() => touch(session, late)).toThrow(AppError);
  });
});

describe('session state', () => {
  it('attaches a customer at checkout', () => {
    expect(attachCustomer(session, 'cus-1').customerId).toBe('cus-1');
  });

  it('tracks and clears the active vendor', () => {
    const withVendor = setActiveVendor(session, 'vendor-a');
    expect(withVendor.activeVendorId).toBe('vendor-a');
    expect(setActiveVendor(withVendor, null).activeVendorId).toBeNull();
  });
});

describe('QR deactivated mid-session (CUS-SES-04)', () => {
  it('blocks new ordering once the table token is deactivated', () => {
    expect(canStartNewOrder({ tableTokenActive: false, sessionExpired: false })).toBe(false);
  });

  it('allows ordering while the token is live', () => {
    expect(canStartNewOrder({ tableTokenActive: true, sessionExpired: false })).toBe(true);
  });

  it('blocks once the session itself has expired', () => {
    expect(canStartNewOrder({ tableTokenActive: true, sessionExpired: true })).toBe(false);
  });
});
