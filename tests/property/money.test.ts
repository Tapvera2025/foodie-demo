/**
 * Property tests for the money primitives.
 *
 * TDD §4.3 requires these. The ledger-balance property lands here too once the
 * pricing module exists in week 4 — this file is where it goes.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { paise, add, sub, applyBps, rupeesToPaise, formatINR } from '../../src/platform/money.js';

// Realistic order magnitudes: up to ₹1,00,000 in paise.
const arbPaise = fc.integer({ min: 0, max: 10_000_000 }).map((n) => paise(n));
const arbBps = fc.integer({ min: 0, max: 10_000 });

describe('money properties', () => {
  it('addition is associative', () => {
    fc.assert(
      fc.property(arbPaise, arbPaise, arbPaise, (a, b, c) => {
        expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
      }),
    );
  });

  it('add then sub is the identity', () => {
    fc.assert(
      fc.property(arbPaise, arbPaise, (a, b) => {
        expect(sub(add(a, b), b)).toBe(a);
      }),
    );
  });

  it('applyBps never exceeds the principal for rates <= 100%', () => {
    fc.assert(
      fc.property(arbPaise, arbBps, (amount, bps) => {
        expect(applyBps(amount, bps)).toBeLessThanOrEqual(amount);
      }),
    );
  });

  it('applyBps always returns an exact integer', () => {
    fc.assert(
      fc.property(arbPaise, arbBps, (amount, bps) => {
        expect(Number.isInteger(applyBps(amount, bps))).toBe(true);
      }),
    );
  });

  it('applyBps is monotonic in the rate', () => {
    fc.assert(
      fc.property(arbPaise, arbBps, arbBps, (amount, r1, r2) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1];
        expect(applyBps(amount, lo)).toBeLessThanOrEqual(applyBps(amount, hi));
      }),
    );
  });

  it('rounding residual is strictly less than one paisa', () => {
    // The guarantee that lets us allocate the residual to the platform and
    // still have the order balance. TDD §3.1.
    fc.assert(
      fc.property(arbPaise, arbBps, (amount, bps) => {
        const exact = (amount * bps) / 10_000;
        const rounded = applyBps(amount, bps);
        expect(Math.abs(rounded - exact)).toBeLessThanOrEqual(0.5);
      }),
    );
  });

  it('splitting a rate in two never loses more than one paisa in total', () => {
    fc.assert(
      fc.property(arbPaise, fc.integer({ min: 0, max: 5000 }), (amount, half) => {
        const whole = applyBps(amount, half * 2);
        const twice = add(applyBps(amount, half), applyBps(amount, half));
        expect(Math.abs(whole - twice)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('rupee round-trip is lossless to two decimals', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (n) => {
        const p = paise(n);
        const rupeeString = (n / 100).toFixed(2);
        expect(rupeesToPaise(rupeeString)).toBe(p);
      }),
    );
  });

  it('formatINR always parses back to the same value', () => {
    fc.assert(
      fc.property(arbPaise, (a) => {
        const formatted = formatINR(a).replace('₹', '').replace(/,/g, '');
        expect(rupeesToPaise(formatted)).toBe(a);
      }),
    );
  });
});
