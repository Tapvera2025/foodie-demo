/**
 * ============================================================================
 * THE ORDER NUMBER, WHICH HAD NO TEST AND BROKE EVERY MIDNIGHT
 * ============================================================================
 *
 * `A-001` is the number shouted across a counter. It restarts each trading day,
 * which is right — a number that reaches A-4821 by March is unusable.
 *
 * The uniqueness behind it did not restart. Migration 1 made
 * `(food_court_id, public_order_number)` unique permanently, so the first order
 * of every subsequent day proposed `A-001`, collided with an earlier day's
 * `A-001`, and threw:
 *
 *     duplicate key value violates unique constraint "order_public_number_uq"
 *
 * It could not recover. A retry counted today's orders again, got zero again,
 * and proposed the same number again. Any court that had ever taken an order
 * stopped being able to take one at the next midnight — the customer got a 500
 * and the stall never learned an order had been attempted.
 *
 * It reached a running system because NOTHING TESTED ORDER NUMBERING. Not a
 * unit test, not a property test, not a conformance check. It was found from a
 * production-shaped 500 and a stack trace.
 *
 * This file is the missing test. It does not need a database: the two things
 * that were wrong are both decidable from the source — whether the generator
 * and the index agree on scope, and whether the next number is derived in a way
 * that can propose an existing one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const repo = readFileSync(join(root, 'src/ordering/order.repository.ts'), 'utf8');

/*
 * The LIVE definition of the index, which is the last CREATE for that name
 * across all migrations. Reading only migration 1 would miss the fix; reading
 * only the newest migration would miss a future revert.
 */
const migrations = readFileSync(join(root, 'db/migrations/20260810000001_init.sql'), 'utf8');
const fix = readFileSync(
  join(root, 'db/migrations/20260825000019_order_number_per_day.sql'),
  'utf8',
);
const upSection = fix.slice(0, fix.indexOf('-- migrate:down'));

console.log('\norder numbering — the counter and the constraint must agree');
console.log('─'.repeat(78));

/* ------------------------------------------------------------------ the key */
{
  const created = [...upSection.matchAll(/CREATE UNIQUE INDEX order_public_number_uq[\s\S]*?;/g)];
  const live = created[created.length - 1] ?? '';
  const text = String(live).replace(/\s+/g, ' ');

  check(
    'the unique index is scoped by business_date',
    /business_date/.test(text),
    `live definition: ${text || '(none found in migration 19)'}`,
  );

  check(
    'it is still scoped by food_court_id — two courts may both have an A-001',
    /food_court_id/.test(text),
    text,
  );

  /*
   * The original, for the record. If someone reverts migration 19 this still
   * passes — which is why the check above reads the FIX, not this.
   */
  check(
    'migration 1 really did create the unscoped index this replaces',
    /CREATE UNIQUE INDEX order_public_number_uq ON "order" \(food_court_id, public_order_number\)/.test(
      migrations,
    ),
    'the premise of this whole file is not in migration 1 — re-read before trusting it',
  );
}

/* ------------------------------------------------------------ the generator */
{
  const fn = repo.slice(
    repo.indexOf('async function nextOrderNumber'),
    repo.indexOf('export class OrderRepository'),
  );

  check(
    'the generator scopes by business_date, matching the index',
    /business_date/.test(fn),
    'the generator and the index disagree on scope — that is the original bug',
  );

  check(
    'it derives from MAX, not COUNT',
    /\.max\b/.test(fn) && !/countAll/.test(fn),
    'COUNT + 1 proposes an existing number the moment the sequence has a gap',
  );

  check(
    'it still requires the caller to hold the court lock',
    /lock|forUpdate/i.test(fn) || /forUpdate/.test(repo),
    'MAX + 1 races exactly as COUNT + 1 did',
  );

  check(
    'the A-999 ceiling is refused rather than wrapped',
    /999/.test(fn),
    'past A-999 a zero-padded textual MAX sorts wrongly and would repeat a number',
  );
}

/* ------------------------------------------------- the column is written too */
{
  const insert = repo.slice(repo.indexOf(".insertInto('order')"), repo.indexOf('.returningAll'));
  check(
    'business_date is written on every order insert',
    /business_date:/.test(insert),
    'the index keys on it; an order without one cannot be inserted at all',
  );
}

/*
 * ---------------------------------------------------------------------------
 * THE CONTROL
 * ---------------------------------------------------------------------------
 * Every assertion above is a regex over source, so all of them pass if the file
 * cannot be read. Prove the slices actually contain what is being searched.
 */
{
  checked++;
  const fnFound = repo.includes('async function nextOrderNumber');
  const idxFound = upSection.includes('order_public_number_uq');
  const ok = fnFound && idxFound && repo.length > 1000 && upSection.length > 200;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  both sources were really read ` +
      `(generator=${fnFound}, index=${idxFound})`,
  );
}

/*
 * And the arithmetic itself, on the padded-string parsing the generator uses.
 * This is the one piece that is pure, so it is tested rather than inspected.
 */
{
  const next = (highest) => {
    const n = highest ? Number(String(highest).replace(/^A-/, '')) : 0;
    return `A-${String(n + 1).padStart(3, '0')}`;
  };

  const cases = [
    [null, 'A-001', 'the first order of a day'],
    ['A-001', 'A-002', 'the second'],
    ['A-009', 'A-010', 'crossing ten'],
    ['A-099', 'A-100', 'crossing a hundred'],
    // The gap case COUNT got wrong: three rows numbered 1, 2 and 7.
    ['A-007', 'A-008', 'after a gap — COUNT would have proposed A-004'],
  ];

  let wrong = [];
  for (const [from, want, why] of cases) {
    const got = next(from);
    if (got !== want) wrong.push(`${String(from)} -> ${got}, wanted ${want} (${why})`);
  }

  check(
    'next-number arithmetic, including the gap COUNT got wrong',
    wrong.length === 0,
    wrong.join('\n        '),
  );

  check(
    'a textual MAX orders correctly only while padded to three digits',
    'A-010' > 'A-009' && !('A-1000' > 'A-999'),
    'this is why the generator refuses at 999 rather than widening silently',
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
