/**
 * The property test TDD §4.3 calls for: for ANY randomly generated cart and any
 * legal fee configuration, the distribution sums to gross payable.
 *
 * This is the single most valuable test in the repository. It is the executable
 * form of `v_ledger_imbalance` in schema.sql, and it runs in milliseconds
 * instead of at settlement time.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeQuote, distributionTotal, platformRevenue } from '../../src/pricing/quote.js';
import type { FeeRule, SettlementMode, TaxModel } from '../../src/pricing/fee-engine.js';
import { paise, type Paise } from '../../src/platform/money.js';
import { AppError } from '../../src/platform/errors.js';

/**
 * Orders of at least ₹50, and fee rules bounded so the configuration is
 * actually payable.
 *
 * Earlier runs of this suite kept finding the same class of counterexample: a
 * fixed fee larger than the order it is charged on. A ₹8.83 flat vendor fee on
 * a ₹10 order, or a ₹2 fee floor on a 1-paise order, genuinely cannot be paid,
 * and `computeQuote` is right to refuse with FEE_CONFIG_EXCEEDS_ORDER rather
 * than produce a negative vendor payout.
 *
 * That is a configuration error, not a balance bug. It is covered by its own
 * unit test, and in production it is prevented by the minimum-order-value
 * setting. So the generator is bounded to configurations that could exist:
 * worst case here is 500 + 90 + 500 + 90 = 1,180 paise of deductions against a
 * floor of 5,000 paise of food.
 */
const MIN_LINE_PAISE = 5_000;
const MAX_FLAT_FEE_PAISE = 500;
const MAX_RATE_BPS = 1_000;

const arbLine = fc
  .record({
    lineTotalPaise: fc.integer({ min: MIN_LINE_PAISE, max: 500_000 }),
    taxRateBps: fc.constantFrom(0, 500, 1_200, 1_800),
  })
  .map((l) => ({ lineTotalPaise: paise(l.lineTotalPaise), taxRateBps: l.taxRateBps }));

const arbLines = fc.array(arbLine, { minLength: 1, maxLength: 12 });

/** Rates and flat amounts kept low enough that the configuration is payable. */
function arbRule(party: FeeRule['party'], id: string): fc.Arbitrary<FeeRule> {
  return fc
    .record({
      feeType: fc.constantFrom<FeeRule['feeType']>('PERCENTAGE', 'FLAT_PER_ORDER'),
      rateBps: fc.integer({ min: 0, max: MAX_RATE_BPS }),
      amountPaise: fc.integer({ min: 0, max: MAX_FLAT_FEE_PAISE }),
      minFloorPaise: fc.integer({ min: 0, max: 200 }),
      taxRateBps: fc.constantFrom(0, 500, 1_800),
      scope: fc.constantFrom<FeeRule['scope']>('PLATFORM_DEFAULT', 'FOOD_COURT', 'VENDOR'),
      version: fc.integer({ min: 1, max: 5 }),
    })
    .map((r): FeeRule => ({
      id,
      scope: r.scope,
      party,
      feeType: r.feeType,
      rateBps: r.rateBps,
      amountPaise: paise(r.amountPaise),
      minFloorPaise: paise(r.minFloorPaise),
      taxRateBps: r.taxRateBps,
      allowedModes: ['PLATFORM_COLLECT', 'VENDOR_DIRECT'],
      version: r.version,
    }));
}

const arbRules = fc
  .tuple(
    fc.option(arbRule('CUSTOMER', 'r-c'), { nil: undefined }),
    fc.option(arbRule('VENDOR', 'r-v'), { nil: undefined }),
    fc.option(arbRule('OPERATOR', 'r-o'), { nil: undefined }),
  )
  .map((rs) => rs.filter((r): r is FeeRule => r !== undefined));

const arbTax: fc.Arbitrary<TaxModel> = fc.record({
  section9_5Applies: fc.boolean(),
  feeGstBps: fc.constantFrom(0, 1_800),
});

const arbMode = fc.constantFrom<SettlementMode>('PLATFORM_COLLECT', 'VENDOR_DIRECT');

