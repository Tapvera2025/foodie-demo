import { describe, it, expect } from 'vitest';

import { isAppError } from '../platform/errors.js';
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
} from './password.js';

const GOOD = 'correct horse battery staple';

describe('hashing', () => {
  it('accepts the password it just hashed', async () => {
    expect(await verifyPassword(GOOD, await hashPassword(GOOD))).toBe(true);
  });

  it('rejects a wrong password', async () => {
    expect(await verifyPassword('correct horse battery stapl', await hashPassword(GOOD))).toBe(
      false,
    );
  });

  it('produces a different hash every time for the same password', async () => {
    // Same password, different salt. Without this, two staff with the same
    // password have identical rows and a stolen dump reveals that instantly.
    expect(await hashPassword(GOOD)).not.toBe(await hashPassword(GOOD));
  });

  it('embeds its own parameters so verification needs no config', async () => {
    expect(await hashPassword(GOOD)).toMatch(/^scrypt\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });
});

describe('malformed stored hashes are refused, never crashed on', () => {
  // A migration bug or a truncated column must fail the login, not 500 the
  // endpoint — a stack trace here would be one on the auth path.
  for (const [name, stored] of [
    ['empty', ''],
    ['null', null],
    ['not our format', 'bcrypt$2b$10$abcdef'],
    ['truncated', 'scrypt$1$onlysalt'],
    ['wrong version', 'scrypt$9$c2FsdA==$aGFzaA=='],
    ['garbage', 'nonsense'],
  ] as const) {
    it(`refuses a ${name} hash`, async () => {
      await expect(verifyPassword(GOOD, stored)).resolves.toBe(false);
    });
  }
});

describe('password policy', () => {
  it(`requires ${MIN_PASSWORD_LENGTH} characters`, () => {
    try {
      assertPasswordAcceptable('short');
      throw new Error('expected a refusal');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('WEAK_PASSWORD');
    }
  });

  it('accepts a long passphrase with no symbols or digits', () => {
    // The point of dropping composition rules. This is stronger than
    // `Passw0rd!` and a kitchen manager can actually remember it.
    expect(() => assertPasswordAcceptable('the wok is very hot today')).not.toThrow();
  });

  it('rejects the obvious guesses even at full length', () => {
    expect(() => assertPasswordAcceptable('passwordpassword')).toThrow();
  });

  it('bounds the input so scrypt cannot be used as a denial of service', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(300))).toThrow();
  });
});
