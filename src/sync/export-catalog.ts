/**
 * Cloud-only, called on-demand when an edge device asks (a `sync-request`
 * control message carrying its current catalog watermark): exports
 * food_court/vendor/court_table/menu/menu_category/menu_item rows changed
 * since then.
 *
 * `since === null` exports everything — used once, by `scripts/sync-bootstrap.ts`,
 * to seed an edge device's catalog before it can take its first order (order_item
 * etc. reference these rows by UUID, so the edge DB needs the same rows, same ids,
 * before it can create an order at all).
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { rootLogger } from '../platform/logger.js';
import type { SyncTransport } from './ably-transport.js';
import { chunkRows, SYNC_SCHEMA_VERSION, type SyncEnvelope } from './envelope.js';

/** FK-safe order: food_court/vendor/menu before the rows that reference them. */
const CATALOG_TABLE_ORDER = [
  'food_court',
  'vendor',
  'court_table',
  'menu',
  'menu_category',
  'menu_item',
] as const;

/**
 * `menu_category` has no `updated_at` column (it was never added to the
 * generic `touch_updated_at` trigger list — see init.sql) and it changes
 * rarely, so it is always exported in full rather than filtered by `since`.
 */
const NO_UPDATED_AT = new Set(['menu_category']);

export async function exportCatalogSince(
  db: Kysely<Database>,
  transport: SyncTransport,
  deviceId: string,
  since: Date | null,
): Promise<{ rowCount: number }> {
  const tables: Record<string, unknown[]> = {};
  let rowCount = 0;

  for (const table of CATALOG_TABLE_ORDER) {
    let query = db.selectFrom(table).selectAll();
    if (since && !NO_UPDATED_AT.has(table)) {
      query = query.where('updated_at' as never, '>', since as never);
    }
    const rows = await query.execute();
    tables[table] = rows as unknown[];
    rowCount += rows.length;
  }

  const chunks = chunkRows(tables);
  const batchId = randomUUID();
  const producedAt = new Date().toISOString();

  for (let i = 0; i < chunks.length; i++) {
    const envelope: SyncEnvelope = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      batchId,
      deviceId,
      kind: 'catalog',
      chunkIndex: i,
      chunkCount: chunks.length,
      producedAt,
      tables: chunks[i] as Record<string, unknown[]>,
      watermark: null,
    };
    await transport.publish(`sync:${deviceId}:down`, envelope);
  }

  rootLogger.info(
    { event: 'sync_export_catalog', deviceId, rows: rowCount, chunks: chunks.length, since },
    'exported catalog to an edge device',
  );

  return { rowCount };
}
