/**
 * The wire format sent over Ably, and the pure chunking logic that packs rows
 * into it under Ably's per-message size limit.
 *
 * Deliberately dependency-free — no Ably SDK, no Kysely, no DB — so
 * `chunkRows` is trivially unit-testable and the wire shape can be reasoned
 * about without a running database.
 */

export const SYNC_SCHEMA_VERSION = 1;

export type SyncKind = 'orders' | 'catalog' | 'sync-request';

export interface SyncEnvelope {
  schemaVersion: typeof SYNC_SCHEMA_VERSION;
  /** One id per export call. All chunks of one batch share it. */
  batchId: string;
  /** The device that produced this message — the edge device's own id in both directions. */
  deviceId: string;
  kind: SyncKind;
  chunkIndex: number;
  chunkCount: number;
  /** Informational only, this device's own clock at export time. Never merged into any row. */
  producedAt: string;
  /** One array of rows per table name. Absent/empty for a `sync-request`. */
  tables: Record<string, unknown[]>;
  /** Present only when kind === 'sync-request': the edge device's current catalog watermark. */
  watermark: string | null;
}

/**
 * Comfortably under Ably's default ~64KB message-size ceiling on standard
 * plans, leaving headroom for the envelope wrapper (batchId/deviceId/etc.)
 * and Ably's own protocol overhead.
 */
export const MAX_CHUNK_BYTES = 32 * 1024;

/**
 * Packs `tables` (one array of rows per table name) into one or more chunks,
 * each under `maxBytes` once serialized. Greedy and never splits a single
 * row across two chunks — a row too large to fit alone still gets its own
 * chunk rather than being dropped or corrupted.
 *
 * Always returns at least one chunk, even for an empty `tables` — an "up to
 * date, nothing to send" export or a `sync-request` control message is still
 * one complete, valid batch of `chunkCount === 1`.
 */
export function chunkRows(
  tables: Record<string, unknown[]>,
  maxBytes: number = MAX_CHUNK_BYTES,
): Array<Record<string, unknown[]>> {
  const chunks: Array<Record<string, unknown[]>> = [];
  let current: Record<string, unknown[]> = {};
  let currentBytes = 2; // '{}'
  let currentHasRows = false;

  const flush = (): void => {
    chunks.push(current);
    current = {};
    currentBytes = 2;
    currentHasRows = false;
  };

  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + table.length + 4;
      if (currentHasRows && currentBytes + rowBytes > maxBytes) flush();
      (current[table] ??= []).push(row);
      currentBytes += rowBytes;
      currentHasRows = true;
    }
  }
  flush();

  return chunks;
}
