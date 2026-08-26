/**
 * Turns a priced quote into balanced double-entry ledger rows.
 *
 * PURE. No database, no clock, no ids. It returns the entries; the repository
 * writes them. That separation is what lets the balance property be tested
 * exhaustively with fast-check instead of against a fixture.
 *
 * TDD §8. PRD LED-01, LED-02.
 *
 * SIGN CONVENTION, since it is the thing everyone gets backwards:
 *
 *   CREDIT  money arriving from the customer side
 *   DEBIT   where that money is allocated
 *
 * Every order's entries must sum to zero across the two. `v_ledger_imbalance`
 * asserts it in the database, `assertBalanced` asserts it here, and the two
 * exist independently on purpose — an in-process check that is the only guard
 * is a guard that ships broken the day someone writes entries by another path.
 */

import { AppError } from '../platform/errors.js';
import { paise, type Paise } from '../platform/money.js';
import type { Quote } from '../pricing/quote.js';

export type LedgerDirection = 'DEBIT' | 'CREDIT';
export type LedgerParty = 'CUSTOMER' | 'VENDOR' | 'OPERATOR';

export type LedgerEntryType =
  | 'GROSS_ORDER_VALUE'
  | 'FOOD_TAX'
  | 'CUSTOMER_PLATFORM_FEE'
  | 'CUSTOMER_FEE_TAX'
  | 'VENDOR_COMMISSION'
  | 'VENDOR_COMMISSION_TAX'
  | 'OPERATOR_SHARE'
  | 'OPERATOR_SHARE_TAX'
  | 'PLATFORM_TAX_RESERVE'
  | 'VENDOR_NET_PAYABLE'
  /** The money going back to the customer. Written only by the refund path. */
  | 'REFUND'
  /** The vendor's share, clawed back. §14.7 — "may need clawing back". */
  | 'REFUND_REVERSAL_VENDOR'
  | 'ADJUSTMENT';

export interface LedgerEntry {
  readonly entryType: LedgerEntryType;
  readonly direction: LedgerDirection;
  readonly amountPaise: Paise;
  /** `null` means the platform itself — retained fees, tax reserve, residuals. */
  readonly party: LedgerParty | null;
}

/**
 * Zero-value rows are omitted rather than written.
 *
 * In VENDOR_DIRECT the customer fee is always zero, and in a court with no
 * operator share those two lines are always zero. Writing them anyway would
 * put four dead rows on every order — millions of them over a year — and make
 * every ledger export noisier for no information gain. The balance assertion
 * is unaffected: zero contributes nothing to either side.
 */
function push(out: LedgerEntry[], e: LedgerEntry): void {
  if (e.amountPaise > 0) out.push(e);
}

/**
 * The order-placement entries for a quote.
 *
 * NOT included, deliberately:
 *
 *   PROVIDER_FEE            booked when the aggregator reports it, which is
 *                           after settlement, not at placement. Booking an
 *                           estimate would make the ledger a forecast.
 *   REFUND / REVERSAL       written by the refund path (TDD §8.3).
 *   PLATFORM_CREDIT_*       written by the credit path.
 */
