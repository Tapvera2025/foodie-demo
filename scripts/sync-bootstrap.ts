/**
 * One-time (repeatable) catalog seed for an edge device, BEFORE it ever
 * syncs through Ably.
 *
 * `order_item`/`payment`/etc. reference catalog rows (menu_item, vendor,
 * court_table, food_court) by UUID, so an edge device's database needs the
 * SAME rows, with the SAME ids, as cloud's before it can take its first
 * order at all — that is what this copies. It runs DB-to-DB directly rather
 * than through Ably deliberately: it is a one-off bulk copy, potentially the
 * entire catalog, and there is no reason to route it through chunked pub/sub
 * when a direct connection is simpler and does not require Ably to be
 * configured yet.
 *
 *   npm run sync:bootstrap -- --from postgres://... --to postgres://...
 */

import { createDb, createPool } from '../src/platform/db.js';

/** Parent tables before the rows that reference them. */
const CATALOG_TABLE_ORDER = [
  'food_court',
  'vendor',
  'court_table',
  'menu',
  'menu_category',
  'menu_item',
] as const;

function arg(name: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) {
    console.error(`Missing ${flag} <DATABASE_URL>`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const fromUrl = arg('from');
  const toUrl = arg('to');

  const fromPool = createPool({ connectionString: fromUrl, max: 2, connectionTimeoutMillis: 5000 });
  const toPool = createPool({ connectionString: toUrl, max: 2, connectionTimeoutMillis: 5000 });
  const from = createDb(fromPool);
  const to = createDb(toPool);

  try {
    console.log(`\ncopying catalog: ${redact(fromUrl)} -> ${redact(toUrl)}\n`);

    for (const table of CATALOG_TABLE_ORDER) {
      const rows = await from.selectFrom(table).selectAll().execute();
      if (rows.length === 0) {
        console.log(`  ${table.padEnd(12)} 0 rows`);
        continue;
      }

      const result = await to
        .insertInto(table)
        .values(rows as never[])
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      // `result` has one InsertResult PER STATEMENT (always 1 here, one
      // multi-row INSERT), not one per row — the row count is
      // numInsertedOrUpdatedRows on that single result.
      const inserted = Number(result[0]?.numInsertedOrUpdatedRows ?? 0n);
      console.log(`  ${table.padEnd(12)} ${rows.length} read, ${inserted} inserted`);
    }

    console.log('\ndone\n');
  } finally {
    await fromPool.end();
    await toPool.end();
  }
}

function redact(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

void main();
