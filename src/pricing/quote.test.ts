import { describe, it, expect } from 'vitest';
import { computeQuote, assertBalances, distributionTotal, platformRevenue } from './quote.js';
import type { FeeRule, TaxModel } from './fee-engine.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';

/* The TDD §4.2 worked example.
   ₹250 of food, 5% food GST, 3% vendor commission, 18% GST on commission,
   1% operator share, ₹5 customer fee. */

const FOOD = paise(25_000);

const line = { lineTotalPaise: FOOD, taxRateBps: 500 };

const customerFee: FeeRule = {
  id: 'r-cust',
  scope: 'PLATFORM_DEFAULT',
  party: 'CUSTOMER',
  feeType: 'FLAT_PER_ORDER',
  amountPaise: paise(500),
  minFloorPaise: paise(0),
  taxRateBps: 1800,
  allowedModes: ['PLATFORM_COLLECT'],
  version: 1,
};

const vendorCommission: FeeRule = {
  id: 'r-vendor',
  scope: 'VENDOR',
  party: 'VENDOR',
  feeType: 'PERCENTAGE',
  rateBps: 300,
  minFloorPaise: paise(0),
  taxRateBps: 1800,
  allowedModes: ['PLATFORM_COLLECT', 'VENDOR_DIRECT'],
  version: 1,
};

const operatorShare: FeeRule = {
  id: 'r-operator',
  scope: 'FOOD_COURT',
  party: 'OPERATOR',
  feeType: 'PERCENTAGE',
  rateBps: 100,
  minFloorPaise: paise(0),
  taxRateBps: 1800,
  allowedModes: ['PLATFORM_COLLECT'],
  version: 1,
};

const RULES = [customerFee, vendorCommission, operatorShare];

const applies: TaxModel = { section9_5Applies: true, feeGstBps: 1800 };
const doesNot: TaxModel = { section9_5Applies: false, feeGstBps: 1800 };

describe('TDD §4.2 worked example — the week 4 gate', () => {
  it('reproduces the s.9(5) APPLIES column to the paisa', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });

    expect(q.subtotalPaise).toBe(25_000);
    expect(q.foodTaxPaise).toBe(1_250);
    expect(q.customerFeePaise).toBe(500);
    expect(q.customerFeeTaxPaise).toBe(90);
    expect(q.grossPayablePaise).toBe(26_840);

    const d = q.distribution;
    expect(d.vendorCommissionPaise).toBe(750);
    expect(d.vendorCommissionTaxPaise).toBe(135);
    expect(d.operatorSharePaise).toBe(250);
    expect(d.operatorShareTaxPaise).toBe(45);
    expect(d.platformTaxReservePaise).toBe(1_250);
    expect(d.vendorNetPaise).toBe(23_820);

    // Verify by hand, as the document does:
    // 23,820 + 1,250 + 750 + 135 + 250 + 45 + 500 + 90 = 26,840
    expect(distributionTotal(d)).toBe(26_840);
    expect(() => assertBalances(q)).not.toThrow();
  });

  it('reproduces the s.9(5) DOES NOT APPLY column to the paisa', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: doesNot,
      settlementMode: 'PLATFORM_COLLECT',
    });

    // Customer pays exactly the same either way.
    expect(q.grossPayablePaise).toBe(26_840);

    const d = q.distribution;
    // Commission base is now food + GST = 26,250.
    expect(d.vendorCommissionPaise).toBe(788);
    expect(d.vendorCommissionTaxPaise).toBe(142);
    expect(d.operatorSharePaise).toBe(263);
    expect(d.operatorShareTaxPaise).toBe(47);
    expect(d.platformTaxReservePaise).toBe(0);
    expect(d.vendorNetPaise).toBe(25_010);

    expect(distributionTotal(d)).toBe(26_840);
  });

  it('the determination moves the vendor payout by ₹11.90 on a ₹250 order', () => {
    // Against a commission of ₹7.50. This is PRD §4.7 as an executable fact:
    // build for the wrong column and every order loses about ₹4.40.
    const a = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });
    const b = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: doesNot,
      settlementMode: 'PLATFORM_COLLECT',
    });

    expect(b.distribution.vendorNetPaise - a.distribution.vendorNetPaise).toBe(1_190);
    expect(a.subtotalPaise * 0.03).toBeCloseTo(750, 0);
  });
});

describe('settlement mode changes what the platform may charge', () => {
  it('charges no customer fee in VENDOR_DIRECT', () => {
    // The platform is not in that payment flow, so it cannot charge one.
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'VENDOR_DIRECT',
    });
    expect(q.customerFeePaise).toBe(0);
    expect(q.customerFeeTaxPaise).toBe(0);
    expect(q.grossPayablePaise).toBe(26_250);
    expect(distributionTotal(q.distribution)).toBe(26_250);
  });

  it('still balances with no rules at all', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: [],
      taxModel: doesNot,
      settlementMode: 'PLATFORM_COLLECT',
    });
    expect(q.distribution.vendorNetPaise).toBe(26_250);
    expect(distributionTotal(q.distribution)).toBe(q.grossPayablePaise);
  });
});

