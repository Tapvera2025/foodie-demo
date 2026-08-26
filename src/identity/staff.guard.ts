/**
 * Turns a bearer token into a verified staff principal.
 *
 * Verification only — it does NOT decide what the principal may do. That is
 * `rbac.decide`, called per endpoint with the specific permission required.
 * Conflating the two is how a guard ends up meaning "logged in" and every
 * authenticated user quietly gains access to everything.
 */

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

import { setActor } from '../platform/correlation.js';
import type { ActorType } from '../platform/correlation.js';
import { AppError } from '../platform/errors.js';
import { authKeys } from './keys.js';
import { STAFF_AUDIENCE } from './auth.controller.js';
import { verifyToken, type StaffClaims } from './tokens.js';

export interface StaffPrincipal {
  readonly userId: string;
  readonly roles: StaffClaims['rol'];
}

/** Attached to the request so controllers can read it without re-verifying. */
export const STAFF = Symbol('STAFF_PRINCIPAL');

export interface RequestWithStaff extends Request {
  [STAFF]?: StaffPrincipal;
}

@Injectable()
export class StaffGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithStaff>();

    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('TOKEN_INVALID', 'Sign in to continue.');
    }

    const claims = await verifyToken(authKeys(), header.slice('Bearer '.length), {
      audience: STAFF_AUDIENCE,
      expectType: 'staff',
    });

    // verifyToken already enforces `typ`, but narrowing here means the cast
    // below is checked rather than asserted.
    if (claims.typ !== 'staff') {
      throw new AppError('TOKEN_WRONG_TYPE', 'Wrong kind of token for this endpoint.');
    }

    req[STAFF] = { userId: claims.sub, roles: claims.rol };
    setActor(actorTypeFor(claims.rol), claims.sub);
    return true;
  }
}

/**
 * Which kind of actor a staff principal is, for the audit log.
 *
 * Most-privileged wins, because that is the authority the action was taken
 * under. A user holding both MANAGER and VENDOR_OPERATOR who force-cancels an
 * order did it as a manager, and an audit row saying VENDOR_USER would
 * understate what happened.
 */
function actorTypeFor(roles: StaffClaims['rol']): ActorType {
  const has = (r: string): boolean => roles.some((x) => x.role === r);
  if (has('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (has('PLATFORM_FINANCE')) return 'PLATFORM_FINANCE';
  if (has('PLATFORM_OPS')) return 'PLATFORM_OPS';
  if (has('MANAGER') || has('COURT_OPERATOR')) return 'MANAGER';
  return 'VENDOR_USER';
}

/** Reads what the guard attached. Throws if used on an unguarded route. */
export function staffOf(req: RequestWithStaff): StaffPrincipal {
  const p = req[STAFF];
  if (!p) throw new AppError('TOKEN_INVALID', 'Sign in to continue.');
  return p;
}

/**
 * The vendor this principal may act for, or null.
 *
 * A KDS user has exactly one vendor. A manager has a food court and no vendor,
 * and must not be able to work a kitchen queue by guessing an id — so this
 * returns null for them rather than "any vendor in your court".
 */
export function vendorScopeOf(p: StaffPrincipal): string | null {
  // Both vendor roles work a queue; VENDOR_OWNER additionally sees settlement,
  // which is checked per-endpoint by rbac.decide rather than here.
  const kitchen = p.roles.find(
    (r) => (r.role === 'VENDOR_OPERATOR' || r.role === 'VENDOR_OWNER') && r.vnd,
  );
  return kitchen?.vnd ?? null;
}
