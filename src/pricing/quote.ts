/**
 * The quote — what the customer pays, and how it is distributed.
 *
 * Implements TDD §4.1 in the stated order. Computation order and rounding
 * placement are load-bearing: change either and the ledger stops balancing.
 *
 * PURE. No I/O of any kind.
 */

import { AppError } from '../platform/errors.js';
import { add, applyBps, min, paise, sub, type Paise } from '../platform/money.js';
import {
  computeFee,
  computeFeeTax,
  resolveRule,
  type FeeRule,
  type SettlementMode,
  type TaxModel,
} from './fee-engine.js';

export interface QuoteLine {
  readonly lineTotalPaise: Paise;
  /** Per-item GST rate. Tax is computed per line, not on the subtotal. */
  readonly taxRateBps: number;
}

export interface QuoteInput {
  readonly lines: readonly QuoteLine[];
  readonly feeRules: readonly FeeRule[];
  readonly taxModel: TaxModel;
  readonly settlementMode: SettlementMode;
  readonly discountPaise?: Paise;
  readonly creditPaise?: Paise;
  readonly minimumOrderPaise?: Paise;
}

/** Every party's share. These must sum to `grossPayablePaise`. */
export interface Distribution {
  readonly vendorNetPaise: Paise;
  readonly vendorCommissionPaise: Paise;
  readonly vendorCommissionTaxPaise: Paise;
  readonly operatorSharePaise: Paise;
  readonly operatorShareTaxPaise: Paise;
  readonly platformTaxReservePaise: Paise;
  readonly customerFeePaise: Paise;
  readonly customerFeeTaxPaise: Paise;
  /** Rounding residual, allocated to the platform. Never to vendor or customer. */
  readonly platformAdjustmentPaise: Paise;
}

export interface Quote {
  readonly subtotalPaise: Paise;
  readonly foodTaxPaise: Paise;
  readonly customerFeePaise: Paise;
  readonly customerFeeTaxPaise: Paise;
  readonly discountPaise: Paise;
  /** Before platform credit. This is what the distribution sums to. */
  readonly grossPayablePaise: Paise;
  readonly creditAppliedPaise: Paise;
  /** What the customer is actually charged. */
  readonly totalPayablePaise: Paise;
  readonly distribution: Distribution;
  /** Snapshotted onto the order — historical orders never recompute. */
  readonly taxModelSnapshot: TaxModel;
  readonly settlementModeSnapshot: SettlementMode;
  readonly appliedRuleIds: readonly string[];
}

