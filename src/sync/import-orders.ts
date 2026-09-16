/**
 * Cloud-only: applies a merged orders batch (order + order_item + payment +
 * refund rows) received from an edge device.
 *
 * Insert-only, `ON CONFLICT (id) DO NOTHING` — no merge/LWW logic, because an
 * order is immutable after creation (`assert_order_snapshots_immutable`) so
 * there is nothing to merge. Re-applying an already-seen batch (a retry after
 * a crash, say) is a safe no-op. One transaction for the whole batch, parents
 * inserted before children, so a batch either lands completely or not at all.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { rootLogger } from '../platform/logger.js';
import { WatermarkRepository } from './watermark.repository.js';

const TABLE_ORDER = ['order', 'order_item', 'payment', 'refund'] as const;

// A jsonb column's value arrives from the Ably envelope as an already-parsed
// object (the whole envelope round-tripped through JSON), but pg needs the
// literal JSON text for a jsonb bind param — handing it a plain JS object
// fails with "invalid input syntax for type json". Listed explicitly per
// table, not "any object", because a future array column (Postgres text[])
// would need the opposite treatment: a JS array, not a JSON string.
const JSONB_COLUMNS: Partial<Record<(typeof TABLE_ORDER)[number], string[]>> = {
  order: ['fee_rule_snapshot', 'tax_model_snapshot'],
  payment: ['split_instruction', 'checkout_payload'],
  order_item: ['options_snapshot'],
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

// app_session is edge-local session/auth state and never syncs — an order's
// app_session_id always points at a row that only exists on the device that
// created it. The column is nullable with ON DELETE SET NULL for the same
// reason locally, so clearing it on import is the intended shape, not a
// workaround.
function dropForeignSession(row: Record<string, unknown>): Record<string, unknown> {
  if (row.app_session_id == null) return row;
  return { ...row, app_session_id: null };
}

export async function importOrdersBatch(
  db: Kysely<Database>,
  deviceId: string,
  tables: Record<string, unknown[]>,
): Promise<{ inserted: Record<string, number> }> {
  const inserted: Record<string, number> = {};

  await db.transaction().execute(async (trx) => {
    for (const table of TABLE_ORDER) {
      const rows = tables[table] as Array<Record<string, unknown>> | undefined;
      if (!rows || rows.length === 0) continue;

      const prepared = rows.map((r) => jsonbSafe(table, table === 'order' ? dropForeignSession(r) : r));

      const result = await trx
        .insertInto(table)
        // Rows arrive as plain JSON — dates come back as ISO strings, which
        // pg/Kysely accept for a timestamptz column same as a Date would.
        .values(prepared as never[])
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      // One InsertResult per STATEMENT (always 1 here), not per row.
      inserted[table] = Number(result[0]?.numInsertedOrUpdatedRows ?? 0n);
    }

    const orderRows = tables['order'] as Array<{ created_at: string; id: string }> | undefined;
    if (orderRows && orderRows.length > 0) {
      const last = orderRows[orderRows.length - 1] as { created_at: string; id: string };
      await new WatermarkRepository(db).set(
        trx,
        deviceId,
        'orders',
        'import',
        { updatedAt: new Date(last.created_at), rowId: last.id },
        orderRows.length,
      );
    }
  });

  rootLogger.info(
    { event: 'sync_import_orders', deviceId, ...inserted },
    'applied an orders batch from an edge device',
  );

  return { inserted };
}
