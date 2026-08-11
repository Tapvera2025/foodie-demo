/**
 * Customer sessions.
 *
 * PRD CUS-SES-01..04. A session is scoped to one court and one table, survives
 * refresh and reconnection, requires no login, and cannot be re-scoped to a
 * different table by anything the client sends.
 */

import { AppError } from '../platform/errors.js';

export const DEFAULT_SESSION_TTL_MINUTES = 4 * 60;

export interface Session {
  readonly id: string;
  readonly foodCourtId: string;
  readonly courtTableId: string;
  /** Null until a phone is captured at checkout. PRD §8.2 — no OTP. */
  readonly customerId: string | null;
  readonly activeVendorId: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export function createSession(input: {
  id: string;
  foodCourtId: string;
  courtTableId: string;
  now: Date;
  ttlMinutes?: number;
}): Session {
  const ttl = input.ttlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
  return {
    id: input.id,
    foodCourtId: input.foodCourtId,
    courtTableId: input.courtTableId,
    customerId: null,
    activeVendorId: null,
    createdAt: input.now,
    lastSeenAt: input.now,
    expiresAt: new Date(input.now.getTime() + ttl * 60_000),
  };
}

export function isExpired(session: Session, now: Date): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

/**
 * Sliding expiry on activity, so a slow diner is not logged out mid-order.
 * A session that has already expired is not revived — the customer re-scans.
 */
export function touch(
  session: Session,
  now: Date,
  ttlMinutes = DEFAULT_SESSION_TTL_MINUTES,
): Session {
  if (isExpired(session, now)) {
    throw new AppError('SESSION_EXPIRED', 'session expired');
  }
  return {
    ...session,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
  };
}

/**
 * Resume on refresh or reconnect (CUS-SES-01).
 *
 * The QR token the client presents must resolve to the SAME table the session
 * was created for. Otherwise a session could be walked from table to table, or
 * to another court entirely, by replaying a token.
 */
export function assertResumable(
  session: Session,
  presented: { foodCourtId: string; courtTableId: string },
  now: Date,
): void {
  if (isExpired(session, now)) {
    throw new AppError('SESSION_EXPIRED', 'session expired');
  }
  if (
    session.foodCourtId !== presented.foodCourtId ||
    session.courtTableId !== presented.courtTableId
  ) {
    throw new AppError('SESSION_EXPIRED', 'session does not belong to this table');
  }
}

export function attachCustomer(session: Session, customerId: string): Session {
  return { ...session, customerId };
}

export function setActiveVendor(session: Session, vendorId: string | null): Session {
  return { ...session, activeVendorId: vendorId };
}

/**
 * PRD CUS-SES-04: a QR deactivated mid-session does not kill an active paid
 * order, but it does stop new ordering.
 *
 * The caller supplies whether the table's token is still active and whether the
 * session has an order in flight; this keeps the rule in one readable place
 * rather than scattered across controllers.
 */
export function canStartNewOrder(input: {
  tableTokenActive: boolean;
  sessionExpired: boolean;
}): boolean {
  return input.tableTokenActive && !input.sessionExpired;
}
