/**
 * ============================================================================
 * THE CATEGORY CHIPS SELECT THE STALLS THEY CLAIM TO
 * ============================================================================
 *
 * Written against a real bug, not a hypothetical one: tapping "Bread" showed
 * "nothing to show" in a court where a stall had a whole menu section called
 * Bread. Nothing threw, no query was wrong, and the screen was empty.
 *
 * The cause was a mismatch between where chips came from and what they were
 * matched against. Chips are built from BOTH a stall's cuisine tags and its
 * menu section names; the filter only ever compared the label to `cuisine`. So
 * every chip of the second kind — which is most of the interesting ones —
 * quietly selected nobody.
 *
 * The first case below is that exact scenario. It fails against the old code
 * and passes against the new, which is the only property a regression test
 * needs to have.
 *
 * Run with `node tests/conformance/category-chips.mjs`. Type stripping, so it
 * imports the real module rather than a copy of its logic — a test against a
 * transcribed copy proves the copy works.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('data:text/javascript,export async function resolve(s,c,n){return n(s.replace(/\\.js$/,".ts"),c)}', pathToFileURL('./'));

const { buildCategoryChips, MAX_CHIPS } = await import('../../src/tenancy/categories.ts');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const photos = [];
const chipFor = (chips, label) => chips.find((c) => c.label === label);

console.log('\ncategory chips — what a chip selects');
console.log('─'.repeat(78));

/*
 * ---------------------------------------------------------------------------
 * THE REPORTED BUG
 * ---------------------------------------------------------------------------
 * A tandoori stall tags itself "North Indian" and calls a menu section
 * "Bread". The chip that appears says Bread. It has to select that stall.
 */
{
  const chips = buildCategoryChips({
    vendors: [
      { id: 'v-tandoor', cuisine: ['North Indian', 'Mughlai'] },
      { id: 'v-chinese', cuisine: ['Chinese'] },
    ],
    menuCategories: [
      { name: 'Bread', vendorId: 'v-tandoor' },
      { name: 'Main Course', vendorId: 'v-tandoor' },
      { name: 'Noodles', vendorId: 'v-chinese' },
    ],
    photos,
  });

  const bread = chipFor(chips, 'Bread');
  check(
    'a chip from a MENU SECTION selects that stall — the reported bug',
    bread !== undefined && bread.vendorIds.join() === 'v-tandoor',
    `got ${bread ? JSON.stringify(bread.vendorIds) : 'no Bread chip at all'} — ` +
      `the old code returned [] here, because "bread" is not in ["North Indian","Mughlai"]`,
  );

  check(
    'a chip from a CUISINE TAG still selects that stall',
    chipFor(chips, 'Chinese')?.vendorIds.join() === 'v-chinese',
  );

  check(
    'a chip does not select a stall that has nothing to do with it',
    chipFor(chips, 'Bread')?.vendorIds.includes('v-chinese') === false,
  );
}

/*
 * ---------------------------------------------------------------------------
 * ONE CHIP PER LABEL, ACROSS BOTH SOURCES AND EITHER SPELLING
 * ---------------------------------------------------------------------------
 * Two stalls spelling it differently is one chip that selects both. If this
 * broke, the row would show "Momos" and "momos" side by side, each selecting
 * half the stalls that sell them.
 */
{
  const chips = buildCategoryChips({
    vendors: [{ id: 'v-a', cuisine: ['Momos'] }],
    menuCategories: [{ name: 'momos', vendorId: 'v-b' }],
    photos,
  });

  check(
    'two spellings merge into one chip selecting both stalls',
    chips.length === 1 && chips[0].vendorIds.join() === 'v-a,v-b',
    `got ${chips.length} chip(s): ${JSON.stringify(chips.map((c) => [c.label, c.vendorIds]))}`,
  );

  check('the merged chip keeps the first spelling seen', chips[0]?.label === 'Momos');
}