export function computeQuote(input: QuoteInput): Quote {
  const { taxModel, settlementMode } = input;

  // --- CUSTOMER SIDE ------------------------------------------------------
  // 1-2. Subtotal from line totals.
  const subtotal = add(...input.lines.map((l) => l.lineTotalPaise));

  // 3. Food tax PER LINE, not on the subtotal — this matches POS invoice
  //    arithmetic, and the two differ by a paisa surprisingly often.
  const foodTax = add(...input.lines.map((l) => applyBps(l.lineTotalPaise, l.taxRateBps)));

  // 4-5. Customer fee. Zero in VENDOR_DIRECT: the platform is not in that
  //      payment flow, so it cannot charge the customer anything.
  const customerRule =
    settlementMode === 'PLATFORM_COLLECT' ? resolveRule(input.feeRules, 'CUSTOMER') : undefined;
  const customerFee = computeFee(customerRule, subtotal);
  const customerFeeTax = computeFeeTax(customerRule, customerFee);

  const discount = input.discountPaise ?? paise(0);

  const grossPayable = sub(add(subtotal, foodTax, customerFee, customerFeeTax), discount);

  if (input.minimumOrderPaise !== undefined && subtotal < input.minimumOrderPaise) {
    throw new AppError(
      'BELOW_MINIMUM_ORDER',
      `add ${input.minimumOrderPaise - subtotal} paise more to order from this stall`,
      { shortfallPaise: String(input.minimumOrderPaise - subtotal) },
    );
  }

  // 6-7. Platform credit is applied last and never makes the total negative.
  const creditApplied = min(input.creditPaise ?? paise(0), grossPayable);
  const totalPayable = sub(grossPayable, creditApplied);

  // --- VENDOR SIDE --------------------------------------------------------
  // Computed independently of what the customer paid.
  const s95 = taxModel.section9_5Applies;

  // 9. If s.9(5) applies the vendor's supply is the food value excluding GST,
  //    because the platform — not the vendor — accounts for that GST.
  const commissionBase = s95 ? subtotal : add(subtotal, foodTax);

  const vendorRule = resolveRule(input.feeRules, 'VENDOR');
  const operatorRule = resolveRule(input.feeRules, 'OPERATOR');

  const vendorCommission = computeFee(vendorRule, commissionBase);
  const vendorCommissionTax = computeFeeTax(vendorRule, vendorCommission);
  const operatorShare = computeFee(operatorRule, commissionBase);
  const operatorShareTax = computeFeeTax(operatorRule, operatorShare);

  // 14. THE LINE THAT DECIDES SOLVENCY.
  //     Retained by the platform to discharge the s.9(5) liability. Settle this
  //     to the vendor by mistake and every order loses roughly 5% of its value
  //     against a commission of about 3%.
  const platformTaxReserve = s95 ? foodTax : paise(0);

  // 15. What the vendor is owed.
  const vendorGross = s95 ? subtotal : add(subtotal, foodTax);
  const vendorDeductions = add(
    vendorCommission,
    vendorCommissionTax,
    operatorShare,
    operatorShareTax,
  );

  if (vendorDeductions > vendorGross) {
    // 16. An over-configured fee set. Caught here rather than producing a
    //     negative payout. PRD FEE-01/ECON-02.
    throw new AppError(
      'FEE_CONFIG_EXCEEDS_ORDER',
      `deductions ${vendorDeductions} exceed vendor gross ${vendorGross}`,
    );
  }
  const vendorNet = sub(vendorGross, vendorDeductions);

  // 17-18. Residual from rounding goes to the platform, so the order balances.
  const distributedBeforeAdjustment = add(
    vendorNet,
    platformTaxReserve,
    vendorCommission,
    vendorCommissionTax,
    operatorShare,
    operatorShareTax,
    customerFee,
    customerFeeTax,
  );
  const platformAdjustment = sub(grossPayable, distributedBeforeAdjustment);

  const distribution: Distribution = {
    vendorNetPaise: vendorNet,
    vendorCommissionPaise: vendorCommission,
    vendorCommissionTaxPaise: vendorCommissionTax,
    operatorSharePaise: operatorShare,
    operatorShareTaxPaise: operatorShareTax,
    platformTaxReservePaise: platformTaxReserve,
    customerFeePaise: customerFee,
    customerFeeTaxPaise: customerFeeTax,
    platformAdjustmentPaise: platformAdjustment,
  };

  return {
    subtotalPaise: subtotal,
    foodTaxPaise: foodTax,
    customerFeePaise: customerFee,
    customerFeeTaxPaise: customerFeeTax,
    discountPaise: discount,
    grossPayablePaise: grossPayable,
    creditAppliedPaise: creditApplied,
    totalPayablePaise: totalPayable,
    distribution,
    taxModelSnapshot: taxModel,
    settlementModeSnapshot: settlementMode,
    appliedRuleIds: [customerRule?.id, vendorRule?.id, operatorRule?.id].filter(
      (id): id is string => id !== undefined,
    ),
  };
}

/** Sum of every party's share. Must equal `grossPayablePaise`, always. */
export function distributionTotal(d: Distribution): Paise {
  return add(
    d.vendorNetPaise,
    d.vendorCommissionPaise,
    d.vendorCommissionTaxPaise,
    d.operatorSharePaise,
    d.operatorShareTaxPaise,
    d.platformTaxReservePaise,
    d.customerFeePaise,
    d.customerFeeTaxPaise,
    d.platformAdjustmentPaise,
  );
}

/**
 * The invariant, as an assertion.
 *
 * Mirrors `v_ledger_imbalance` in schema.sql. If this throws, the ledger would
 * not have balanced — and finding that out here, in a pure function, is
 * enormously cheaper than finding it out in a settlement run.
 */
export function assertBalances(quote: Quote): void {
  const total = distributionTotal(quote.distribution);
  if (total !== quote.grossPayablePaise) {
    throw new AppError(
      'FEE_CONFIG_EXCEEDS_ORDER',
      `distribution ${total} does not equal gross payable ${quote.grossPayablePaise}`,
    );
  }
}

/** Platform gross margin on the order, before provider charges. */
export function platformRevenue(d: Distribution): Paise {
  return add(d.vendorCommissionPaise, d.customerFeePaise, d.platformAdjustmentPaise);
}
