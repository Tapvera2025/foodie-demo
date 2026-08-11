import { describe, it, expect } from 'vitest';
import {
  paise,
  rupeesToPaise,
  add,
  sub,
  mul,
  applyBps,
  clamp,
  formatINR,
  min,
  max,
  isZero,
  MoneyError,
  ZERO,
} from './money.js';

describe('paise()', () => {
  it('accepts exact integers', () => {
    expect(paise(0)).toBe(0);
    expect(paise(25000)).toBe(25000);
    expect(paise(-1250)).toBe(-1250);
  });

  it('rejects anything that is not an exact integer', () => {
    // PRD PAY-05: a float must be impossible to introduce, not merely discouraged.
    expect(() => paise(1.5)).toThrow(MoneyError);
    expect(() => paise(0.1 + 0.2)).toThrow(MoneyError);
    expect(() => paise(NaN)).toThrow(MoneyError);
    expect(() => paise(Infinity)).toThrow(MoneyError);
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('rupeesToPaise()', () => {
  it('converts at the boundary', () => {
    expect(rupeesToPaise('250.00')).toBe(25000);
    expect(rupeesToPaise('180')).toBe(18000);
    expect(rupeesToPaise('0.05')).toBe(5);
    expect(rupeesToPaise('1.5')).toBe(150);
    expect(rupeesToPaise(45)).toBe(4500);
  });

  it('rejects more than two decimal places rather than rounding', () => {
    // Interface Specs §4.2 — a silently rounded price is a vendor dispute.
    expect(() => rupeesToPaise('180.005')).toThrow(MoneyError);
    expect(() => rupeesToPaise('12.3456')).toThrow(MoneyError);
  });

  it('rejects junk', () => {
    expect(() => rupeesToPaise('')).toThrow(MoneyError);
    expect(() => rupeesToPaise('abc')).toThrow(MoneyError);
    expect(() => rupeesToPaise('1,250.00')).toThrow(MoneyError);
    expect(() => rupeesToPaise('₹250')).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(paise(25000), paise(1250), paise(500))).toBe(26750);
    expect(sub(paise(26840), paise(23820))).toBe(3020);
    expect(add()).toBe(ZERO);
  });

  it('multiplies only by integer quantities', () => {
    expect(mul(paise(18000), 2)).toBe(36000);
    expect(() => mul(paise(18000), 1.5)).toThrow(MoneyError);
  });
});

describe('applyBps() — half-up rounding', () => {
  it('computes the TDD §4.2 worked example exactly', () => {
    const subtotal = paise(25000); // ₹250.00 of food

    expect(applyBps(subtotal, 500)).toBe(1250); // 5% food GST
    expect(applyBps(subtotal, 300)).toBe(750); // 3% vendor commission
    expect(applyBps(paise(750), 1800)).toBe(135); // 18% GST on commission
    expect(applyBps(subtotal, 100)).toBe(250); // 1% operator share
    expect(applyBps(paise(250), 1800)).toBe(45); // 18% GST on that
    expect(applyBps(paise(500), 1800)).toBe(90); // 18% GST on a ₹5 customer fee
  });

  it('rounds half UP, not to even', () => {
    // 1 paisa at 50% = 0.5 -> 1. Banker's rounding would give 0.
    expect(applyBps(paise(1), 5000)).toBe(1);
    expect(applyBps(paise(3), 5000)).toBe(2); // 1.5 -> 2
    expect(applyBps(paise(5), 5000)).toBe(3); // 2.5 -> 3
  });

  it('mirrors exactly for negative amounts so a reversal nets to zero', () => {
    const forward = applyBps(paise(26250), 300);
    const reverse = applyBps(paise(-26250), 300);
    expect(forward + reverse).toBe(0);
  });

  it('handles the identity and zero cases', () => {
    expect(applyBps(paise(26840), 10000)).toBe(26840);
    expect(applyBps(paise(26840), 0)).toBe(0);
  });

  it('rejects an out-of-range rate', () => {
    expect(() => applyBps(paise(100), -1)).toThrow(MoneyError);
    expect(() => applyBps(paise(100), 10001)).toThrow(MoneyError);
    expect(() => applyBps(paise(100), 5.5)).toThrow(MoneyError);
  });
});

describe('clamp()', () => {
  it('applies floor and cap', () => {
    expect(clamp(paise(200), paise(500))).toBe(500);
    expect(clamp(paise(900), paise(500), paise(800))).toBe(800);
    expect(clamp(paise(600), paise(500), paise(800))).toBe(600);
  });
});

describe('min() and max()', () => {
  it('pick the smaller and larger', () => {
    expect(min(paise(500), paise(900))).toBe(500);
    expect(min(paise(900), paise(500))).toBe(500);
    expect(max(paise(500), paise(900))).toBe(900);
    expect(max(paise(900), paise(500))).toBe(900);
  });

  it('are stable for equal values', () => {
    expect(min(paise(500), paise(500))).toBe(500);
    expect(max(paise(500), paise(500))).toBe(500);
  });
});

describe('isZero()', () => {
  it('distinguishes zero from everything else', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(paise(0))).toBe(true);
    expect(isZero(paise(1))).toBe(false);
  });
});

describe('formatINR()', () => {
  it('formats with Indian digit grouping', () => {
    expect(formatINR(paise(25000))).toBe('₹250.00');
    expect(formatINR(paise(26840))).toBe('₹268.40');
    expect(formatINR(paise(5))).toBe('₹0.05');
    expect(formatINR(paise(100000))).toBe('₹1,000.00');
    expect(formatINR(paise(10000000))).toBe('₹1,00,000.00');
    expect(formatINR(paise(-26840))).toBe('-₹268.40');
  });
});

describe('the TDD §4.2 worked example balances', () => {
  it('s.9(5) applies: every rupee collected is accounted for', () => {
    const subtotal = paise(25000);
    const foodTax = applyBps(subtotal, 500); // 1250
    const customerFee = paise(500);
    const customerFeeTax = applyBps(customerFee, 1800); // 90
    const totalPayable = add(subtotal, foodTax, customerFee, customerFeeTax);
    expect(totalPayable).toBe(26840);

    // s.9(5) applies -> commission base excludes food GST, platform retains it.
    const commissionBase = subtotal;
    const commission = applyBps(commissionBase, 300); // 750
    const commissionTax = applyBps(commission, 1800); // 135
    const operatorShare = applyBps(commissionBase, 100); // 250
    const operatorShareTax = applyBps(operatorShare, 1800); // 45
    const taxReserve = foodTax; // 1250 — retained, not settled
    const vendorNet = sub(
      subtotal,
      add(commission, commissionTax, operatorShare, operatorShareTax),
    );
    expect(vendorNet).toBe(23820);

    const distributed = add(
      vendorNet,
      taxReserve,
      commission,
      commissionTax,
      operatorShare,
      operatorShareTax,
      customerFee,
      customerFeeTax,
    );
    expect(distributed).toBe(totalPayable);
  });

  it('s.9(5) does not apply: vendor receives food GST, payout differs by exactly the tax', () => {
    const subtotal = paise(25000);
    const foodTax = applyBps(subtotal, 500);
    const commissionBase = add(subtotal, foodTax); // 26250
    const commission = applyBps(commissionBase, 300); // 788
    const commissionTax = applyBps(commission, 1800); // 142
    const operatorShare = applyBps(commissionBase, 100); // 263
    const operatorShareTax = applyBps(operatorShare, 1800); // 47
    const vendorNet = sub(
      commissionBase,
      add(commission, commissionTax, operatorShare, operatorShareTax),
    );
    expect(vendorNet).toBe(25010);

    // The whole point of PRD §4.7: getting this determination wrong moves
    // ₹11.90 per ₹250 order against a ₹7.50 commission.
    expect(25010 - 23820).toBe(1190);
  });
});