describe('per-line tax, not tax on the subtotal', () => {
  it('taxes each line separately', () => {
    // Three lines at 5% of 3333 = 166.65 -> 167 each = 501.
    // Tax on the summed 9999 would be 500. The difference is why this matters.
    const lines = [
      { lineTotalPaise: paise(3_333), taxRateBps: 500 },
      { lineTotalPaise: paise(3_333), taxRateBps: 500 },
      { lineTotalPaise: paise(3_333), taxRateBps: 500 },
    ];
    const q = computeQuote({
      lines,
      feeRules: [],
      taxModel: doesNot,
      settlementMode: 'PLATFORM_COLLECT',
    });
    expect(q.foodTaxPaise).toBe(501);
  });

  it('handles mixed tax rates across lines', () => {
    const lines = [
      { lineTotalPaise: paise(25_000), taxRateBps: 500 },
      { lineTotalPaise: paise(6_000), taxRateBps: 1_200 },
    ];
    const q = computeQuote({
      lines,
      feeRules: [],
      taxModel: doesNot,
      settlementMode: 'PLATFORM_COLLECT',
    });
    expect(q.foodTaxPaise).toBe(1_250 + 720);
  });
});

describe('platform credit', () => {
  it('reduces what the customer pays but not what the vendor receives', () => {
    // The platform funds the credit; it was booked as a liability when issued.
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
      creditPaise: paise(5_000),
    });
    expect(q.grossPayablePaise).toBe(26_840);
    expect(q.creditAppliedPaise).toBe(5_000);
    expect(q.totalPayablePaise).toBe(21_840);
    expect(q.distribution.vendorNetPaise).toBe(23_820);
    expect(distributionTotal(q.distribution)).toBe(q.grossPayablePaise);
  });

  it('never makes the total negative', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
      creditPaise: paise(999_999),
    });
    expect(q.totalPayablePaise).toBe(0);
    expect(q.creditAppliedPaise).toBe(26_840);
  });
});

describe('guards', () => {
  it('refuses a fee configuration that exceeds the order', () => {
    const greedy: FeeRule = { ...vendorCommission, rateBps: 9_500 };
    const alsoGreedy: FeeRule = { ...operatorShare, rateBps: 9_500 };
    expect(() =>
      computeQuote({
        lines: [line],
        feeRules: [greedy, alsoGreedy],
        taxModel: applies,
        settlementMode: 'PLATFORM_COLLECT',
      }),
    ).toThrow(AppError);
  });

  it('enforces a minimum order value', () => {
    try {
      computeQuote({
        lines: [{ lineTotalPaise: paise(5_000), taxRateBps: 500 }],
        feeRules: [],
        taxModel: applies,
        settlementMode: 'PLATFORM_COLLECT',
        minimumOrderPaise: paise(10_000),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('BELOW_MINIMUM_ORDER');
    }
  });

  it('refuses an order smaller than a fixed fee floor', () => {
    // Found by the property suite: a ₹2 minimum fee floor on a ₹0.01 order is
    // unpayable. Refusing is correct — the guard against it in production is
    // the minimum-order-value setting, not silent absorption of the shortfall.
    const floored: FeeRule = {
      ...vendorCommission,
      feeType: 'FLAT_PER_ORDER',
      amountPaise: paise(200),
      minFloorPaise: paise(200),
    };
    expect(() =>
      computeQuote({
        lines: [{ lineTotalPaise: paise(1), taxRateBps: 0 }],
        feeRules: [floored],
        taxModel: doesNot,
        settlementMode: 'PLATFORM_COLLECT',
      }),
    ).toThrow(AppError);
  });

  it('snapshots the tax model and mode onto the quote', () => {
    // FEE-03: the order carries its own arithmetic. Reports never recompute
    // history from current configuration.
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });
    expect(q.taxModelSnapshot).toEqual(applies);
    expect(q.settlementModeSnapshot).toBe('PLATFORM_COLLECT');
    expect([...q.appliedRuleIds].sort()).toEqual(['r-cust', 'r-operator', 'r-vendor']);
  });
});

describe('assertBalances()', () => {
  it('passes for a real quote', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });
    expect(() => assertBalances(q)).not.toThrow();
  });

  it('throws if a distribution is tampered with', () => {
    // Mirrors v_ledger_imbalance. This should be unreachable — if it ever
    // fires in production an invariant in the design has been violated.
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });
    const tampered = {
      ...q,
      distribution: { ...q.distribution, vendorNetPaise: paise(999_999) },
    };
    expect(() => assertBalances(tampered)).toThrow(AppError);
  });
});

describe('platform revenue', () => {
  it('is commission plus customer fee, excluding tax collected on behalf of others', () => {
    const q = computeQuote({
      lines: [line],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
    });
    // 750 commission + 500 customer fee + 0 residual.
    expect(platformRevenue(q.distribution)).toBe(1_250);
    // Notably NOT including the 1,250 tax reserve — that is the government's.
    expect(platformRevenue(q.distribution)).not.toBe(2_500);
  });
});
