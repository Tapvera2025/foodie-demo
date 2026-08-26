import { describe, it, expect } from 'vitest';

import { AppError } from '../platform/errors.js';
import {
  generateOtp,
  hashOtp,
  maskPhone,
  normalisePhone,
  OTP_LENGTH,
  verifyOtp,
  type OtpRecord,
} from './otp.js';

const PEPPER = 'test-pepper';
const NOW = new Date('2026-08-17T12:00:00Z');
const PHONE = '+919876543210';

function record(over: Partial<OtpRecord> = {}): OtpRecord {
  return {
    codeHash: hashOtp('123456', PHONE, PEPPER),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(NOW.getTime() + 300_000),
    consumedAt: null,
    supersededAt: null,
    ...over,
  };
}

describe('phone normalisation', () => {
  it('treats the four ways Indians write one number as one number', () => {
    // The whole reason this function exists. Four rows for one customer means
    // the ready notification, the refund and the support lookup each find a
    // different one.
    for (const written of ['9876543210', '+919876543210', '+91 98765 43210', '09876543210']) {
      expect(normalisePhone(written), written).toBe(PHONE);
    }
  });

  it('keeps an explicit country code that is not India', () => {
    expect(normalisePhone('+14155552671')).toBe('+14155552671');
  });

  it('refuses an ambiguous number rather than guessing a country', () => {
    // Guessing here sends somebody's OTP to a stranger abroad.
    expect(() => normalisePhone('12345')).toThrow(AppError);
    expect(() => normalisePhone('98765432101234567')).toThrow(AppError);
    expect(() => normalisePhone('not a phone')).toThrow(AppError);
  });

  it('masks for logs without losing enough to identify a complaint', () => {
    expect(maskPhone(PHONE)).toBe('+91 ***** 43210');
    expect(maskPhone(PHONE)).not.toContain('98765');
  });
});

describe('code generation', () => {
  it('is always six characters, including when the number is small', () => {
    // A version that dropped the leading zero would emit five-digit codes about
    // a tenth of the time: weaker, and confusing to type into a six-box field.
    expect(generateOtp(() => 42)).toBe('000042');
    expect(generateOtp(() => 0)).toBe('000000');
    expect(generateOtp(() => 999_999)).toBe('999999');
  });

  it('draws from the full six-digit space', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOtp()));
    // Two hundred draws from 10^6 colliding more than a handful of times would
    // mean the generator is not doing what it claims.
    expect(seen.size).toBeGreaterThan(190);
    for (const c of seen) expect(c).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
  });
});

describe('hashing', () => {
  it('binds the code to the phone number', () => {
    // Otherwise a hash captured for one number is replayable against another.
    expect(hashOtp('123456', '+919876543210', PEPPER)).not.toBe(
      hashOtp('123456', '+919999999999', PEPPER),
    );
  });

  it('is useless without the pepper', () => {
    expect(hashOtp('123456', PHONE, 'a')).not.toBe(hashOtp('123456', PHONE, 'b'));
  });

  it('never stores the code itself', () => {
    expect(hashOtp('123456', PHONE, PEPPER)).not.toContain('123456');
  });
});

describe('verification', () => {
  it('accepts the right code', () => {
    expect(verifyOtp(record(), '123456', PHONE, PEPPER, NOW)).toEqual({ ok: true });
  });

  it('rejects the wrong code', () => {
    expect(verifyOtp(record(), '654321', PHONE, PEPPER, NOW)).toEqual({
      ok: false,
      reason: 'WRONG',
    });
  });

  it('rejects a code that has already been used', () => {
    const r = record({ consumedAt: NOW });
    expect(verifyOtp(r, '123456', PHONE, PEPPER, NOW).ok).toBe(false);
  });

  it('rejects a code that a resend replaced', () => {
    // Requesting a new code must kill the old one, or both work and the window
    // in which an overheard code is useful doubles with every resend.
    const r = record({ supersededAt: NOW });
    expect(verifyOtp(r, '123456', PHONE, PEPPER, NOW)).toEqual({
      ok: false,
      reason: 'SUPERSEDED',
    });
  });

  it('rejects an expired code even when it is the right one', () => {
    const r = record({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(verifyOtp(r, '123456', PHONE, PEPPER, NOW)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('locks out before comparing, not after', () => {
    // The ordering is the test. Comparing first would let someone who has
    // exhausted their attempts still learn whether the last guess was right.
    const r = record({ attempts: 5, maxAttempts: 5 });
    expect(verifyOtp(r, '123456', PHONE, PEPPER, NOW)).toEqual({ ok: false, reason: 'LOCKED' });
  });

  it('does not accept a code issued for a different number', () => {
    expect(verifyOtp(record(), '123456', '+919999999999', PEPPER, NOW).ok).toBe(false);
  });

  it('does not accept a code verified under a different pepper', () => {
    expect(verifyOtp(record(), '123456', PHONE, 'other-pepper', NOW).ok).toBe(false);
  });
});
