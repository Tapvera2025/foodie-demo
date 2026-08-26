/**
 * The gate for TDD §8: the worked entries reproduce exactly, and no quote the
 * pricing engine can produce yields an unbalanced ledger.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { paise } from '../platform/money.js';
import { isAppError } from '../platform/errors.js';
import { computeQuote, type Quote } from '../pricing/quote.js';
import type { FeeRule, TaxModel } from '../pricing/fee-engine.js';
import {
  orderPlacementEntries,
  orderRefundEntries,
  totalFor,
  type LedgerEntry,
} from './entries.js';

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
const doesNotApply: TaxModel = { section9_5Applies: false, feeGstBps: 1800 };

function find(entries: readonly LedgerEntry[], type: string, dir: 'DEBIT' | 'CREDIT'): LedgerEntry {
  const e = entries.find((x) => x.entryType === type && x.direction === dir);
  if (!e) throw new Error(`no ${dir} ${type} entry`);
  return e;
}

describe('TDD §8.2 worked entries — the ledger gate', () => {
  const quote = computeQuote({
    lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
    feeRules: RULES,
    taxModel: applies,
    settlementMode: 'PLATFORM_COLLECT',
  });
  const entries = orderPlacementEntries(quote);

  it('collects 26,840 paise across four customer-side credits', () => {
    expect(find(entries, 'GROSS_ORDER_VALUE', 'CREDIT').amountPaise).toBe(25_000);
    expect(find(entries, 'FOOD_TAX', 'CREDIT').amountPaise).toBe(1_250);
    expect(find(entries, 'CUSTOMER_PLATFORM_FEE', 'CREDIT').amountPaise).toBe(500);
    expect(find(entries, 'CUSTOMER_FEE_TAX', 'CREDIT').amountPaise).toBe(90);
    expect(totalFor(entries, 'CREDIT')).toBe(26_840);
  });

  it('allocates the same 26,840 across the debits', () => {
    expect(find(entries, 'VENDOR_NET_PAYABLE', 'DEBIT').amountPaise).toBe(23_820);
    expect(find(entries, 'PLATFORM_TAX_RESERVE', 'DEBIT').amountPaise).toBe(1_250);
    expect(find(entries, 'VENDOR_COMMISSION', 'DEBIT').amountPaise).toBe(750);
    expect(find(entries, 'VENDOR_COMMISSION_TAX', 'DEBIT').amountPaise).toBe(135);
    expect(find(entries, 'OPERATOR_SHARE', 'DEBIT').amountPaise).toBe(250);
    expect(find(entries, 'OPERATOR_SHARE_TAX', 'DEBIT').amountPaise).toBe(45);
    // TDD §8.2 shows fee + fee tax collapsed onto one 590 line for display.
    expect(
      find(entries, 'CUSTOMER_PLATFORM_FEE', 'DEBIT').amountPaise +
        find(entries, 'CUSTOMER_FEE_TAX', 'DEBIT').amountPaise,
    ).toBe(590);
    expect(totalFor(entries, 'DEBIT')).toBe(26_840);
  });

  it('assigns the tax reserve to the platform, not to the vendor', () => {
    // The single most expensive row to get wrong. If PLATFORM_TAX_RESERVE
    // carried party=VENDOR it would settle out to the vendor, and the platform
    // would still owe the s.9(5) liability it had already paid away.
    expect(find(entries, 'PLATFORM_TAX_RESERVE', 'DEBIT').party).toBeNull();
  });

  it('books the tax reserve at zero when s.9(5) does not apply', () => {
    const q = computeQuote({
      lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
      feeRules: RULES,
      taxModel: doesNotApply,
      settlementMode: 'PLATFORM_COLLECT',
    });
    const e = orderPlacementEntries(q);
    // Zero rows are omitted, so absence is the assertion.
    expect(e.find((x) => x.entryType === 'PLATFORM_TAX_RESERVE')).toBeUndefined();
    expect(totalFor(e, 'DEBIT')).toBe(totalFor(e, 'CREDIT'));
  });
});

describe('VENDOR_DIRECT', () => {
  const quote = computeQuote({
    lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
    feeRules: RULES,
    taxModel: applies,
    settlementMode: 'VENDOR_DIRECT',
  });

  it('writes no customer fee rows at all', () => {
    const e = orderPlacementEntries(quote);
    expect(e.find((x) => x.entryType === 'CUSTOMER_PLATFORM_FEE')).toBeUndefined();
    expect(e.find((x) => x.entryType === 'CUSTOMER_FEE_TAX')).toBeUndefined();
  });

  it('still balances', () => {
    const e = orderPlacementEntries(quote);
    expect(totalFor(e, 'DEBIT')).toBe(totalFor(e, 'CREDIT'));
  });
});

describe('entries the catalogue cannot express are refused, not guessed', () => {
  it('refuses a discount', () => {
    const q = computeQuote({
      lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
      discountPaise: paise(1_000),
    });
    try {
      orderPlacementEntries(q);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('LEDGER_CANNOT_REPRESENT_DISCOUNT');
    }
  });

  it('refuses applied platform credit at placement', () => {
    const q = computeQuote({
      lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
      creditPaise: paise(1_000),
    });
    try {
      orderPlacementEntries(q);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(isAppError(e) && e.code).toBe('LEDGER_CANNOT_REPRESENT_CREDIT_AT_PLACEMENT');
    }
  });
});

describe('PRD LED-02 — balance is a property, not a fixture', () => {
  it('holds for every order the pricing engine can price', () => {
    fc.assert(
      fc.property(
        // Floor of ₹50: below that the ₹5 flat customer fee can exceed the
        // order and computeQuote correctly refuses. Same bound as the pricing
        // property test, and for the same reason.
        fc.integer({ min: 5_000, max: 50_000_000 }),
        fc.constantFrom(0, 500, 1_200, 1_800),
        fc.boolean(),
        fc.constantFrom('PLATFORM_COLLECT' as const, 'VENDOR_DIRECT' as const),
        (lineTotal, taxRateBps, s95, mode) => {
          const quote: Quote = computeQuote({
            lines: [{ lineTotalPaise: paise(lineTotal), taxRateBps }],
            feeRules: RULES,
            taxModel: { section9_5Applies: s95, feeGstBps: 1800 },
            settlementMode: mode,
          });
          const e = orderPlacementEntries(quote);

          // orderPlacementEntries throws on imbalance, so reaching here is
          // most of the assertion. State it anyway — a future refactor that
          // drops the internal assert should fail here, not silently pass.
          expect(totalFor(e, 'DEBIT')).toBe(totalFor(e, 'CREDIT'));
          expect(totalFor(e, 'CREDIT')).toBe(quote.grossPayablePaise);
          expect(e.every((x) => x.amountPaise > 0)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/**
 * A refund is the placement run backwards.
 *
 * The property that matters is not that the refund entries balance on their
 * own — two rows of one paise do that. It is that placement plus refund nets
 * to zero on EVERY line type, because that is the shape a settlement report
 * and a reconciliation both read.
 */