export function orderPlacementEntries(quote: Quote): readonly LedgerEntry[] {
  assertRepresentable(quote);

  const out: LedgerEntry[] = [];
  const d = quote.distribution;

  // --- CREDITS: what the customer side brought in ---------------------------
  push(out, {
    entryType: 'GROSS_ORDER_VALUE',
    direction: 'CREDIT',
    amountPaise: quote.subtotalPaise,
    party: 'CUSTOMER',
  });
  push(out, {
    entryType: 'FOOD_TAX',
    direction: 'CREDIT',
    amountPaise: quote.foodTaxPaise,
    party: 'CUSTOMER',
  });
  push(out, {
    entryType: 'CUSTOMER_PLATFORM_FEE',
    direction: 'CREDIT',
    amountPaise: quote.customerFeePaise,
    party: 'CUSTOMER',
  });
  push(out, {
    entryType: 'CUSTOMER_FEE_TAX',
    direction: 'CREDIT',
    amountPaise: quote.customerFeeTaxPaise,
    party: 'CUSTOMER',
  });

  // --- DEBITS: where it goes ------------------------------------------------
  push(out, {
    entryType: 'VENDOR_NET_PAYABLE',
    direction: 'DEBIT',
    amountPaise: d.vendorNetPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'VENDOR_COMMISSION',
    direction: 'DEBIT',
    amountPaise: d.vendorCommissionPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'VENDOR_COMMISSION_TAX',
    direction: 'DEBIT',
    amountPaise: d.vendorCommissionTaxPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'OPERATOR_SHARE',
    direction: 'DEBIT',
    amountPaise: d.operatorSharePaise,
    party: 'OPERATOR',
  });
  push(out, {
    entryType: 'OPERATOR_SHARE_TAX',
    direction: 'DEBIT',
    amountPaise: d.operatorShareTaxPaise,
    party: 'OPERATOR',
  });

  // party = null: the platform holds this, it is not owed to anyone yet.
  // Under s.9(5) the platform is the person liable for the food GST, so it
  // must NOT flow to the vendor. This row is the difference between
  // remitting correctly and overpaying every vendor by ~5% of order value.
  push(out, {
    entryType: 'PLATFORM_TAX_RESERVE',
    direction: 'DEBIT',
    amountPaise: d.platformTaxReservePaise,
    party: null,
  });

  // The customer fee and its tax, retained by the platform. Same amounts as
  // the CREDIT rows above and that is correct, not a duplicate: the credit
  // records collection from the customer, the debit records retention by the
  // platform. TDD §8.2 shows these collapsed onto one 590-paise line.
  push(out, {
    entryType: 'CUSTOMER_PLATFORM_FEE',
    direction: 'DEBIT',
    amountPaise: d.customerFeePaise,
    party: null,
  });
  push(out, {
    entryType: 'CUSTOMER_FEE_TAX',
    direction: 'DEBIT',
    amountPaise: d.customerFeeTaxPaise,
    party: null,
  });

  // Rounding residual. Always to the platform — never to the vendor and never
  // to the customer, because a residual that lands on a counterparty is an
  // amount somebody can dispute.
  push(out, {
    entryType: 'ADJUSTMENT',
    direction: 'DEBIT',
    amountPaise: d.platformAdjustmentPaise,
    party: null,
  });

  assertBalanced(out, quote);
  return out;
}

/**
 * The compensating entries for a full refund.
 *
 * WHY THIS IS A MIRROR AND NOT AN EDIT
 *
 * §14.6: corrections are new compensating entries; nothing is ever edited. The
 * ledger is append-only against every role including TRUNCATE, so "un-charging"
 * a customer is not something that can be expressed by removing rows even if
 * anybody wanted to. What a refund is, in double entry, is the placement
 * entries run backwards.
 *
 * So every CREDIT the placement made becomes a DEBIT here and vice versa, and
 * the amounts are the same ones — taken from the order's SNAPSHOTTED quote, not
 * from current fee rules. §15: "the order's snapshotted terms" is the authority
 * on what it cost, and a refund priced from today's commission would return a
 * different number from the one that was taken.
 *
 * Two rows carry refund-specific types because the enum names them and because
 * a settlement report needs to see them: `REFUND` is the leg facing the
 * customer, `REFUND_REVERSAL_VENDOR` is the vendor's share being clawed back.
 * The rest keep their original types so that summing any one type across an
 * order that was placed and refunded nets to zero — which is the property a
 * reconciliation actually needs.
 *
 * PARTIAL REFUNDS ARE REFUSED, DELIBERATELY.
 *
 * A partial refund has to say which slice of the distribution it reverses, and
 * that is not derivable: refunding one rejected item from a three-item order
 * changes the commission, possibly crosses a fee floor or cap, and may or may
 * not reduce the platform fee depending on rules nobody has written down. PRD
 * §19 row 4 has the same shape for discounts and credit, and takes the same
 * position — refused rather than guessed. Guessing here would produce a
 * plausible number that nobody could reconcile, which is worse than an error.
 */
