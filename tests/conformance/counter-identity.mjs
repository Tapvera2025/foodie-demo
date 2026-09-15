/**
 * ============================================================================
 * COUNTER IDENTITY RESTS ON ONE PROPERTY. THIS IS THAT PROPERTY.
 * ============================================================================
 *
 * `ORDER_IDENTITY_MODE=counter` lets somebody place an order without verifying
 * a mobile number, because an OTP cannot be delivered on a court with no route
 * to the internet. The argument that this is safe has exactly one load-bearing
 * step:
 *
 *     AN UNPAID ORDER IS NEVER SHOWN TO A KITCHEN.
 *
 * An order is written as `CREATED`. The board in `ordering/kds.controller.ts`
 * lists `PAYMENT_CONFIRMED` and later. So the worst an unverified caller can do
 * is write a row nobody cooks from — noise in a table rather than a free meal.
 *
 * WHY THAT NEEDS A CHECK
 *
 * Because the two halves are three files apart and neither mentions the other
 * in code. Adding `PAYMENT_PENDING` to the board is a one-word change that
 * looks like a feature — "show the kitchen what is coming so they can prep" is
 * a reasonable thing for a vendor to ask for — and on an `otp` deployment it is
 * harmless, because the customer has already been charged. On a `counter`
 * deployment the same word means anybody on the venue WiFi can send tickets to
 * a kitchen for food they have not paid for.
 *
 * Nothing would fail. The kitchen would simply start receiving orders.
 *
 * WHAT ELSE IT HOLDS
 *
 * That counter mode cannot be switched on without a counter, and that it has
 * not leaked into the routes that move money.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/** The statuses an order passes through before anybody has been paid. */
const UNPAID = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED'];

/**
 * The contents of `const LIVE: readonly OrderStatus[] = [ ... ]`.
 *
 * Read out of the source rather than imported: this file is a `.mjs` check that
 * runs under plain node, and importing a TypeScript module from the middle of a
 * Nest dependency graph to read one array is a great deal of machinery to be
 * wrong about.
 */
function liveStatuses(src) {
  const m = src.match(/const LIVE:[^=]*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

const kds = read('src/ordering/kds.controller.ts');
const live = liveStatuses(kds);

console.log('\nan unpaid order never reaches a kitchen');
console.log('─'.repeat(78));

check(
  `found the KDS board's status filter (${live ? live.join(', ') : 'NOT FOUND'})`,
  live !== null && live.length > 0,
  'Could not read `const LIVE` out of src/ordering/kds.controller.ts. Either the\n        board stopped filtering by status, or this parser no longer matches it —\n        and every assertion below is then proving nothing.',
);

if (live) {
  for (const status of UNPAID) {
    check(
      `the board does not show ${status}`,
      !live.includes(status),
      `${status} is in LIVE, so a kitchen can see an order that nobody has paid for.\n        Under ORDER_IDENTITY_MODE=counter that is a way to order food without\n        paying: no OTP is required to place it, and the ticket prints anyway.\n        See the note at the top of src/identity/order-identity.guard.ts.`,
    );
  }
}

console.log('\ncounter identity cannot be switched on without a counter');
console.log('─'.repeat(78));

const cfg = read('src/platform/config.ts');

check(
  'boot refuses counter mode unless payments settle at a POS terminal',
  /ORDER_IDENTITY_MODE === 'counter' && cfg\.PAYMENTS_PROVIDER !== 'pos'/.test(cfg),
  "loadConfig no longer ties ORDER_IDENTITY_MODE=counter to PAYMENTS_PROVIDER=pos.\n        Counter identity replaces the OTP with a cashier and a card machine; with a\n        remote aggregator there is no cashier, and the check on who is ordering is\n        simply gone.",
);

console.log('\nthe relaxation has not spread to the routes that move money');
console.log('─'.repeat(78));

/*
 * Placing an order without an OTP is the whole point. Charging, cancelling and
 * refunding are not, and each of them acts on money that already exists.
 *
 * Matched on the decorator pair rather than the route name, because a route
 * that quietly swapped its guard is exactly the change this is looking for.
 */
const order = read('src/ordering/order.controller.ts');
const payment = read('src/payments/payment.controller.ts');

function guardFor(src, route) {
  const re = new RegExp(`@(?:Get|Post)\\('${route.replace(/[/:]/g, '\\$&')}'\\)\\s*\\n\\s*@UseGuards\\(([^)]*)\\)`);
  const m = src.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

for (const [src, route, file] of [
  [order, 'orders/:orderId/cancel', 'order.controller.ts'],
  [payment, 'orders/:orderId/payment-intent', 'payment.controller.ts'],
  [payment, 'orders/:orderId/payment', 'payment.controller.ts'],
]) {
  const guards = guardFor(src, route);
  check(
    `${route} still requires a verified customer`,
    guards !== null && guards.includes('CustomerGuard') && !guards.includes('OrderIdentityGuard'),
    guards === null
      ? `Could not find the guard for this route in ${file}. If it moved, this check\n        stopped watching it.`
      : `guarded by (${guards}).\n        OrderIdentityGuard accepts an unverified caller under counter mode. On a\n        route that opens a payment or cancels an order, that is not the trade\n        counter mode was argued for.`,
  );
}

// ============================================================================
// Negative control — the check must be able to fail
// ============================================================================
console.log('\nnegative control');
console.log('─'.repeat(78));

/*
 * "Show the kitchen what is coming so they can start prepping." The single most
 * plausible way this property gets deleted, and it arrives as a feature request
 * rather than as a security change.
 */
const sabotaged = kds.replace(
  /const LIVE:([^=]*)=\s*\[/,
  "const LIVE:$1= [\n  'PAYMENT_PENDING',",
);
const sabotagedLive = liveStatuses(sabotaged);

check(
  'a PAYMENT_PENDING board is caught',
  sabotagedLive !== null && sabotagedLive.includes('PAYMENT_PENDING'),
  'With an unpaid status added to the board, the parser did not see it — so the\n        assertions above would pass through exactly the change they exist to stop.',
);

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
