/**
 * ============================================================================
 * WHO GETS WHAT, OUT OF ONE PAYMENT
 * ============================================================================
 *
 * Under `PLATFORM_COLLECT` the customer pays once, Cashfree collects once, and
 * Easy Split routes the money to two places: the stall gets what it is owed for
 * the food, and the platform keeps the convenience fee. This turns an order's
 * stored distribution into the allocation list `createIntent` sends.
 *
 * THE FAILURE THIS ENDS
 *
 * Until now nothing built a split at all. `createIntent` sent no `order_splits`
 * and `applySplit` threw if anybody called it, so under PLATFORM_COLLECT the
 * ENTIRE amount settled into the platform's Cashfree account and the stall
 * received nothing. Every screen looked correct: the customer paid, the order
 * was made, the ledger balanced. The discrepancy was only visible in a bank
 * statement, weeks later, by which time a stall has been trading on money it
 * never got.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE
 * ----------------------------------------------------------------------------
 *
 * It is arithmetic about money, and arithmetic about money should be testable
 * without a database, a network or a provider. There are no imports here except
 * types and the paise helpers, so `tests/conformance/split.mjs` can exercise
 * every rounding case directly rather than inferring them from a live order.
 *
 * That constraint is load-bearing and was nearly lost. A first draft imported
 * `AppError` for its two refusals, and the test could not load the module at
 * all — `errors.ts` uses TypeScript parameter properties, which Node's
 * strip-only type stripping cannot parse. The import was the warning, not the
 * obstacle: a function that decides who is owed what has no business knowing
 * about HTTP status codes. It RETURNS a refusal now, and the caller — which is
 * already in an HTTP context — turns that into an `AppError`.
 *
 * It also means the ONE place that decides who is owed what is a function with
 * a name, rather than an object literal assembled inline at a call site where
 * the next field added to `Distribution` would be quietly forgotten.
 */

import { paise, type Paise } from '../platform/money.js';
import type { SettlementMode } from '../platform/schema.js';
import type { SplitAllocation, SplitInput } from './provider.interface.js';

/**
 * The money columns an order actually carries.
 *
 * Six, not the nine `Distribution` computes. `quote.ts` derives commission tax,
 * operator-share tax and the rounding adjustment, but `order` persists only
 * these — the rest are recoverable from the fee-rule snapshot when a report
 * needs them.
 *
 * This mirrors the TABLE rather than the quote deliberately. A first draft of
 * this interface listed all nine and the compiler rejected the query, which is
 * the right outcome: an interface describing columns that do not exist would
 * have compiled the moment somebody defaulted them to zero, and a split built
 * from three silent zeroes is a split that looks correct and is not.
 */
export interface OrderMoney {
  readonly orderId: string;
  readonly totalPayablePaise: number;
  /** What the stall is owed for the food, after any commission. */
  readonly vendorNetPaise: number;
  /** GST on the food, retained by the platform under s.9(5). */
  readonly platformTaxReservePaise: number;
  readonly customerFeePaise: number;
  readonly customerFeeTaxPaise: number;
  readonly vendorCommissionPaise: number;
  readonly operatorSharePaise: number;
}

export interface BuildSplitInput {
  readonly money: OrderMoney;
  readonly settlementMode: SettlementMode;
  /** `vendor.cashfree_vendor_id`. Null when the stall is not onboarded. */
  readonly vendorLinkedAccountId: string | null;
}

/**
 * What `buildSplit` decides.
 *
 * Three outcomes, not two, because "no split applies" and "a split applies and
 * we cannot build it" are opposite situations that a nullable return would
 * collapse. The first is normal; the second must stop a payment.
 */
export type SplitDecision =
  /** Send these allocations with the order. */
  | { readonly kind: 'SPLIT'; readonly split: SplitInput }
  /** Nothing to divide — VENDOR_DIRECT, or a zero vendor net. */
  | { readonly kind: 'NONE' }
  /** A split is required and cannot be built. The caller must refuse the payment. */
  | { readonly kind: 'REFUSE'; readonly reason: string };

/**
 * The allocation decision for one order.
 *
 * `NONE` rather than an empty array: `order_splits: []` is a different
 * statement to Cashfree from sending no splits at all, and the distinction
 * matters under VENDOR_DIRECT where the platform is not the merchant.
 */
