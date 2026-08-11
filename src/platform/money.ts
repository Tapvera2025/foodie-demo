/**
 * Money.
 *
 * PRD v5.2 PAY-05 / DATA-02: all monetary values are integer paise, end to end,
 * including in API payloads and database columns. There is no float, no decimal
 * library and no string representation anywhere in a financial path.
 *
 * The brand makes that a type error rather than a code-review convention.
 *
 * TDD §3.1.
 */

const BRAND: unique symbol = Symbol('Paise');

export type Paise = number & { readonly [BRAND]: 'Paise' };

/** Largest value we can represent exactly: ₹92,233,720,368.54 in paise. */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * The only way to create a Paise value. Rejects anything that is not an exact
 * integer within the safe range — including NaN, Infinity and 1.5.
 */
export function paise(n: number): Paise {
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new MoneyError(`money must be a number, got ${String(n)}`);
  }
  if (!Number.isInteger(n)) {
    throw new MoneyError(`money must be integer paise, got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`money out of safe integer range: ${n}`);
  }
  return n as Paise;
}

export const ZERO: Paise = paise(0);

/** Parse rupees from an external source (menu import, provider payload). */
export function rupeesToPaise(rupees: string | number): Paise {
  const s = typeof rupees === 'number' ? rupees.toString() : rupees.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    // Interface Specs §4.2: a price with three decimals is an error, never a
    // silent rounding. A rounded price is a vendor dispute.
    throw new MoneyError(`invalid rupee amount "${s}" — expected at most 2 decimal places`);
  }
  const negative = s.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? s.slice(1) : s).split('.');
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return paise(negative ? -value : value);
}

export function add(...xs: Paise[]): Paise {
  return paise(xs.reduce<number>((a, b) => a + b, 0));
}

export function sub(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function mul(a: Paise, factor: number): Paise {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(`quantity multiplier must be an integer, got ${factor}`);
  }
  return paise(a * factor);
}

/**
 * Apply a rate expressed in basis points. 10000 bps = 100%, 500 bps = 5%.
 *
 * Rounding is HALF-UP, always. Not banker's rounding.
 *
 * Reason (TDD §3.1): a customer bill and a vendor statement must be
 * reproducible by hand with a calculator. Banker's rounding is statistically
 * nicer and operationally indefensible in a dispute with a stall owner.
 */
export function applyBps(amount: Paise, bps: number): Paise {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new MoneyError(`bps must be an integer in [0, 10000], got ${bps}`);
  }
  const product = amount * bps;
  // Math.floor((x + 5000) / 10000) is half-up for non-negative x.
  // Negative amounts round half-away-from-zero so a reversal mirrors the
  // original exactly — otherwise a refund would not net to zero.
  const rounded =
    product >= 0 ? Math.floor((product + 5000) / 10000) : -Math.floor((-product + 5000) / 10000);
  return paise(rounded);
}

/** Clamp to a floor and an optional cap. Used by the fee engine. */
export function clamp(amount: Paise, floor: Paise, cap?: Paise): Paise {
  let v: number = amount;
  if (v < floor) v = floor;
  if (cap !== undefined && v > cap) v = cap;
  return paise(v);
}

export function isZero(a: Paise): boolean {
  return a === 0;
}

export function max(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

export function min(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/** Display only. Never use the output of this for arithmetic. */
export function formatINR(a: Paise): string {
  const negative = a < 0;
  const abs = Math.abs(a);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  // Indian digit grouping: last three, then pairs.
  const s = String(whole);
  const head = s.length > 3 ? s.slice(0, -3) : '';
  const tail = s.length > 3 ? s.slice(-3) : s;
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${negative ? '-' : ''}₹${grouped}.${frac}`;
}
