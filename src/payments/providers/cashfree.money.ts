/**
 * ============================================================================
 * THE ONE PLACE PAISE BECOME RUPEES
 * ============================================================================
 *
 * Everything in this system is an integer count of paise in a branded `Paise`
 * type. PRD §14.5 is unusually emphatic about that, and it tells the story of
 * why: a driver returned BIGINTs as strings, `"18000" + "500"` concatenated to
 * `18000500`, and a ₹185 order became a ₹180,005 charge with no exception and
 * no compile error.
 *
 * Cashfree's API does not take paise. `order_amount` is a FLOAT in rupees to
 * two decimal places — `101.12` means one hundred and one rupees, twelve paise.
 *
 * So there is exactly one boundary in this integration where the branded
 * integer becomes an IEEE-754 double, and it is this file. Everything
 * upstream stays in paise; everything downstream of the HTTP response converts
 * straight back. Nothing else in the codebase is allowed to hold a rupee float.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS IS NOT `paise / 100`
 * ----------------------------------------------------------------------------
 *
 * Because that is wrong often enough to matter, in both directions:
 *
 *   (268.4 * 100)        -> 26839.999999999996
 *   (0.1 + 0.2) * 100    -> 30.000000000000004
 *
 * A binary double cannot represent most two-decimal values exactly. Sending
 * `268.40000000000003` to a payment API is at best rejected and at worst
 * silently truncated; reading a rupee amount back with `* 100` and flooring
 * loses a paisa per order, which reconciliation then reports for ever.
 *
 * Both directions below go via a STRING with a fixed two decimals, because the
 * decimal representation is the thing both sides actually agree on. It is the
 * shortest path from an exact integer to an exact integer that survives a JSON
 * round trip through a float.
 */

import { paise, type Paise } from '../../platform/money.js';

/**
 * The largest amount this will convert, in paise. ₹10,00,000.
 *
 * Not a Cashfree limit — a blast radius. Above this, a bug has happened: the
 * biggest legitimate food-court order is three digits of rupees, and the
 * failure mode this codebase has already survived once turns ₹185 into
 * ₹1,80,005. A ceiling converts that from a charge into an exception.
 *
 * `Number.MAX_SAFE_INTEGER` would also be "safe" arithmetically and is the
 * wrong bound, because it permits every amount anybody could plausibly be
 * wrongly charged.
 */
const MAX_PAISE = 100_000_000;

export class MoneyConversionError extends Error {}

/**
 * Integer paise -> the rupee number Cashfree's `order_amount` wants.
 *
 * Returns a `number` because the field is a JSON number and quoting it changes
 * the type on the wire. The value is produced from a string so it is the
 * closest double to an exact two-decimal quantity, which is the best any JSON
 * number can be.
 */
export function paiseToRupees(value: Paise): number {
  const n = Number(value);

  if (!Number.isInteger(n)) {
    throw new MoneyConversionError(
      `Paise must be an integer, got ${n}. A fractional paisa means a division happened upstream.`,
    );
  }
  if (n < 0) {
    throw new MoneyConversionError(`Refusing to send a negative amount (${n} paise) to a provider.`);
  }
  if (n > MAX_PAISE) {
    throw new MoneyConversionError(
      `${n} paise (₹${(n / 100).toFixed(2)}) exceeds the ₹${MAX_PAISE / 100} ceiling. ` +
        `This is a bug, not a large order.`,
    );
  }

  /*
   * Build the decimal by SPLITTING THE INTEGER, not by dividing it.
   *
   * `n / 100` is a float division and is where the representation error is
   * introduced. Integer division and remainder are exact, and the string they
   * produce is exact; `Number()` then yields the nearest double to a value that
   * really does have two decimal places.
   */
  const whole = Math.floor(n / 100);
  const fraction = n % 100;
  return Number(`${whole}.${String(fraction).padStart(2, '0')}`);
}

/**
 * A rupee amount from Cashfree -> integer paise.
 *
 * Accepts a string as well as a number because providers are inconsistent about
 * which they send for money, sometimes within one API. A string is the better
 * case and must not be coerced through a float on the way in.
 */
export function rupeesToPaise(value: number | string): Paise {
  if (typeof value === 'string') {
    /*
     * Parse the decimal by hand rather than via `parseFloat`.
     *
     * `"268.40"` -> 26840 exactly. Going through a float first would reintroduce
     * the error this function exists to avoid, on the one path where the
     * provider handed us an exact decimal and we still had a chance to keep it.
     */
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!m) {
      throw new MoneyConversionError(`Cannot read "${value}" as a rupee amount.`);
    }
    const decimals = m[3] ?? '';
    if (decimals.length > 2) {
      throw new MoneyConversionError(
        `"${value}" has ${decimals.length} decimal places. The smallest unit is a paisa; ` +
          `anything finer cannot be settled and must not be silently rounded here.`,
      );
    }
    const sign = m[1] === '-' ? -1 : 1;
    const whole = Number(m[2]);
    const frac = Number(decimals.padEnd(2, '0'));
    return guard(sign * (whole * 100 + frac));
  }

  if (!Number.isFinite(value)) {
    throw new MoneyConversionError(`Cannot read ${value} as a rupee amount.`);
  }

  /*
   * ==========================================================================
   * MORE THAN TWO DECIMALS IS AN ERROR, NOT A ROUNDING PROBLEM
   * ==========================================================================
   *
   * This function first did `Math.round(Number(value.toFixed(2)) * 100)`, and
   * the comment claimed that fixed the classic `Math.round(2.675 * 100)` trap.
   * A round-trip test proved the comment backwards:
   *
   *     Math.round(2.675 * 100)              -> 268
   *     Math.round((2.675).toFixed(2) * 100) -> 267
   *
   * `2.675` is stored as 2.674999999999999822…, so `toFixed(2)` reads it as
   * "2.67" while the multiplication happens to land on 267.5 and rounds up.
   * Both answers are one paisa apart and BOTH are guesses about a number the
   * double no longer remembers.
   *
   * There is no rounding rule that recovers the intent, so this refuses instead.
   * PRD §14.5 puts rounding "at defined points" — a provider's response is not
   * one of them. Cashfree quotes money to two decimals; a third decimal here
   * means either a provider change or a bug upstream, and both deserve a loud
   * failure rather than a quietly invented paisa.
   *
   * The whole-rupee and two-decimal cases are exact and unaffected.
   */
  const asText = String(value);
  const dot = asText.indexOf('.');
  if (dot !== -1 && asText.length - dot - 1 > 2 && !asText.includes('e')) {
    throw new MoneyConversionError(
      `${value} has more than two decimal places. Refusing to round: the result would be ` +
        `a paisa the provider did not send. Fix the caller, or pass the exact string.`,
    );
  }

  /*
   * Round the product rather than trusting it. `268.4 * 100` is
   * 26839.999999999996 — exact enough to be within half a paisa of the truth,
   * which is all `Math.round` needs to recover the integer.
   */
  return guard(Math.round(value * 100));
}

function guard(n: number): Paise {
  if (!Number.isInteger(n)) {
    throw new MoneyConversionError(`Conversion produced a fractional paisa (${n}).`);
  }
  if (Math.abs(n) > MAX_PAISE) {
    throw new MoneyConversionError(`Converted amount ${n} paise exceeds the safety ceiling.`);
  }
  return paise(n);
}
