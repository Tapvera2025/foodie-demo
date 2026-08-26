/**
 * One-time codes, and the channel that delivers them.
 *
 * DR-0001 and PRD §11.2. The prompt appears at add-to-cart: the customer has
 * expressed intent and invested almost nothing, so the interruption costs one
 * item's worth of momentum rather than a full basket's.
 *
 * This module is the pure half — generation, hashing, phone normalisation and
 * the verify decision — so all of it can be tested without a database or a
 * network. The persistence half is `customer-auth.controller.ts`.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';

export const OTP_LENGTH = 6;

// =============================================================================
// Phone numbers
// =============================================================================

/**
 * India-first normalisation to E.164.
 *
 * "9876543210", "+91 98765 43210", "09876543210" and "919876543210" are one
 * customer and four rows if this is left to call sites. It happens once, here,
 * and the database refuses anything that did not come through it
 * (`customer_phone_e164`).
 *
 * Deliberately conservative: a 10-digit number is assumed Indian and nothing
 * else is guessed. Silently assigning a country code to an ambiguous number is
 * how an OTP goes to a stranger in another country.
 */
export function normalisePhone(raw: string, defaultCountry = '91'): string {
  const digits = raw.replace(/[\s\-()]/g, '');

  const e164 = digits.startsWith('+')
    ? digits
    : /^0\d{10}$/.test(digits)
      ? `+${defaultCountry}${digits.slice(1)}` // 0XXXXXXXXXX, the STD-dialling habit
      : /^\d{10}$/.test(digits)
        ? `+${defaultCountry}${digits}`
        : /^91\d{10}$/.test(digits)
          ? `+${digits}`
          : null;

  if (e164 === null || !/^\+[1-9][0-9]{7,14}$/.test(e164)) {
    throw new AppError('INVALID_CREDENTIALS', 'That does not look like a mobile number.');
  }
  return e164;
}

/** For logs and screens. `+919876543210` becomes `+91 ***** 43210`. */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return '*****';
  return `${e164.slice(0, 3)} ***** ${e164.slice(-5)}`;
}

// =============================================================================
// The code
// =============================================================================

/**
 * Six digits, uniformly distributed, from a CSPRNG.
 *
 * `randomInt` rather than `Math.random()` and rather than
 * `randomBytes % 1000000` — the modulo is biased towards low values, and a
 * six-digit space is small enough that the bias is worth having an opinion
 * about. Leading zeros are preserved: "012345" is a valid code and a version
 * that dropped the zero would produce five-digit codes about a tenth of the
 * time, which is both weaker and confusing to type.
 */
