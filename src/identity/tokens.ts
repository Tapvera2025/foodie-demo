/**
 * Token issuance and verification.
 *
 * Three principals, three token types, one issuer. Interface Specs §2.
 *
 *   Session (customer)  4 h    anonymous, one court + one table
 *   Device (KDS etc.)   30 d   scoped to exactly ONE vendor
 *   Staff               30 min roles embedded at issue time
 *
 * Revocation is a `token_version` counter compared against a claim, not a
 * distributed blocklist. Bumping the version on the user or device row kills
 * every token it issued (AUTH-05).
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '../platform/errors.js';
import type { Role } from './permissions.js';

export const ALG = 'EdDSA';
const ISSUER = 'tapvera-platform';

export type TokenType = 'session' | 'device' | 'staff';

export const TOKEN_TTL_SECONDS: Readonly<Record<TokenType, number>> = {
  session: 4 * 60 * 60,
  device: 30 * 24 * 60 * 60,
  staff: 30 * 60,
};

/** Interface Specs §2.1 — deliberately anonymous. No PII in claims. */
export interface SessionClaims {
  readonly typ: 'session';
  readonly sub: string;
  readonly fc: string;
  readonly tbl: string;
  readonly cus: string | null;
}

export interface DeviceClaims {
  readonly typ: 'device';
  readonly sub: string;
  readonly vnd: string | null;
  readonly fc: string;
  readonly knd: 'KDS_TABLET' | 'THERMAL_PRINTER' | 'DISPLAY_BOARD';
  readonly ver: number;
}

export interface StaffRoleClaim {
  readonly role: Role;
  readonly fc?: string;
  readonly vnd?: string;
}

export interface StaffClaims {
  readonly typ: 'staff';
  readonly sub: string;
  readonly rol: readonly StaffRoleClaim[];
  readonly ver: number;
}

export type Claims = SessionClaims | DeviceClaims | StaffClaims;

/**
 * Derived from jose's own signatures rather than a named export, because jose
 * has renamed its key type across major versions. This stays correct through
 * an upgrade.
 */
export type SigningKey = Parameters<SignJWT['sign']>[0];
export type VerificationKey = Parameters<typeof jwtVerify>[1];

export interface Keys {
  readonly privateKey: SigningKey;
  readonly publicKey: VerificationKey;
}

/** Clock skew tolerance. Interface Specs §2.3: 60 seconds, nothing larger. */
const CLOCK_TOLERANCE = '60s';

export async function issueToken(
  keys: Keys,
  claims: Claims,
  opts: { audience: string; now?: Date },
): Promise<string> {
  const ttl = TOKEN_TTL_SECONDS[claims.typ];
  const issuedAt = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);

  return new SignJWT({ ...claims } as unknown as JWTPayload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(opts.audience)
    .setSubject(claims.sub)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .setJti(crypto.randomUUID())
    .sign(keys.privateKey);
}

export interface VerifyOptions {
  readonly audience: string;
  readonly expectType: TokenType;
  /**
   * Current `token_version` from the database, for device and staff tokens.
   * A mismatch means the principal was revoked. AUTH-05.
   */
  readonly currentVersion?: number;
  readonly now?: Date;
}

export async function verifyToken(keys: Keys, token: string, opts: VerifyOptions): Promise<Claims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, keys.publicKey, {
      issuer: ISSUER,
      audience: opts.audience,
      clockTolerance: CLOCK_TOLERANCE,
      algorithms: [ALG],
      ...(opts.now !== undefined ? { currentDate: opts.now } : {}),
    });
    payload = result.payload;
  } catch (e) {
    throw new AppError('TOKEN_INVALID', e instanceof Error ? e.message : 'verification failed');
  }

  const typ = payload['typ'];
  if (typ !== opts.expectType) {
    // A device token must never be accepted on a staff endpoint, and vice
    // versa, even though both are validly signed by us.
    throw new AppError('TOKEN_WRONG_TYPE', `expected ${opts.expectType}, got ${String(typ)}`);
  }

  if (opts.currentVersion !== undefined) {
    const ver = payload['ver'];
    if (typeof ver !== 'number' || ver !== opts.currentVersion) {
      throw new AppError(
        'TOKEN_INVALID',
        `token_version mismatch: token=${String(ver)} current=${opts.currentVersion}`,
      );
    }
  }

  return payload as unknown as Claims;
}

/**
 * Device pairing codes. Single-use, 24 h, shown once (AUTH-03).
 *
 * Deliberately excludes I, O, 0 and 1 — these are read off a printed setup
 * sheet by someone standing in a kitchen.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(
  bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(8)),
): string {
  let out = '';
  for (const b of bytes) {
    out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  }
  return out.slice(0, 8);
}

export const PAIRING_CODE_TTL_SECONDS = 24 * 60 * 60;