export function buildSplit(input: BuildSplitInput): SplitDecision {
  const { money, settlementMode, vendorLinkedAccountId } = input;

  /*
   * VENDOR_DIRECT: the money never reaches a platform account, so there is
   * nothing to split. Commission is invoiced later against the ledger, which
   * is the whole point of the mode.
   */
  if (settlementMode !== 'PLATFORM_COLLECT') return { kind: 'NONE' };

  /*
   * ========================================================================
   * REFUSE RATHER THAN ROUTE THE STALL'S MONEY TO OURSELVES
   * ========================================================================
   *
   * A stall with no Cashfree vendor id cannot be paid. The tempting behaviour
   * is to skip its allocation and let the payment succeed — and that is the
   * single most expensive silent failure in this system: the customer is
   * charged, the food is made, and the stall's share sits in the platform's
   * account with nothing anywhere recording that it should not be there.
   *
   * `order.repository` refuses placement for the same reason and earlier, so
   * reaching this is already a bug. It throws anyway: a guard that exists only
   * upstream is a guard that disappears the day somebody adds a second caller.
   */
  if (!vendorLinkedAccountId) {
    return {
      kind: 'REFUSE',
      reason:
        'This stall is not onboarded to payouts, so its share of a split payment ' +
        'cannot be routed. Onboard it before it takes orders.',
    };
  }

  /*
   * ========================================================================
   * WHAT THE STALL RECEIVES, AND WHY IT IS NOT `vendorNetPaise` ALONE
   * ========================================================================
   *
   * `vendorNetPaise` is the food money after commission. Under s.9(5) the GST
   * on the food is RETAINED BY THE PLATFORM — `platformTaxReservePaise` — and
   * `quote.ts` is emphatic about it: "Settle this to the vendor by mistake and
   * every order loses roughly 5% of its value against a commission of about
   * 3%."
   *
   * So the vendor's transfer is exactly `vendorNetPaise`, and everything else
   * stays with the platform by NOT being allocated away. Cashfree's Easy Split
   * gives the merchant whatever is not assigned to a linked account, so the
   * platform's share needs no allocation of its own — and sending one would be
   * a self-transfer that Cashfree rejects.
   */
  const vendorAmount = paise(money.vendorNetPaise);

  /*
   * Zero is legitimate — a fully discounted order, or one where commission
   * happens to equal the food value — and a zero-value transfer is not. Cashfree
   * refuses it, and it means the same thing as no allocation.
   */
  if (vendorAmount === 0) return { kind: 'NONE' };

  const allocations: SplitAllocation[] = [
    { party: 'VENDOR', linkedAccountId: vendorLinkedAccountId, amountPaise: vendorAmount },
  ];

  /*
   * ========================================================================
   * THE ARITHMETIC IS CHECKED HERE, NOT ASSUMED
   * ========================================================================
   *
   * The vendor's share must never exceed what the customer actually paid. That
   * cannot happen if the quote is correct — `platformShare` below is the sum of
   * the fee, its tax, the retained food GST, the commission and the rounding
   * adjustment, all of which are non-negative — so this fires only when a
   * distribution has been corrupted or a column has been mis-mapped.
   *
   * Which is exactly when it must fire. An over-allocation is a transfer of
   * more than was collected, and the alternative to throwing is discovering it
   * in a settlement report.
   */
  const allocated = allocations.reduce((n, a) => n + a.amountPaise, 0);
  if (allocated > money.totalPayablePaise) {
    return {
      kind: 'REFUSE',
      reason:
        `Split allocates ${allocated} paise of an order worth ` +
        `${money.totalPayablePaise}. Refusing to transfer more than was collected.`,
    };
  }

  const split: SplitInput = {
    orderId: money.orderId,
    /*
     * The idempotency key Cashfree sees for this division.
     *
     * Derived from the order id rather than random: `createIntent` is
     * documented as safe to call twice (PAY-REC-03) and returns the existing
     * live intent, so a retry must describe the SAME split rather than a second
     * one. A random id here would make a retry look like a new transfer.
     */
    transferId: `split-${money.orderId}`,
    totalPaise: paise(money.totalPayablePaise),
    allocations,
  };

  return { kind: 'SPLIT', split };
}

/**
 * What the platform keeps out of this order, in paise.
 *
 * DEFINED AS THE RESIDUE, not as a sum of its parts, and that is not laziness.
 * Cashfree's Easy Split gives the merchant whatever is not assigned to a linked
 * account — so the residue is not an approximation of the platform's share, it
 * IS the platform's share, by the mechanism that moves the money.
 *
 * Adding up the fee, its tax, the retained food GST and the commission would
 * produce the same number when everything is right and a DIFFERENT one when
 * something is wrong — and the version that disagrees with the payment
 * processor is the wrong one to report. It would also silently drift the day a
 * tenth money column is added and nobody updates the sum.
 *
 * Not sent to Cashfree. It exists so the ledger and the tests can state the
 * platform's take as a number rather than re-deriving it at three call sites.
 */
export function platformShare(money: OrderMoney): Paise {
  return paise(money.totalPayablePaise - money.vendorNetPaise);
}
