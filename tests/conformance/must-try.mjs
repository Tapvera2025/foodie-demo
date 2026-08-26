/**
 * ============================================================================
 * THE STALL'S PICK AND THE MEASURED BESTSELLER MUST NOT BECOME ONE THING
 * ============================================================================
 *
 * `discovery.controller.ts` computes "Bestseller" from SUM(quantity) over
 * seven days of non-rejected order lines, and the note above that query is
 * emphatic about why it is not a flag somebody types in:
 *
 *     "a vendor-editable 'featured' flag becomes a badge on everything within
 *      a week, which is the same as a badge on nothing"
 *
 * A kitchen-set recommendation was then added anyway — because a cook knows
 * things a sales count cannot, and a dish launched yesterday has no history.
 * The two coexist ONLY while they stay distinguishable. The moment they share
 * a field, a word, or a badge, the measured one silently becomes as
 * unfalsifiable as the typed-in one, and the argument above is lost without
 * anybody deciding to lose it.
 *
 * That erosion is not a thing typechecking or a unit test would catch. It
 * looks like tidying up.
 *
 * ----------------------------------------------------------------------------
 * AND THE CAP HAS TO BE THE SERVER'S
 * ----------------------------------------------------------------------------
 *
 * Three per stall is what stops "must try" spreading across a whole menu. The
 * kitchen board disables the button at the cap, which is a courtesy — it is not
 * enforcement, because a disabled button is one `curl` away from irrelevant.
 * The endpoint counts inside a transaction holding `FOR UPDATE` on the vendor
 * row, and these checks assert that specifically: a plain COUNT-then-UPDATE
 * lets two tablets both read 2 and both write.
 *
 * Run: node tests/conformance/must-try.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { stripComments } from './_source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

const inventory = read('src/catalog/inventory.controller.ts');
const discovery = read('src/tenancy/discovery.controller.ts');
const custMenu = read('apps/pwa/src/screens/Menu.tsx');
const kdsMenu = read('apps/kds/src/Menu.tsx');
const schema = read('src/platform/schema.ts');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

console.log('\nmust try — a stall opinion, kept apart from a measurement');
console.log('─'.repeat(78));

/* ------------------------------------------- the two stay different things */
{
  check(
    'the bestseller is still computed from units sold',
    /order_item\.quantity/.test(discovery) && /is_rejected/.test(discovery),
    'if this stops summing real quantities, "Bestseller" is no longer a fact ' +
      'and the whole reason for a separate must-try flag is gone',
  );

  check(
    'nothing lets a vendor write to the bestseller',
    !/set\(\{[^}]*bestseller/i.test(inventory),
    'the kitchen must not be able to set the measured badge — that is the one ' +
      'property this design rests on',
  );

  /*
   * The customer app must SHOW them differently. Same field, same badge, same
   * word: any of the three collapses the distinction for the person it was
   * built for, which is the only person who matters here.
   */
  check(
    'the customer menu renders two distinct badges',
    /item\.bestseller/.test(custMenu) && /item\.mustTry/.test(custMenu),
    'both fields have to reach the row, or one of them is decoration',
  );

  /*
   * SCOPED TO EACH BADGE'S OWN JSX, and the first version was not.
   *
   * It asked whether the words "Bestseller" and "Must try" both appeared
   * anywhere in the file. Under mutation — relabelling the stall's badge to
   * "Bestseller" — it stayed GREEN, because the filter chip further up still
   * said "Must try". The check was satisfied by a string that had nothing to
   * do with the thing being checked, which is the same blindness as reading a
   * comment instead of code.
   *
   * The real property is local: the block guarded by `item.mustTry` says "Must
   * try" and does NOT say "Bestseller", and the block guarded by
   * `item.bestseller` says the reverse.
   */
  const badge = (guard) => {
    const at = custMenu.indexOf(guard);
    return at === -1 ? '' : custMenu.slice(at, custMenu.indexOf(') : null}', at));
  };
  const mustTryBadge = badge('item.mustTry && item.available');
  const bestsellerBadge = badge('item.bestseller && item.available');

  check(
    'both badge blocks were located',
    mustTryBadge.length > 80 && bestsellerBadge.length > 80,
    `mustTry=${mustTryBadge.length} chars, bestseller=${bestsellerBadge.length} — ` +
      `the two checks below prove nothing otherwise`,
  );

  check(
    "the stall's pick is labelled \"Must try\", never \"Bestseller\"",
    /Must try/.test(mustTryBadge) && !/Bestseller/.test(mustTryBadge),
    'rendering the stall\'s pick as "Bestseller" is exactly the erosion this ' +
      'file exists to prevent — a typed-in claim wearing a measured one\'s word',
  );

  check(
    'the measured badge keeps its own word',
    /Bestseller/.test(bestsellerBadge) && !/Must try/.test(bestsellerBadge),
    'the two must not converge from either direction',
  );

  check(
    'the filter chips keep them separate too',
    /'bestsellers'/.test(custMenu) && /'must-try'/.test(custMenu),
    'one merged "Popular" chip would make the measured badge unfalsifiable ' +
      'from the filter row instead of from the dish row',
  );
}

/* ------------------------------------------------ the cap is the server's */
{
  const fn = inventory.slice(
    inventory.indexOf('async setMustTry'),
    inventory.indexOf('async setStock') > inventory.indexOf('async setMustTry')
      ? inventory.indexOf('async setStock')
      : inventory.length,
  );

  check(
    'the setMustTry endpoint was found',
    fn.length > 400,
    `sliced ${fn.length} chars — every check below would pass vacuously`,
  );

  check(
    'it runs in a transaction',
    /this\.db\.transaction\(\)/.test(fn),
    'a count and an update in two statements outside a transaction is the race ' +
      'this cap exists to lose',
  );

  check(
    'it takes FOR UPDATE on the vendor row before counting',
    /forUpdate\(\)/.test(fn) &&
      fn.indexOf('forUpdate()') < fn.indexOf('must_try'),
    'without the lock two tablets both read 2, both write, and the stall ends ' +
      'up with four picks. The lock has to come BEFORE the count, or it is ' +
      'locking nothing that matters.',
  );

  check(
    'it refuses past the limit with its own error code',
    /MUST_TRY_LIMIT_REACHED/.test(fn),
    'a generic failure tells the kitchen board nothing it can act on',
  );

  check(
    'the count excludes the item being changed',
    /'menu_item\.id', '!=', item\.id/.test(fn),
    're-marking an already-marked dish must be a no-op, not a refusal — a ' +
      'tablet retrying a delivered request would otherwise be told the stall ' +
      'is full',
  );

  check(
    'it requires menu.write, not stock.toggle',
    /this\.scope\(req, 'menu\.write'\)/.test(fn),
    'this is a claim about the stall shown on the most-read customer screen — ' +
      'the same bar as a price or the offer banner, not the same bar as ' +
      'marking something sold out for an afternoon',
  );
}

/* --------------------------------------- the two copies of the limit agree */
{
  const server = /const MUST_TRY_LIMIT = (\d+)/.exec(inventory)?.[1];
  const client = /const MUST_TRY_LIMIT = (\d+)/.exec(kdsMenu)?.[1];

  check(
    'both the server and the kitchen board declare a limit',
    server !== undefined && client !== undefined,
    `server=${server ?? 'missing'}, board=${client ?? 'missing'}`,
  );

  check(
    'and they are the same number',
    server === client,
    `server caps at ${server}, the board thinks ${client}. The board would ` +
      `offer a button the server refuses, or hide one it would have allowed.`,
  );
}

/* ------------------------------------------------------ the column exists */
{
  check(
    'must_try is on the menu_item table type',
    /must_try: Generated<boolean>/.test(schema),
    'the migration and the Kysely types have to agree or every query naming ' +
      'the column is a type error',
  );

  check(
    'the discovery menu actually selects and sends it',
    /'must_try'/.test(discovery) && /mustTry: i\.must_try/.test(discovery),
    'a column nobody selects is a badge that never appears',
  );
}

/*
 * ---------------------------------------------------------------------------
 * CONTROL
 * ---------------------------------------------------------------------------
 */
{
  checked++;
  const ok =
    inventory.length > 5000 &&
    discovery.length > 5000 &&
    custMenu.length > 5000 &&
    kdsMenu.length > 3000 &&
    inventory.includes('async setMustTry');
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  all five sources read and setMustTry present`,
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
