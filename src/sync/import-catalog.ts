/**
 * Edge-only: applies a merged catalog batch (food_court/vendor/court_table/
 * menu/menu_category/menu_item rows) received from cloud.
 *
 * One-way (cloud -> edge only, edge never edits catalog and never exports it
 * back), so `ON CONFLICT (id) DO UPDATE ... WHERE excluded.updated_at >
 * target.updated_at` is enough — no echo/origin-tracking needed, because
 * cloud is the only writer this table will ever see. The edge's own
 * `touch_updated_at` trigger re-stamps `updated_at` to local time on apply;
 * that's expected and harmless here precisely because nothing downstream of
 * the edge ever reads that column to decide anything.
 *
 * `menu_category` has no `updated_at` column (see export-catalog.ts), so it
 * upserts unconditionally rather than under the LWW guard — safe for the
 * same reason: cloud is its only writer.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { rootLogger } from '../platform/logger.js';
import { WatermarkRepository } from './watermark.repository.js';

const TABLE_ORDER = [
  'food_court',
  'vendor',
  'court_table',
  'menu',
  'menu_category',
  'menu_item',
] as const;

const NO_UPDATED_AT = new Set(['menu_category']);

// A jsonb value arrives from the sync envelope as an already-parsed
// object/array, but pg needs JSON text for a jsonb bind param, not a plain JS
// object. Listed explicitly per table rather than "any object" — some columns
// (vendor.cuisine, menu_item.dietary_flags) are real Postgres text[] arrays,
// which the driver needs as a JS array, not a JSON string.
const JSONB_COLUMNS: Partial<Record<(typeof TABLE_ORDER)[number], string[]>> = {
  vendor: ['operating_hours'],
  food_court: ['operating_hours', 'config'],
  menu_item: ['variant_groups', 'addon_groups'],
};

function jsonbSafe(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const columns = JSONB_COLUMNS[table as (typeof TABLE_ORDER)[number]];
  if (!columns) return row;
  const out = { ...row };
  for (const col of columns) {
    if (out[col] !== null && out[col] !== undefined) out[col] = JSON.stringify(out[col]);
  }
  return out;
}

export async function importCatalogBatch(
  db: Kysely<Database>,
  deviceId: string,
  tables: Record<string, unknown[]>,
): Promise<{ applied: Record<string, number> }> {
  const applied: Record<string, number> = {};
  let maxUpdatedAt: Date | null = null;

  await db.transaction().execute(async (trx) => {
    for (const table of TABLE_ORDER) {
      const rows = tables[table] as Array<Record<string, unknown>> | undefined;
      if (!rows || rows.length === 0) continue;

      const columns = Object.keys(rows[0] as Record<string, unknown>).filter((c) => c !== 'id');
      const hasUpdatedAt = !NO_UPDATED_AT.has(table);

      const result = await trx
        .insertInto(table)
        .values(rows.map((r) => jsonbSafe(table, r)) as never[])
        .onConflict((oc) => {
          const withSet = oc
            .column('id')
            .doUpdateSet((eb) =>
              Object.fromEntries(columns.map((c) => [c, eb.ref(`excluded.${c}` as never)])),
            );
          return hasUpdatedAt
            ? withSet.whereRef('excluded.updated_at' as never, '>', `${table}.updated_at` as never)
            : withSet;
        })
        .execute();

      // One InsertResult per STATEMENT (always 1 here), not per row — and
      // it correctly excludes rows the WHERE guard skipped as stale.
      applied[table] = Number(result[0]?.numInsertedOrUpdatedRows ?? 0n);
      if (!hasUpdatedAt) continue;

      for (const row of rows) {
        const updatedAt = (row as { updated_at?: string }).updated_at;
        if (updatedAt) {
          const d = new Date(updatedAt);
          if (!maxUpdatedAt || d > maxUpdatedAt) maxUpdatedAt = d;
        }
      }
    }

    if (maxUpdatedAt) {
      await new WatermarkRepository(db).set(
        trx,
        deviceId,
        'catalog',
        'import',
        { updatedAt: maxUpdatedAt, rowId: null },
        Object.values(applied).reduce((a, b) => a + b, 0),
      );
    }
  });

  rootLogger.info(
    { event: 'sync_import_catalog', deviceId, ...applied },
    'applied a catalog batch from cloud',
  );

  return { applied };
}
