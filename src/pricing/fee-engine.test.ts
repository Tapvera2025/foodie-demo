import { describe, it, expect } from 'vitest';
import {
  assertRuleValid,
  resolveRule,
  computeFee,
  computeFeeTax,
  type FeeRule,
} from './fee-engine.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';

function rule(over: Partial<FeeRule> = {}): FeeRule {
  return {
    id: 'r-1',
    scope: 'PLATFORM_DEFAULT',
    party: 'VENDOR',
    feeType: 'PERCENTAGE',
    rateBps: 300,
    minFloorPaise: paise(0),
    taxRateBps: 1800,
    allowedModes: ['PLATFORM_COLLECT'],
    version: 1,
    ...over,
  };
}

describe('rule validation at configuration time (FEE-05 / PAY-MODE-05)', () => {
  it('accepts a well-formed rule for a permitted mode', () => {
    expect(() => assertRuleValid(rule(), 'PLATFORM_COLLECT')).not.toThrow();
  });

  it('rejects a customer fee on a VENDOR_DIRECT vendor', () => {
    // The commonest misconfiguration. The platform is not in that payment
    // flow, so it cannot charge the customer anything. Caught in admin, not at
    // checkout in front of a customer.
    const customerFee = rule({ party: 'CUSTOMER', allowedModes: ['PLATFORM_COLLECT'] });
    try {
      assertRuleValid(customerFee, 'VENDOR_DIRECT');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('FEE_RULE_INVALID_FOR_MODE');
      expect((e as AppError).httpStatus).toBe(422);
    }
  });

  it('rejects a percentage rule with no rate', () => {
    // The key is omitted rather than set to undefined: exactOptionalPropertyTypes
    // makes an explicit undefined a type error, which is the point of the flag.
    const { rateBps: _omitted, ...noRate } = rule({ feeType: 'PERCENTAGE' });
    expect(() => assertRuleValid(noRate as FeeRule, 'PLATFORM_COLLECT')).toThrow(AppError);
  });

  it('rejects an out-of-range rate', () => {
    expect(() => assertRuleValid(rule({ rateBps: 10_001 }), 'PLATFORM_COLLECT')).toThrow(AppError);
    expect(() => assertRuleValid(rule({ rateBps: -1 }), 'PLATFORM_COLLECT')).toThrow(AppError);
    expect(() => assertRuleValid(rule({ rateBps: 12.5 }), 'PLATFORM_COLLECT')).toThrow(AppError);
  });

  it('rejects a flat rule with no amount', () => {
    const { amountPaise: _omitted, ...noAmount } = rule({
      feeType: 'FLAT_PER_ORDER',
      amountPaise: paise(500),
    });
    expect(() => assertRuleValid(noAmount as FeeRule, 'PLATFORM_COLLECT')).toThrow(AppError);
  });

  it('rejects a cap below the floor', () => {
    expect(() =>
      assertRuleValid(
        rule({ minFloorPaise: paise(500), maxCapPaise: paise(100) }),
        'PLATFORM_COLLECT',
      ),
    ).toThrow(AppError);
  });
});

describe('rule resolution — most specific wins', () => {
  const platformDefault = rule({ id: 'plat', scope: 'PLATFORM_DEFAULT', rateBps: 500 });
  const court = rule({ id: 'court', scope: 'FOOD_COURT', rateBps: 400 });
  const vendor = rule({ id: 'vendor', scope: 'VENDOR', rateBps: 300 });

  it('prefers vendor over court over platform default', () => {
    expect(resolveRule([platformDefault, court, vendor], 'VENDOR')?.id).toBe('vendor');
    expect(resolveRule([platformDefault, court], 'VENDOR')?.id).toBe('court');
    expect(resolveRule([platformDefault], 'VENDOR')?.id).toBe('plat');
  });

  it('breaks a tie at the same scope on the higher version', () => {
    const v1 = rule({ id: 'old', scope: 'VENDOR', version: 1 });
    const v2 = rule({ id: 'new', scope: 'VENDOR', version: 2 });
    expect(resolveRule([v1, v2], 'VENDOR')?.id).toBe('new');
    expect(resolveRule([v2, v1], 'VENDOR')?.id).toBe('new');
  });

  it('never returns a rule for a different party', () => {
    expect(resolveRule([vendor], 'CUSTOMER')).toBeUndefined();
    expect(resolveRule([], 'VENDOR')).toBeUndefined();
  });
});

describe('fee computation', () => {
  it('is zero when no rule applies', () => {
    expect(computeFee(undefined, paise(25_000))).toBe(0);
    expect(computeFeeTax(undefined, paise(25_000))).toBe(0);
  });

  it('computes a percentage of the base', () => {
    expect(computeFee(rule({ rateBps: 300 }), paise(25_000))).toBe(750);
  });

  it('computes a flat amount regardless of the base', () => {
    const flat = rule({ feeType: 'FLAT_PER_ORDER', amountPaise: paise(500) });
    expect(computeFee(flat, paise(25_000))).toBe(500);
    expect(computeFee(flat, paise(100_000))).toBe(500);
  });

  it('a monthly subscription contributes nothing per order', () => {
    // Billed separately. Treating it as a per-order charge would silently
    // multiply the vendor's bill by their order count.
    const sub = rule({ feeType: 'SUBSCRIPTION_MONTHLY', amountPaise: paise(300_000) });
    expect(computeFee(sub, paise(25_000))).toBe(0);
  });

  it('applies the minimum floor', () => {
    const withFloor = rule({ rateBps: 100, minFloorPaise: paise(500) });
    expect(computeFee(withFloor, paise(25_000))).toBe(500); // 1% = 250, floored to 500
  });

  it('applies the maximum cap', () => {
    const capped = rule({ rateBps: 1000, maxCapPaise: paise(1_000) });
    expect(computeFee(capped, paise(25_000))).toBe(1_000); // 10% = 2500, capped
  });

  it('computes tax on the fee at the rule rate, not the food rate', () => {
    expect(computeFeeTax(rule({ taxRateBps: 1800 }), paise(750))).toBe(135);
    expect(computeFeeTax(rule({ taxRateBps: 0 }), paise(750))).toBe(0);
  });

  it('handles a zero-rate rule without producing a floor artefact', () => {
    expect(computeFee(rule({ rateBps: 0 }), paise(25_000))).toBe(0);
  });
});