/*
 * ---------------------------------------------------------------------------
 * RANKING COUNTS STALLS, NOT ROWS
 * ---------------------------------------------------------------------------
 * The old counter incremented once per menu section, so one stall that had
 * split "Rolls" into three sections outranked a label three other stalls
 * actually sold. This is the fix arriving as a side effect of using a set, and
 * it is worth pinning: it is the kind of thing a future refactor back to a
 * counter would silently undo.
 */
{
  const chips = buildCategoryChips({
    vendors: [
      { id: 'v-1', cuisine: [] },
      { id: 'v-2', cuisine: [] },
      { id: 'v-3', cuisine: [] },
    ],
    menuCategories: [
      { name: 'Rolls', vendorId: 'v-1' },
      { name: 'Rolls', vendorId: 'v-1' },
      { name: 'Rolls', vendorId: 'v-1' },
      { name: 'Thali', vendorId: 'v-1' },
      { name: 'Thali', vendorId: 'v-2' },
      { name: 'Thali', vendorId: 'v-3' },
    ],
    photos,
  });

  check(
    'the label three stalls sell outranks the one stall subdivided three ways',
    chips[0]?.label === 'Thali',
    `got "${chips[0]?.label}" first — a per-row counter puts Rolls (3 rows, 1 stall) ` +
      `level with Thali (3 rows, 3 stalls)`,
  );

  check(
    'the subdivided label still selects its one stall exactly once',
    chipFor(chips, 'Rolls')?.vendorIds.join() === 'v-1',
  );
}

/*
 * ---------------------------------------------------------------------------
 * THE ROW HAS A CEILING, AND EVERY CHIP IN IT IS LIVE
 * ---------------------------------------------------------------------------
 * The invariant that matters is not the cap itself — it is that nothing
 * survives the slice with an empty selection. A visible chip that filters to
 * nothing is the failure this whole file is about.
 */
{
  const chips = buildCategoryChips({
    vendors: Array.from({ length: 20 }, (_, i) => ({ id: `v-${i}`, cuisine: [`Cuisine ${i}`] })),
    menuCategories: [],
    photos,
  });

  check(`the row is capped at ${MAX_CHIPS}`, chips.length === MAX_CHIPS, `got ${chips.length}`);
  check(
    'no surviving chip selects an empty set of stalls',
    chips.every((c) => c.vendorIds.length > 0),
    JSON.stringify(chips.filter((c) => c.vendorIds.length === 0).map((c) => c.label)),
  );
}

/*
 * ---------------------------------------------------------------------------
 * LABELS THAT ARE NOT WORDS DO NOT BECOME CHIPS
 * ---------------------------------------------------------------------------
 */
{
  const chips = buildCategoryChips({
    vendors: [{ id: 'v-1', cuisine: ['A', '  ', 'X'.repeat(40), '  Rolls  '] }],
    menuCategories: [],
    photos,
  });

  check(
    'single letters, blanks and essays are rejected; a padded label is trimmed',
    chips.length === 1 && chips[0].label === 'Rolls',
    JSON.stringify(chips.map((c) => c.label)),
  );
}

/*
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * `vendorIds` is sorted so the same court always produces the same bytes. Not
 * cosmetic: without it a cached response and a fresh one can differ, and every
 * assertion above would be order-dependent.
 */
{
  const chips = buildCategoryChips({
    vendors: [],
    menuCategories: [
      { name: 'Bread', vendorId: 'v-z' },
      { name: 'Bread', vendorId: 'v-a' },
      { name: 'Bread', vendorId: 'v-m' },
    ],
    photos,
  });

  check(
    'vendorIds comes back sorted regardless of row order',
    chips[0]?.vendorIds.join() === 'v-a,v-m,v-z',
    JSON.stringify(chips[0]?.vendorIds),
  );
}

/*
 * ---------------------------------------------------------------------------
 * THE PHOTOGRAPH STILL RESOLVES, AND FALLS BACK RATHER THAN BREAKING
 * ---------------------------------------------------------------------------
 */
{
  const chips = buildCategoryChips({
    vendors: [{ id: 'v-1', cuisine: ['Chinese'] }],
    menuCategories: [
      { name: 'Bread', vendorId: 'v-1' },
      { name: 'Desserts', vendorId: 'v-1' },
    ],
    photos: [
      { itemName: 'Garlic Naan', imageUrl: 'naan.jpg', categoryName: 'Bread', cuisine: ['x'] },
      { itemName: 'Hakka Noodles', imageUrl: 'hakka.jpg', categoryName: 'Noodles', cuisine: ['Chinese'] },
    ],
  });

  check('a chip takes its photo from a dish in that section', chipFor(chips, 'Bread')?.imageUrl === 'naan.jpg');
  check('a cuisine chip falls back to a dish from that cuisine', chipFor(chips, 'Chinese')?.imageUrl === 'hakka.jpg');
  check(
    'a chip with no photograph anywhere is null, not undefined or broken',
    chipFor(chips, 'Desserts')?.imageUrl === null,
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
