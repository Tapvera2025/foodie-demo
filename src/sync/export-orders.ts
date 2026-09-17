/**
 * Edge-only: reads orders created or changed locally since the last export
 * and publishes them to cloud on `sync:{deviceId}:up`.
 *
 * Walks `updated_at`, not `created_at` — migration 24 originally scoped status
 * changes out and walked `created_at` alone, but a status move (dispatched,
 * collected, ...) touches `updated_at` via the generic `touch_updated_at`
 * trigger without changing `created_at`, so that cursor could never see it.
 * `updated_at` covers both a brand-new order and a status change on cloud's
 * copy of one it already has, since import applies the row as an upsert.
 *
 * Still one-way and still no merge logic: `assert_order_snapshots_immutable`
 * (db/migrations/20260810000001_init.sql) keeps every financial/snapshot
 * column fixed after creation, so re-sending the row is only ever "has cloud
 * seen this current status yet," never a conflict to resolve.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { rootLogger } from '../platform/logger.js';
import type { SyncTransport } from './ably-transport.js';
import { chunkRows, SYNC_SCHEMA_VERSION, type SyncEnvelope } from './envelope.js';
import { WatermarkRepository } from './watermark.repository.js';

/** Bounds one export call's memory/publish footprint. Demo data volumes never get close. */
const MAX_ORDERS_PER_EXPORT = 1000;

export async function exportOrders(
  db: Kysely<Database>,
  transport: SyncTransport,
  deviceId: string,
): Promise<{ orderCount: number }> {
  const watermarks = new WatermarkRepository(db);
  const cursor = await watermarks.get(deviceId, 'orders', 'export');

  // node-postgres parses timestamptz into a JS Date, which only holds
  // millisecond precision — Postgres itself keeps microseconds. Comparing
  // the column raw against a watermark that round-tripped through a Date
  // compares a full-precision value against one truncated on the way out,
  // so a row can come back "equal" in JS but still be `>` in Postgres and
  // match forever. Truncating the column to milliseconds before comparing
  // makes both sides the same precision Node can actually represent.
  let query = db
    .selectFrom('order')
    .selectAll()
    .orderBy((eb) => eb.fn('date_trunc', [eb.val('milliseconds'), eb.ref('updated_at')]), 'asc')
    .orderBy('id', 'asc')
    .limit(MAX_ORDERS_PER_EXPORT);

  if (cursor.updatedAt) {
    const watermarkDate = cursor.updatedAt;
    query = query.where((eb) => {
      const truncatedUpdatedAt = eb.fn('date_trunc', [eb.val('milliseconds'), eb.ref('updated_at')]);
      return eb.or([
        eb(truncatedUpdatedAt, '>', watermarkDate),
        eb.and([eb(truncatedUpdatedAt, '=', watermarkDate), eb('id', '>', cursor.rowId ?? '')]),
      ]);
    });
  }

  const orders = await query.execute();

  if (orders.length === 0) {
    rootLogger.debug({ event: 'sync_export_orders_empty', deviceId }, 'no new orders to export');
    return { orderCount: 0 };
  }

  const orderIds = orders.map((o) => o.id);
  const [orderItems, payments, refunds] = await Promise.all([
    db.selectFrom('order_item').selectAll().where('order_id', 'in', orderIds).execute(),
    db.selectFrom('payment').selectAll().where('order_id', 'in', orderIds).execute(),
    db.selectFrom('refund').selectAll().where('order_id', 'in', orderIds).execute(),
  ]);

  // FK-safe order: parents before children. chunkRows drains one table's
  // rows fully before starting the next, so as long as chunks are applied in
  // ascending chunkIndex order (import-orders.ts does this), every order row
  // lands before any order_item/payment/refund row that references it, even
  // when they end up in different chunks.
  const tables = {
    order: orders as unknown[],
    order_item: orderItems as unknown[],
    payment: payments as unknown[],
    refund: refunds as unknown[],
  };

  const chunks = chunkRows(tables);
  const batchId = randomUUID();
  const producedAt = new Date().toISOString();

  for (let i = 0; i < chunks.length; i++) {
    const envelope: SyncEnvelope = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      batchId,
      deviceId,
      kind: 'orders',
      chunkIndex: i,
      chunkCount: chunks.length,
      producedAt,
      tables: chunks[i] as Record<string, unknown[]>,
      watermark: null,
    };
    await transport.publish(`sync:${deviceId}:up`, envelope);
  }

  const last = orders[orders.length - 1] as { updated_at: Date; id: string };
  await watermarks.set(
    db,
    deviceId,
    'orders',
    'export',
    { updatedAt: last.updated_at, rowId: last.id },
    orders.length,
  );

  rootLogger.info(
    { event: 'sync_export_orders', deviceId, orders: orders.length, chunks: chunks.length },
    'exported orders to cloud',
  );

  return { orderCount: orders.length };
}
