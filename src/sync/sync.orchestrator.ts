/**
 * Ties the pieces together into the two mode-specific cycles.
 *
 * `runEdgeCycleIfIdle` is what the edge worker's tick loop calls: probe for
 * connectivity, and if reachable, export local orders up and ask for
 * (then apply) whatever catalog changes cloud has. `startCloudResponder` is
 * what the cloud worker calls once at boot: stay subscribed to every
 * configured edge device's channel for the process lifetime, applying
 * orders batches as they arrive and answering each `sync-request` with a
 * fresh catalog export.
 *
 * Cloud never depends on Ably's short history/rewind window because it is
 * always attached — whatever an edge device sends the moment it connects is
 * delivered live, and a `sync-request`'s answer is computed fresh from
 * Postgres each time, not replayed from anything Ably buffered.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { Database } from '../platform/schema.js';
import { rootLogger } from '../platform/logger.js';
import type { SyncTransport } from './ably-transport.js';
import { SYNC_SCHEMA_VERSION, type SyncEnvelope } from './envelope.js';
import { BatchAssembler } from './batch-assembler.js';
import { WatermarkRepository } from './watermark.repository.js';
import { exportOrders } from './export-orders.js';
import { importOrdersBatch } from './import-orders.js';
import { exportCatalogSince } from './export-catalog.js';
import { importCatalogBatch } from './import-catalog.js';

export interface EdgeCycleOptions {
  /** How long to wait for Ably to connect before giving up on this cycle. */
  probeTimeoutMs?: number;
  /** How long to wait for cloud's catalog answer before detaching. */
  downWaitMs?: number;
}

export class SyncOrchestrator {
  private edgeCycleRunning = false;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly transport: SyncTransport,
  ) {}

  /** No-ops if a previous cycle is still in flight — a multi-minute sync must not overlap itself. */
  async runEdgeCycleIfIdle(deviceId: string, opts: EdgeCycleOptions = {}): Promise<void> {
    if (this.edgeCycleRunning) {
      rootLogger.debug(
        { event: 'sync_cycle_skipped_busy', deviceId },
        'a sync cycle is already in flight, skipping this probe',
      );
      return;
    }
    this.edgeCycleRunning = true;
    try {
      await this.runEdgeCycle(deviceId, opts);
    } finally {
      this.edgeCycleRunning = false;
    }
  }

  private async runEdgeCycle(deviceId: string, opts: EdgeCycleOptions): Promise<void> {
    const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
    const downWaitMs = opts.downWaitMs ?? 60_000;

    const reachable = await this.transport.probe(probeTimeoutMs);
    if (!reachable) {
      rootLogger.debug(
        { event: 'sync_probe_unreachable', deviceId },
        'no connectivity this tick; staying offline',
      );
      return;
    }

    rootLogger.info({ event: 'sync_cycle_started', deviceId }, 'connectivity window open; syncing');

    const { orderCount } = await exportOrders(this.db, this.transport, deviceId);

    const catalogWatermark = await new WatermarkRepository(this.db).get(deviceId, 'catalog', 'import');
    const assembler = new BatchAssembler();

    let catalogApplied = false;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const unsubscribe = await this.transport.subscribe(`sync:${deviceId}:down`, (data) => {
      const envelope = data as SyncEnvelope;
      if (envelope.kind !== 'catalog') return;
      const merged = assembler.feed(envelope);
      if (!merged) return;

      importCatalogBatch(this.db, deviceId, merged)
        .catch((e) => {
          rootLogger.error(
            { event: 'sync_import_catalog_failed', deviceId, err: (e as Error).message },
            'failed to apply a catalog batch',
          );
        })
        .finally(() => {
          catalogApplied = true;
          resolveDone?.();
        });
    });

    const request: SyncEnvelope = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      deviceId,
      kind: 'sync-request',
      chunkIndex: 0,
      chunkCount: 1,
      producedAt: new Date().toISOString(),
      tables: {},
      watermark: catalogWatermark.updatedAt ? catalogWatermark.updatedAt.toISOString() : null,
    };
    await this.transport.publish(`sync:${deviceId}:up`, request);

    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, downWaitMs))]);
    unsubscribe();

    rootLogger.info(
      { event: 'sync_cycle_completed', deviceId, ordersExported: orderCount, catalogApplied },
      'sync cycle finished',
    );
  }

  /** Cloud-only. Subscribes once, for the process lifetime — not a per-tick call. */
  async startCloudResponder(edgeDeviceIds: readonly string[]): Promise<void> {
    for (const deviceId of edgeDeviceIds) {
      const assembler = new BatchAssembler();

      await this.transport.subscribe(`sync:${deviceId}:up`, (data) => {
        const envelope = data as SyncEnvelope;

        if (envelope.kind === 'orders') {
          const merged = assembler.feed(envelope);
          if (!merged) return;
          importOrdersBatch(this.db, deviceId, merged).catch((e) => {
            rootLogger.error(
              { event: 'sync_import_orders_failed', deviceId, err: (e as Error).message },
              'failed to apply an orders batch',
            );
          });
          return;
        }

        if (envelope.kind === 'sync-request') {
          const since = envelope.watermark ? new Date(envelope.watermark) : null;
          exportCatalogSince(this.db, this.transport, deviceId, since).catch((e) => {
            rootLogger.error(
              { event: 'sync_export_catalog_failed', deviceId, err: (e as Error).message },
              'failed to export catalog to an edge device',
            );
          });
        }
      });

      rootLogger.info({ event: 'sync_cloud_listening', deviceId }, 'listening for this edge device');
    }
  }
}
