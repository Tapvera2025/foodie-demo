/**
 * Turns a signed session token into a verified browse session.
 *
 * Lives in `identity` rather than `tenancy` because it is a credential
 * verifier, the same kind of thing as `staff.guard.ts` and `customer.guard.ts`
 * beside it. The session it names is a tenancy concept; deciding whether the
 * bearer is entitled to it is not.
 *
 * WHY THIS EXISTS
 *
 * `GET /qr/:token` used to resume the newest live `app_session` for the food
 * court, keyed on `food_court_id` and an unexpired `expires_at` and nothing
 * else. There was no credential binding a session to the phone that opened it,
 * so at one court with a four-hour TTL every customer who scanned the poster
 * was handed the same row — and once anyone verified an OTP on it, everybody
 * after them inherited that identity, saw their orders, and could order without
 * ever seeing an OTP prompt.
 *
 * That was a straight consequence of §2.1 moving the QR from the table to the
 * venue. Under the old model the table WAS the identity and resuming its
 * session was correct. When the token's scope widened to the whole hall the
 * resume rule's scope widened with it, and the unit test that covers it is
 * still called "resumes for the same table".
 *
 * The rule now: a session is resumed only by a client presenting the signed
 * token issued when that session was created. A session id on its own proves
 * nothing, and is no longer accepted as proof anywhere.
 */

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { AppError } from '../platform/errors.js';
import { authKeys } from './keys.js';
import { verifyToken } from './tokens.js';

export const SESSION_AUDIENCE = 'foodcourt-session';

/**
 * The header the token travels in.
 *
 * Not `Authorization` — that carries the customer token, and a request in the
 * authenticated window needs to present both. Two credentials answering two
 * different questions ("which browse session is this?" and "who are you?")
 * should not compete for one header.
 */
export const SESSION_HEADER = 'x-session-token';

export interface SessionPrincipal {
  readonly sessionId: string;
  readonly foodCourtId: string;
  /** Set once an OTP has been verified on this session. */
  readonly customerId: string | null;
}

export const SESSION = Symbol('SESSION_PRINCIPAL');

export interface RequestWithSession extends Request {
  [SESSION]?: SessionPrincipal;
}

/**
 * Verify a presented session token, or return null if none was presented.
 *
 * Used by the scan endpoint, where a token is optional: a first-time customer
 * has none and must be given one. A token that is present but invalid returns
 * null rather than throwing, so a stale token from a previous visit opens a
 * fresh session instead of a dead end the customer cannot navigate out of.
 */
export async function optionalSessionPrincipal(req: Request): Promise<SessionPrincipal | null> {
  const raw = req.header(SESSION_HEADER);
  if (!raw) return null;

  try {
    const claims = await verifyToken(authKeys(), raw, {
      audience: SESSION_AUDIENCE,
      expectType: 'session',
    });
    if (claims.typ !== 'session') return null;
    return { sessionId: claims.sub, foodCourtId: claims.fc, customerId: claims.cus };
  } catch {
    return null;
  }
}

/**
 * Requires a valid session token. For every endpoint that acts on a session
 * rather than opening one.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const principal = await optionalSessionPrincipal(req);

    if (!principal) {
      throw new AppError('SESSION_EXPIRED', 'Scan the code again to start a session.');
    }

    req[SESSION] = principal;
    return true;
  }
}

/** Reads what the guard attached. Throws if used on an unguarded route. */
export function sessionOf(req: RequestWithSession): SessionPrincipal {
  const p = req[SESSION];
  if (!p) throw new AppError('SESSION_EXPIRED', 'Scan the code again to start a session.');
  return p;
}