describe('refund entries reverse the order exactly (§14.6, §14.7)', () => {
  const quote = computeQuote({
    lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
    feeRules: RULES,
    taxModel: applies,
    settlementMode: 'PLATFORM_COLLECT',
  });

  it('balances on its own', () => {
    const entries = orderRefundEntries(quote);
    expect(totalFor(entries, 'DEBIT')).toBe(totalFor(entries, 'CREDIT'));
  });

  it('returns exactly what the customer paid', () => {
    const entries = orderRefundEntries(quote);
    const toCustomer = entries
      .filter((e) => e.entryType === 'REFUND' && e.direction === 'DEBIT')
      .reduce((n, e) => n + e.amountPaise, 0);
    expect(toCustomer).toBe(quote.grossPayablePaise);
  });

  it('nets every line type to zero when combined with the placement', () => {
    const combined = [...orderPlacementEntries(quote), ...orderRefundEntries(quote)];

    // Group by party, since that is who could dispute a number.
    const net = new Map<string, number>();
    for (const e of combined) {
      const key = e.party ?? 'PLATFORM';
      const signed = e.direction === 'DEBIT' ? e.amountPaise : -e.amountPaise;
      net.set(key, (net.get(key) ?? 0) + signed);
    }
    for (const [party, sum] of net) {
      expect(sum, `${party} is left holding ${sum} paise after a full refund`).toBe(0);
    }
  });

  it('leaves the vendor owed nothing', () => {
    const combined = [...orderPlacementEntries(quote), ...orderRefundEntries(quote)];
    const vendorNet = combined
      .filter((e) => e.party === 'VENDOR')
      .reduce((n, e) => n + (e.direction === 'DEBIT' ? e.amountPaise : -e.amountPaise), 0);
    expect(vendorNet).toBe(0);
  });

  it('gives the platform fee back rather than keeping it', () => {
    const entries = orderRefundEntries(quote);
    const feeBack = entries.find(
      (e) => e.entryType === 'CUSTOMER_PLATFORM_FEE' && e.direction === 'CREDIT',
    );
    expect(feeBack?.amountPaise).toBe(quote.distribution.customerFeePaise);
  });

  it('refuses a quote the entry catalogue cannot express', () => {
    // Same refusal as placement. A discount has no row type — PRD §19 row 4.
    const withDiscount = computeQuote({
      lines: [{ lineTotalPaise: paise(25_000), taxRateBps: 500 }],
      feeRules: RULES,
      taxModel: applies,
      settlementMode: 'PLATFORM_COLLECT',
      discountPaise: paise(1_000),
    });
    expect(() => orderRefundEntries(withDiscount)).toThrow();
  });
});
