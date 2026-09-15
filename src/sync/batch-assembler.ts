/**
 * Buffers chunked `SyncEnvelope` messages by `batchId` and hands back one
 * merged `tables` record once every chunk has arrived.
 *
 * A demo-scoped simplification, flagged as such in the implementation plan:
 * there is no timeout or retry if a batch is interrupted mid-transfer (the
 * edge device's window closes before the last chunk lands, say) — the
 * partial buffer for that batchId just sits unused. Fine at the data volumes
 * this demo pushes through; a real gap at scale.
 */

import type { SyncEnvelope } from './envelope.js';

interface PendingBatch {
  chunkCount: number;
  received: Map<number, Record<string, unknown[]>>;
}

export class BatchAssembler {
  private readonly pending = new Map<string, PendingBatch>();

  /** Returns the merged tables once `envelope` completes its batch, else null. */
  feed(envelope: SyncEnvelope): Record<string, unknown[]> | null {
    let batch = this.pending.get(envelope.batchId);
    if (!batch) {
      batch = { chunkCount: envelope.chunkCount, received: new Map() };
      this.pending.set(envelope.batchId, batch);
    }
    batch.received.set(envelope.chunkIndex, envelope.tables);

    if (batch.received.size < batch.chunkCount) return null;

    this.pending.delete(envelope.batchId);

    const merged: Record<string, unknown[]> = {};
    for (let i = 0; i < batch.chunkCount; i++) {
      const chunk = batch.received.get(i) ?? {};
      for (const [table, rows] of Object.entries(chunk)) {
        (merged[table] ??= []).push(...rows);
      }
    }
    return merged;
  }
}