export function orderRefundEntries(quote: Quote): readonly LedgerEntry[] {
  assertRepresentable(quote);

  const out: LedgerEntry[] = [];
  const d = quote.distribution;

  // --- DEBIT: the money leaving, back to the customer -----------------------
  push(out, {
    entryType: 'REFUND',
    direction: 'DEBIT',
    amountPaise: quote.grossPayablePaise,
    party: 'CUSTOMER',
  });

  // --- CREDITS: every share, given back -------------------------------------
  push(out, {
    entryType: 'REFUND_REVERSAL_VENDOR',
    direction: 'CREDIT',
    amountPaise: d.vendorNetPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'VENDOR_COMMISSION',
    direction: 'CREDIT',
    amountPaise: d.vendorCommissionPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'VENDOR_COMMISSION_TAX',
    direction: 'CREDIT',
    amountPaise: d.vendorCommissionTaxPaise,
    party: 'VENDOR',
  });
  push(out, {
    entryType: 'OPERATOR_SHARE',
    direction: 'CREDIT',
    amountPaise: d.operatorSharePaise,
    party: 'OPERATOR',
  });
  push(out, {
    entryType: 'OPERATOR_SHARE_TAX',
    direction: 'CREDIT',
    amountPaise: d.operatorShareTaxPaise,
    party: 'OPERATOR',
  });

  // The tax reserve goes back too. Under s.9(5) the platform was the person
  // liable for this GST; on a refunded order there was no restaurant service,
  // so there is no liability to hold against.
  push(out, {
    entryType: 'PLATFORM_TAX_RESERVE',
    direction: 'CREDIT',
    amountPaise: d.platformTaxReservePaise,
    party: null,
  });

  // The platform gives back the fee it retained. A refund that keeps the
  // platform fee is a platform charging for an order that did not happen.
  push(out, {
    entryType: 'CUSTOMER_PLATFORM_FEE',
    direction: 'CREDIT',
    amountPaise: d.customerFeePaise,
    party: null,
  });
  push(out, {
    entryType: 'CUSTOMER_FEE_TAX',
    direction: 'CREDIT',
    amountPaise: d.customerFeeTaxPaise,
    party: null,
  });
  push(out, {
    entryType: 'ADJUSTMENT',
    direction: 'CREDIT',
    amountPaise: d.platformAdjustmentPaise,
    party: null,
  });

  assertBalanced(out, quote);
  return out;
}

export function totalFor(entries: readonly LedgerEntry[], direction: LedgerDirection): Paise {
  let sum = 0;
  for (const e of entries) if (e.direction === direction) sum += e.amountPaise;
  return paise(sum);
}

/** PRD LED-02. Throws rather than returns — an unbalanced ledger must not be written. */
export function assertBalanced(entries: readonly LedgerEntry[], quote?: Quote): void {
  const debits = totalFor(entries, 'DEBIT');
  const credits = totalFor(entries, 'CREDIT');

  if (debits !== credits) {
    throw new AppError('LEDGER_IMBALANCED', 'Ledger entries do not balance', {
      debits: String(debits),
      credits: String(credits),
      delta: String(debits - credits),
    });
  }

  // Belt and braces: balancing to each other is necessary but not sufficient.
  // Two entries of 1 paise balance perfectly and represent nothing.
  if (quote && credits !== quote.grossPayablePaise) {
    throw new AppError('LEDGER_TOTAL_MISMATCH', 'Ledger total does not match the quote', {
      credits: String(credits),
      grossPayablePaise: String(quote.grossPayablePaise),
    });
  }
}

/**
 * Refuses quotes the TDD §8.1 entry catalogue cannot express.
 *
 * THIS IS A SPEC GAP, NOT A LIMITATION OF THIS FUNCTION.
 *
 * `QuoteInput` accepts `discountPaise` and `creditPaise`, and `computeQuote`
 * handles both. The ledger entry catalogue has no row type for either:
 *
 *   - A discount means the customer paid less than the parties are owed, so
 *     something must fund the difference. There is no DISCOUNT entry type, so
 *     there is no way to record who funded it — platform, vendor, or operator.
 *     Those are three different commercial arrangements and the ledger cannot
 *     currently tell them apart.
 *   - Applied platform credit means part of the payment came from a liability
 *     rather than from money. PLATFORM_CREDIT_CONSUMED exists, but the
 *     interaction with the customer-side credits above is unspecified.
 *
 * Guessing here would produce a ledger that balances and is wrong, which is
 * strictly worse than one that refuses. Neither feature is in pilot scope.
 * Close the catalogue gap in the TDD before either ships.
 */
function assertRepresentable(quote: Quote): void {
  if (quote.discountPaise > 0) {
    throw new AppError(
      'LEDGER_CANNOT_REPRESENT_DISCOUNT',
      'The TDD §8.1 entry catalogue has no discount row, so the funding party cannot be recorded. ' +
        'Add a DISCOUNT entry type and decide who funds it before enabling discounts.',
      { discountPaise: String(quote.discountPaise) },
    );
  }
  if (quote.creditAppliedPaise > 0) {
    throw new AppError(
      'LEDGER_CANNOT_REPRESENT_CREDIT_AT_PLACEMENT',
      'Applied platform credit at placement is not covered by TDD §8.1. Specify how ' +
        'PLATFORM_CREDIT_CONSUMED interacts with the customer-side credits first.',
      { creditAppliedPaise: String(quote.creditAppliedPaise) },
    );
  }
}
