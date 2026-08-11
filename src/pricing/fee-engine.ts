/**
 * Fee rules and the tax model.
 *
 * PURE MODULE. No database, no clock, no network, no logger. The boundary rules
 * in eslint.config.js permit this module to import the money type and errors,
 * and nothing else. That is what makes the arithmetic property-testable, and it
 * is why every money bug should be caught here rather than in a vendor
 * settlement dispute three months later.
 *
 * PRD §13. TDD §4.
 */

import { AppError } from '../platform/errors.js';
import { applyBps, clamp, paise, type Paise } from '../platform/money.js';

export type SettlementMode = 'PLATFORM_COLLECT' | 'VENDOR_DIRECT';
export type FeeParty = 'CUSTOMER' | 'VENDOR' | 'OPERATOR';
export type FeeType = 'PERCENTAGE' | 'FLAT_PER_ORDER' | 'SUBSCRIPTION_MONTHLY';
export type FeeScope = 'PLATFORM_DEFAULT' | 'FOOD_COURT' | 'VENDOR';

/**
 * The tax position in force when an order is priced.
 *
 * `section9_5Applies` is the single most consequential boolean in the system.
 * If GST s.9(5) applies, the platform is the e-commerce operator liable for tax
 * on the restaurant service, and must RETAIN the food GST rather than settle it
 * to the vendor.
 *
 * There is no default anywhere in the codebase, and the application refuses to
 * boot without it. PRD §4.7, TDD §4.1 line 14.
 */
export interface TaxModel {
  readonly section9_5Applies: boolean;
  readonly feeGstBps: number;
}

export interface FeeRule {
  readonly id: string;
  readonly scope: FeeScope;
  readonly party: FeeParty;
  readonly feeType: FeeType;
  readonly rateBps?: number;
  readonly amountPaise?: Paise;
  readonly minFloorPaise: Paise;
  readonly maxCapPaise?: Paise;
  /** GST on the fee itself, separate from tax on the food. Typically 1800. */
  readonly taxRateBps: number;
  readonly allowedModes: readonly SettlementMode[];
  readonly version: number;
}

const SPECIFICITY: Readonly<Record<FeeScope, number>> = {
  VENDOR: 3,
  FOOD_COURT: 2,
  PLATFORM_DEFAULT: 1,
};

/**
 * Structural validation of a rule, at CONFIGURATION time.
 *
 * PRD FEE-05 / PAY-MODE-05: a rule that is invalid for the target vendor's
 * settlement mode is rejected here, in admin, with a clear reason — not later at
 * checkout in front of a customer.
 */
export function assertRuleValid(rule: FeeRule, mode: SettlementMode): void {
  const problems: string[] = [];

  if (rule.feeType === 'PERCENTAGE') {
    if (rule.rateBps === undefined) problems.push('percentage rule needs rateBps');
    else if (!Number.isInteger(rule.rateBps) || rule.rateBps < 0 || rule.rateBps > 10_000) {
      problems.push('rateBps must be an integer in [0, 10000]');
    }
  } else if (rule.amountPaise === undefined) {
    problems.push(`${rule.feeType} rule needs amountPaise`);
  }

  if (rule.maxCapPaise !== undefined && rule.maxCapPaise < rule.minFloorPaise) {
    problems.push('maxCapPaise is below minFloorPaise');
  }

  if (problems.length > 0) {
    throw new AppError('FEE_RULE_INVALID_FOR_MODE', problems.join('; '), { ruleId: rule.id });
  }

  if (!rule.allowedModes.includes(mode)) {
    // The commonest case: a customer platform fee attached to a VENDOR_DIRECT
    // vendor. The platform is not in that payment flow, so it cannot charge one.
    throw new AppError(
      'FEE_RULE_INVALID_FOR_MODE',
      `a ${rule.party} ${rule.feeType} rule is not permitted for a ${mode} vendor`,
      { ruleId: rule.id, party: rule.party, mode },
    );
  }
}

/**
 * Most specific rule wins: vendor beats court beats platform default.
 * Ties break on the higher version, so a newer rule at the same scope wins.
 */
export function resolveRule(rules: readonly FeeRule[], party: FeeParty): FeeRule | undefined {
  return rules
    .filter((r) => r.party === party)
    .sort((a, b) => {
      const s = SPECIFICITY[b.scope] - SPECIFICITY[a.scope];
      return s !== 0 ? s : b.version - a.version;
    })[0];
}

/**
 * Applies one rule to a base amount.
 *
 * A SUBSCRIPTION_MONTHLY rule contributes nothing per order — it is billed
 * separately — so it returns zero here rather than being silently treated as a
 * per-order charge.
 */
export function computeFee(rule: FeeRule | undefined, basePaise: Paise): Paise {
  if (rule === undefined) return paise(0);

  switch (rule.feeType) {
    case 'SUBSCRIPTION_MONTHLY':
      return paise(0);

    case 'FLAT_PER_ORDER':
      return clamp(rule.amountPaise ?? paise(0), rule.minFloorPaise, rule.maxCapPaise);

    case 'PERCENTAGE': {
      const raw = applyBps(basePaise, rule.rateBps ?? 0);
      return clamp(raw, rule.minFloorPaise, rule.maxCapPaise);
    }
  }
}

/** GST on a fee, at the rule's own rate — separate from tax on the food. */
export function computeFeeTax(rule: FeeRule | undefined, feePaise: Paise): Paise {
  if (rule === undefined) return paise(0);
  return applyBps(feePaise, rule.taxRateBps);
}