export function generateOtp(rng: (max: number) => number = (m) => randomInt(m)): string {
  return String(rng(10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * HMAC-SHA-256 under a server-side pepper. NOT scrypt, and that is deliberate.
 *
 * A six-digit code has 10^6 possibilities. Any unkeyed hash — including a slow
 * one — is enumerable offline by whoever reads the table: at 100ms per guess a
 * single code falls in under a day, and an attacker who has the table has all
 * of them. Cost factors do not fix a keyspace this small.
 *
 * A keyed hash does. Without the pepper the column is useless; with the pepper
 * the attacker already owns the process. This is the one place in the system
 * where a fast hash is the right answer and a slow one is theatre — the
 * opposite of `password.ts`, where the secret is the user's and scrypt is
 * exactly right.
 *
 * The phone number is bound into the MAC so a code hash cannot be replayed
 * against a different number.
 */
export function hashOtp(code: string, phone: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${phone}:${code}`).digest('base64');
}

/** Constant-time. A length check first, because timingSafeEqual throws on a mismatch. */
export function otpMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// =============================================================================
// The verify decision
// =============================================================================

export interface OtpRecord {
  readonly codeHash: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly supersededAt: Date | null;
}

export type OtpVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'EXPIRED' | 'USED' | 'SUPERSEDED' | 'WRONG' | 'LOCKED' };

/**
 * Pure, so every branch is testable and none of them can be reordered by
 * accident. The order matters: a locked record must not leak whether the code
 * was right, and an expired one must not consume an attempt.
 */
export function verifyOtp(
  record: OtpRecord,
  code: string,
  phone: string,
  pepper: string,
  now: Date,
): OtpVerdict {
  if (record.consumedAt !== null) return { ok: false, reason: 'USED' };
  if (record.supersededAt !== null) return { ok: false, reason: 'SUPERSEDED' };
  if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };

  // Checked BEFORE comparing. Comparing first would let an attacker who has
  // exhausted their attempts still learn, from the response time or from a
  // careless branch, whether their last guess was right.
  if (record.attempts >= record.maxAttempts) return { ok: false, reason: 'LOCKED' };

  return otpMatches(hashOtp(code, phone, pepper), record.codeHash)
    ? { ok: true }
    : { ok: false, reason: 'WRONG' };
}

// =============================================================================
// Delivery
// =============================================================================

export type OtpChannelName = 'console' | 'sms' | 'whatsapp';

export interface DeliveryRequest {
  readonly phone: string;
  readonly code: string;
  readonly ttlSeconds: number;
  readonly correlationId: string;
}

export interface OtpChannel {
  readonly name: 'CONSOLE' | 'SMS' | 'WHATSAPP';
  send(req: DeliveryRequest): Promise<void>;
}

/**
 * Development delivery: the code goes to the log.
 *
 * This exists because DLT registration is calendar-bound and blocks orders
 * entirely (PRD §19 decision 1). Waiting for it before building anything would
 * idle the whole customer path for weeks; building against a channel interface
 * means the registration, when it lands, is one adapter and a config change.
 *
 * It refuses to run in production. A console channel there would mean every
 * customer's code is in the application log and none of them ever receives one
 * — a total outage that looks, from the server's side, like everything working.
 */
export class ConsoleOtpChannel implements OtpChannel {
  readonly name = 'CONSOLE' as const;

  /**
   * The last code this process issued, held in memory so a development UI can
   * show it instead of making somebody grep four interleaved log streams.
   *
   * WHY THIS EXISTS RATHER THAN READING IT BACK FROM THE DATABASE
   *
   * It cannot be read back. `customer_otp.code_hash` is an HMAC under a server
   * pepper and the plaintext is never stored — which is the correct design and
   * is exactly why this hook is needed. The code lives only in the process that
   * generated it, only in development, and only on the channel that already
   * refuses to construct in production.
   *
   * Static, because the channel is constructed once per process and the dev
   * endpoint needs to reach it without threading a reference through Nest.
   */
  static lastIssued: { phone: string; code: string; at: Date } | null = null;

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error(
        'OTP_CHANNEL=console in production. Codes would be written to the log and never ' +
          'delivered. Complete DLT registration (PRD §19 decision 1) and set OTP_CHANNEL=sms.',
      );
    }
  }

  async send(req: DeliveryRequest): Promise<void> {
    ConsoleOtpChannel.lastIssued = { phone: req.phone, code: req.code, at: new Date() };

    // Logged at warn so it is visible at default levels — the developer needs
    // to read it, and info is where it would be buried.
    log().warn(
      { event: 'otp_console_delivery', phone: maskPhone(req.phone), code: req.code },
      `DEV ONLY — OTP for ${maskPhone(req.phone)} is ${req.code}`,
    );
  }
}

/**
 * Placeholder for the real thing. Constructing it fails, loudly and with the
 * reason.
 *
 * An empty implementation that returned successfully would be the worst
 * possible version of this: every customer would be told a code had been sent,
 * none would arrive, and the logs would show a clean success rate. PRD §2.2.
 */
export class UnregisteredSmsChannel implements OtpChannel {
  readonly name = 'SMS' as const;

  constructor() {
    throw new Error(
      'OTP_CHANNEL=sms but no DLT-registered sender is configured. India requires DLT ' +
        'registration of the entity, header and every template before transactional SMS is ' +
        'delivered. This is calendar-bound and blocks order placement entirely — PRD §19 ' +
        'decision 1. Until it completes, OTP_CHANNEL=console is the only working setting.',
    );
  }

  async send(): Promise<void> {
    throw new AppError('INTERNAL', 'no SMS channel');
  }
}

export function createOtpChannel(name: OtpChannelName, nodeEnv: string): OtpChannel {
  switch (name) {
    case 'console':
      return new ConsoleOtpChannel(nodeEnv);
    case 'sms':
    case 'whatsapp':
      return new UnregisteredSmsChannel();
  }
}
