/**
 * Reads and writes `sync_watermark` — see migration 24 for why this table
 * exists rather than a local file or an outbox: it lets the import side
 * advance its cursor inside the same transaction as the rows it just applied.
 */

import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../platform/schema.js';

export interface Watermark {
  updatedAt: Date | null;
  rowId: string | null;
}

export type SyncDomain = 'orders' | 'catalog';
export type SyncDirection = 'export' | 'import';

export class WatermarkRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(deviceId: string, domain: SyncDomain, direction: SyncDirection): Promise<Watermark> {
    const row = await this.db
      .selectFrom('sync_watermark')
      .select(['watermark_updated_at', 'watermark_row_id'])
      .where('device_id', '=', deviceId)
      .where('domain', '=', domain)
      .where('direction', '=', direction)
      .executeTakeFirst();

    return { updatedAt: row?.watermark_updated_at ?? null, rowId: row?.watermark_row_id ?? null };
  }

  /**
   * `executor` is usually the transaction that just applied the rows this
   * watermark now points past — pass it explicitly rather than always using
   * `this.db`, so an import's watermark update commits or rolls back with the
   * data it describes.
   */
  async set(
    executor: Kysely<Database> | Transaction<Database>,
    deviceId: string,
    domain: SyncDomain,
    direction: SyncDirection,
    watermark: Watermark,
    rowCount: number,
  ): Promise<void> {
    await executor
      .insertInto('sync_watermark')
      .values({
        device_id: deviceId,
        domain,
        direction,
        watermark_updated_at: watermark.updatedAt,
        watermark_row_id: watermark.rowId,
        last_synced_at: new Date(),
        last_batch_row_count: rowCount,
      })
      .onConflict((oc) =>
        oc.columns(['device_id', 'domain', 'direction']).doUpdateSet({
          watermark_updated_at: watermark.updatedAt,
          watermark_row_id: watermark.rowId,
          last_synced_at: new Date(),
          last_batch_row_count: rowCount,
        }),
      )
      .execute();
  }

  async status(deviceId: string): Promise<
    Array<{
      domain: SyncDomain;
      direction: SyncDirection;
      lastSyncedAt: Date;
      lastBatchRowCount: number;
    }>
  > {
    const rows = await this.db
      .selectFrom('sync_watermark')
      .select(['domain', 'direction', 'last_synced_at', 'last_batch_row_count'])
      .where('device_id', '=', deviceId)
      .orderBy('domain')
      .orderBy('direction')
      .execute();

    return rows.map((r) => ({
      domain: r.domain,
      direction: r.direction,
      lastSyncedAt: r.last_synced_at,
      lastBatchRowCount: r.last_batch_row_count,
    }));
  }
}
