/**
 * Password hashing for staff accounts.
 *
 * scrypt from `node:crypto`, not bcrypt or argon2 from npm. Both of those are
 * native addons that need compiling per platform, and this project has already
 * been bitten twice by platform-specific binaries — `dbmate` (errata E-003) and
 * the darwin-arm64 esbuild that stops the test suite running in a Linux
 * sandbox. scrypt is memory-hard, in the standard library, and was designed for
 * exactly this. The dependency that is not installed cannot fail to install.
 *
 * PRD SEC-04. Interface Specifications §2.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { AppError } from '../platform/errors.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^15 costs roughly 100ms and ~32MB per hash on a small server.
 *
 * Deliberately slow. A password database is stolen far more often than it is
 * used legitimately, and the whole value of a KDF is that the attacker pays
 * this cost for every guess. The tradeoff is bounded here: a kitchen tablet
 * logs in once a shift, so nobody experiences the 100ms twice.
 *
 * `maxmem` must be raised explicitly — Node's 32MB default is below what
 * N=2^15 needs, and scrypt fails with an unhelpful error rather than falling
 * back to something weaker. That silent-looking failure is why it is spelled
 * out rather than left to the default.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Versioned so the parameters can be raised later without invalidating every hash. */
const FORMAT = 'scrypt$1';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Length only, and a check against the handful of passwords that are always
 * tried first.
 *
 * No composition rules — no "must contain a symbol". They push people towards
 * `Password1!`, which is shorter in real entropy than four random words, and
 * NIST SP 800-63B advises against them for that reason. Length is what helps.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      'WEAK_PASSWORD',
      `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase is fine and easier to remember than a symbol-soup.`,
    );
  }
  if (password.length > 256) {
    // Not a security rule — a bound so nobody can make the server do scrypt
    // over a megabyte of input as a cheap denial of service.
    throw new AppError('WEAK_PASSWORD', 'That password is too long.');
  }
  const trivial = new Set([
    'password1234',
    'passwordpassword',
    '123456789012',
    'qwertyuiopas',
    'foodcourt123',
  ]);
  if (trivial.has(password.toLowerCase())) {
    throw new AppError('WEAK_PASSWORD', 'That password is too easy to guess.');
  }
}

/** Returns `scrypt$1$<salt-b64>$<hash-b64>`. Self-describing, so verify needs no config. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return `${FORMAT}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Constant-time comparison, and never throws on a malformed stored hash.
 *
 * A `!==` here would leak the length of the matching prefix through timing.
 * The effect is small over a network but it is free to avoid, and "free to
 * avoid" is the whole argument.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // No password set for this user. Still burn the time — see below.
    await scrypt(password, 'absent-user-salt', KEY_LENGTH, PARAMS);
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 4 || `${parts[0]}$${parts[1]}` !== FORMAT) return false;

  const salt = Buffer.from(parts[2]!, 'base64');
  const expected = Buffer.from(parts[3]!, 'base64');
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Spends the same time as a real verification, for users that do not exist.
 *
 * Without it, "no such email" returns in a millisecond and a real account
 * takes a hundred — which turns the login endpoint into an account-existence
 * oracle. Anyone can then enumerate which vendor staff have accounts, and that
 * list is the first thing a phishing campaign needs.
 */
export async function burnVerificationTime(): Promise<void> {
  await scrypt('not-a-real-password', randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
}