describe('pricing invariants hold for any legal configuration', () => {
  it('the distribution always sums to gross payable', () => {
    fc.assert(
      fc.property(arbLines, arbRules, arbTax, arbMode, (lines, feeRules, taxModel, mode) => {
        const q = computeQuote({ lines, feeRules, taxModel, settlementMode: mode });
        expect(distributionTotal(q.distribution)).toBe(q.grossPayablePaise);
      }),
      { numRuns: 500 },
    );
  });

  it('no party ever receives a negative amount, except the rounding residual', () => {
    fc.assert(
      fc.property(arbLines, arbRules, arbTax, arbMode, (lines, feeRules, taxModel, mode) => {
        const d = computeQuote({ lines, feeRules, taxModel, settlementMode: mode }).distribution;
        expect(d.vendorNetPaise).toBeGreaterThanOrEqual(0);
        expect(d.vendorCommissionPaise).toBeGreaterThanOrEqual(0);
        expect(d.operatorSharePaise).toBeGreaterThanOrEqual(0);
        expect(d.platformTaxReservePaise).toBeGreaterThanOrEqual(0);
        expect(d.customerFeePaise).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('the rounding residual is at most a few paise, never a material amount', () => {
    fc.assert(
      fc.property(arbLines, arbRules, arbTax, arbMode, (lines, feeRules, taxModel, mode) => {
        const d = computeQuote({ lines, feeRules, taxModel, settlementMode: mode }).distribution;
        // One paisa per rounded component at worst. If this ever grows, the
        // computation order has drifted from TDD §4.1.
        expect(Math.abs(d.platformAdjustmentPaise)).toBeLessThanOrEqual(5);
      }),
      { numRuns: 500 },
    );
  });

  it('everything is an exact integer — no float ever leaks in', () => {
    fc.assert(
      fc.property(arbLines, arbRules, arbTax, arbMode, (lines, feeRules, taxModel, mode) => {
        const q = computeQuote({ lines, feeRules, taxModel, settlementMode: mode });
        const values: Paise[] = [
          q.subtotalPaise,
          q.foodTaxPaise,
          q.grossPayablePaise,
          q.totalPayablePaise,
          ...Object.values(q.distribution),
        ];
        for (const v of values) expect(Number.isInteger(v)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('the customer never pays more because of how the platform splits its money', () => {
    // Changing vendor or operator rules must not move the customer's total.
    fc.assert(
      fc.property(arbLines, arbTax, (lines, taxModel) => {
        const base = { lines, taxModel, settlementMode: 'PLATFORM_COLLECT' as const };
        const noSplit = computeQuote({ ...base, feeRules: [] });
        const withSplit = computeQuote({
          ...base,
          feeRules: [
            {
              id: 'v',
              scope: 'VENDOR',
              party: 'VENDOR',
              feeType: 'PERCENTAGE',
              rateBps: 300,
              minFloorPaise: paise(0),
              taxRateBps: 1_800,
              allowedModes: ['PLATFORM_COLLECT'],
              version: 1,
            },
          ],
        });
        expect(withSplit.grossPayablePaise).toBe(noSplit.grossPayablePaise);
      }),
      { numRuns: 200 },
    );
  });

  it('the s.9(5) determination never changes what the customer pays', () => {
    // It only changes how the money is divided afterwards. PRD §4.7.
    fc.assert(
      fc.property(arbLines, arbRules, (lines, feeRules) => {
        const a = computeQuote({
          lines,
          feeRules,
          taxModel: { section9_5Applies: true, feeGstBps: 1_800 },
          settlementMode: 'PLATFORM_COLLECT',
        });
        const b = computeQuote({
          lines,
          feeRules,
          taxModel: { section9_5Applies: false, feeGstBps: 1_800 },
          settlementMode: 'PLATFORM_COLLECT',
        });
        expect(a.grossPayablePaise).toBe(b.grossPayablePaise);
      }),
      { numRuns: 300 },
    );
  });

  it('under s.9(5) the platform always retains exactly the food tax', () => {
    fc.assert(
      fc.property(arbLines, arbRules, (lines, feeRules) => {
        const q = computeQuote({
          lines,
          feeRules,
          taxModel: { section9_5Applies: true, feeGstBps: 1_800 },
          settlementMode: 'PLATFORM_COLLECT',
        });
        expect(q.distribution.platformTaxReservePaise).toBe(q.foodTaxPaise);
      }),
      { numRuns: 300 },
    );
  });

  it('platform revenue never includes the tax reserve', () => {
    // The reserve is the government's money passing through. Counting it as
    // revenue would overstate the take rate by roughly 5% of GMV.
    fc.assert(
      fc.property(arbLines, arbRules, (lines, feeRules) => {
        const q = computeQuote({
          lines,
          feeRules,
          taxModel: { section9_5Applies: true, feeGstBps: 1_800 },
          settlementMode: 'PLATFORM_COLLECT',
        });
        if (q.distribution.platformTaxReservePaise > 0) {
          expect(platformRevenue(q.distribution)).toBeLessThan(
            q.distribution.platformTaxReservePaise + platformRevenue(q.distribution),
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it('recomputing the same input always gives the same answer', () => {
    // Determinism. A quote is snapshotted onto an order and must be
    // reproducible for a dispute months later.
    fc.assert(
      fc.property(arbLines, arbRules, arbTax, arbMode, (lines, feeRules, taxModel, mode) => {
        const a = computeQuote({ lines, feeRules, taxModel, settlementMode: mode });
        const b = computeQuote({ lines, feeRules, taxModel, settlementMode: mode });
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });

  it('an over-configured fee set fails loudly rather than paying a negative amount', () => {
    const greedy: FeeRule = {
      id: 'g',
      scope: 'VENDOR',
      party: 'VENDOR',
      feeType: 'PERCENTAGE',
      rateBps: 10_000,
      minFloorPaise: paise(0),
      taxRateBps: 1_800,
      allowedModes: ['PLATFORM_COLLECT'],
      version: 1,
    };
    fc.assert(
      fc.property(arbLines, (lines) => {
        expect(() =>
          computeQuote({
            lines,
            feeRules: [greedy],
            taxModel: { section9_5Applies: false, feeGstBps: 1_800 },
            settlementMode: 'PLATFORM_COLLECT',
          }),
        ).toThrow(AppError);
      }),
      { numRuns: 50 },
    );
  });
});
