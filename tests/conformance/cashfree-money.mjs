/**
 * ============================================================================
 * THE PAISE / RUPEE BOUNDARY
 * ============================================================================
 *
 * Cashfree's `order_amount` is a float in rupees. Everything else in this
 * system is an integer count of paise. That conversion is the single highest-
 * consequence line in the payment integration, and PRD §14.5 already tells the
 * story of what a money-typing slip costs here: `"18000" + "500"` concatenated
 * to `18000500`, turning a ₹185 order into a ₹180,005 charge with no exception
 * and no compile error.
 *
 * So this does not sample. It converts EVERY paise value from ₹0 to ₹20,000 to
 * rupees and back, both through the number path and the string path, and
 * asserts it lands on the integer it started from. Two million round trips is
 * about a second, and ₹20,000 is two orders of magnitude above the largest
 * order a food court will ever take — so "every amount that can occur" is
 * literally true rather than a figure of speech.
 *
 * WHAT THIS ALREADY CAUGHT
 *
 * The first version of `rupeesToPaise` used `Math.round(Number(v.toFixed(2)) *
 * 100)`, with a comment claiming it fixed the classic `Math.round(2.675 * 100)`
 * trap. Running it printed the opposite:
 *
 *     Math.round(2.675 * 100)              -> 268
 *     Math.round((2.675).toFixed(2) * 100) -> 267
 *
 * The comment was backwards AND both answers were guesses about a number the
 * double no longer holds. The function now refuses a third decimal instead of
 * inventing a paisa, and the case below pins that.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,export async function resolve(s,c,n){return n(s.replace(/\\.js$/,".ts"),c)}',
  pathToFileURL('./'),
);

const { paiseToRupees, rupeesToPaise, MoneyConversionError } = await import(
  '../../src/payments/providers/cashfree.money.ts'
);

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function rejects(name, fn) {
  checked++;
  try {
    const got = fn();
    failures++;
    console.log(`  FAIL  ${name} was accepted, returned ${got}`);
  } catch (e) {
    const right = e instanceof MoneyConversionError;
    if (!right) failures++;
    console.log(`  ${right ? 'ok  ' : 'FAIL'}  ${name} refused${right ? '' : ' with the WRONG error type'}`);
  }
}

console.log('\ncashfree money — every amount that can occur');
console.log('─'.repeat(78));

/* ---------------------------------------------------------------- exhaustive */
{
  const CEILING = 2_000_000; // ₹20,000 in paise
  let firstBad = null;
  for (let p = 0; p <= CEILING; p++) {
    const rupees = paiseToRupees(p);
    if (rupeesToPaise(rupees) !== p || rupeesToPaise(rupees.toFixed(2)) !== p) {
      firstBad = { p, rupees, viaNumber: rupeesToPaise(rupees), viaString: rupeesToPaise(rupees.toFixed(2)) };
      break;
    }
  }
  check(
    `every paise value from ₹0 to ₹20,000 round-trips, as a number and as a string`,
    firstBad === null,
    firstBad ? JSON.stringify(firstBad) : '',
  );
}

/* ------------------------------------------------------------- the float traps */
console.log('\nthe specific values a naive conversion gets wrong');
console.log('─'.repeat(78));

check('26840 paise is 268.4, not 268.40000000000003', paiseToRupees(26840) === 268.4);
check(
  '268.4 comes back as 26840, though 268.4 * 100 is 26839.999999999996',
  rupeesToPaise(268.4) === 26840,
  `268.4 * 100 = ${268.4 * 100}`,
);
check('"268.40" as a string is exact', rupeesToPaise('268.40') === 26840);
check('a single paisa survives', paiseToRupees(1) === 0.01 && rupeesToPaise(0.01) === 1);
check('99 paise does not become a rupee', paiseToRupees(99) === 0.99 && rupeesToPaise(0.99) === 99);
check('a whole rupee has no trailing noise', paiseToRupees(100) === 1);

/* The PRD's own worked example, §14.4. If the boundary cannot carry the number
   the specification uses to explain itself, nothing downstream is trustworthy. */
check(
  "the PRD §14.4 worked example (₹268.40) survives the boundary",
  paiseToRupees(26840) === 268.4 && rupeesToPaise(paiseToRupees(26840)) === 26840,
);

/* ------------------------------------------------------------------- refusals */
console.log('\nwhat it refuses rather than guessing');
console.log('─'.repeat(78));

rejects('a third decimal place as a number (2.675)', () => rupeesToPaise(2.675));
rejects('a third decimal place as a string ("2.675")', () => rupeesToPaise('2.675'));
rejects('a fractional paisa', () => paiseToRupees(1.5));
rejects('a negative amount', () => paiseToRupees(-1));
rejects('an amount past the ₹10,00,000 ceiling', () => paiseToRupees(200_000_000));
rejects('a non-numeric string', () => rupeesToPaise('abc'));
rejects('an empty string', () => rupeesToPaise(''));
rejects('NaN', () => rupeesToPaise(NaN));
rejects('Infinity', () => rupeesToPaise(Infinity));

/*
 * The third-decimal refusal is the interesting one, so state WHY in the output:
 * a reader who hits this failing needs to know it is deliberate.
 */
console.log(
  '        (a third decimal is refused because 2.675 is stored as 2.67499999…,\n' +
    '         so rounding it either way invents a paisa the provider never sent)',
);

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
