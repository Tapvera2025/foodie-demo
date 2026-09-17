/**
 * Cloud-only: applies a merged orders batch (order + order_item + payment +
 * refund rows) received from an edge device.
 *
 * `order_item`/`payment`/`refund` stay `ON CONFLICT (id) DO NOTHING` — those
 * are genuinely insert-only, so re-applying an already-seen batch (a retry
 * after a crash, say) is a safe no-op.
 *
 * `order` itself upserts the columns a status transition can touch (status,
 * the per-arrival timestamps, rejection reason/note, updated_at) — the edge
 * device re-exports the whole row on every status change (see
 * export-orders.ts), and cloud's copy needs to reflect that, not just the
 * row as it looked at creation. Financial/snapshot columns are left out of
 * the update set on purpose: `assert_order_snapshots_immutable` forbids
 * changing them after creation, and the edge side never changes them either,
 * so there is still nothing to merge there — only status to catch up on.
 *
 * One transaction for the whole batch, parents inserted before children, so
 * a batch either lands completely or not at all.
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

// app_session, customer, and court_table are all edge-local today — catalog
// sync never carries them to cloud — so an imported order's references to
// them always point at rows cloud doesn't have. All three columns are
// nullable, so this is a known, deliberate gap rather than a full fix:
// cloud's copy of a synced order loses "who ordered" and "which table" until
// customer/court_table get their own sync path. Revisit before this demo
// becomes a real multi-device deployment.
const DROPPED_EDGE_LOCAL_REFS = ['app_session_id', 'customer_id', 'court_table_id'];

function dropEdgeLocalRefs(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const col of DROPPED_EDGE_LOCAL_REFS) {
    if (out[col] != null) out[col] = null;
  }
  return out;
}

// Columns a status transition can touch (see transition.ts's STAMP/STOPS_HERE
// and the REJECTED case) — the only columns worth re-applying on an order
// cloud already has. Everything else is either identity (id, food_court_id,
// ...) or a financial/snapshot column assert_order_snapshots_immutable
// forbids changing after creation, so re-sending it would either be a no-op
// or a rejected update.
const ORDER_UPDATE_COLUMNS = [
  'status',
  'rejection_reason',
  'rejection_note',
  'payment_confirmed_at',
  'dispatched_at',
  'acknowledged_at',
  'preparing_at',
  'ready_at',
  'collected_at',
  'terminal_at',
  'updated_at',
] as const;

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

      const prepared = rows.map((r) => jsonbSafe(table, table === 'order' ? dropEdgeLocalRefs(r) : r));

      const result = await trx
        .insertInto(table)
        // Rows arrive as plain JSON — dates come back as ISO strings, which
        // pg/Kysely accept for a timestamptz column same as a Date would.
        .values(prepared as never[])
        .onConflict((oc) =>
          table === 'order'
            ? oc
                .column('id')
                .doUpdateSet((eb) =>
                  Object.fromEntries(
                    ORDER_UPDATE_COLUMNS.map((c) => [c, eb.ref(`excluded.${c}` as never)]),
                  ),
                )
                // Last-write-wins guard, same as import-catalog.ts: a batch
                // replayed after a crash or delivered out of order must not
                // clobber a status cloud already applied from a later one.
                .whereRef('excluded.updated_at' as never, '>', 'order.updated_at' as never)
            : oc.column('id').doNothing(),
        )
        .execute();

      // One InsertResult per STATEMENT (always 1 here), not per row.
      inserted[table] = Number(result[0]?.numInsertedOrUpdatedRows ?? 0n);
    }

    const orderRows = tables['order'] as Array<{ updated_at: string; id: string }> | undefined;
    if (orderRows && orderRows.length > 0) {
      const last = orderRows[orderRows.length - 1] as { updated_at: string; id: string };
      await new WatermarkRepository(db).set(
        trx,
        deviceId,
        'orders',
        'import',
        { updatedAt: new Date(last.updated_at), rowId: last.id },
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
