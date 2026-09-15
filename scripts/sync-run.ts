/**
 * CLI equivalent of the admin console's "Sync Now" button — runs one sync
 * cycle immediately instead of waiting for the worker's next probe tick.
 * Useful for controlling timing live during a demo.
 *
 *   npm run sync:run
 *
 * Reads SYNC_MODE the same way the worker does. On SYNC_MODE=edge it runs
 * one export-orders + sync-request/catalog-import cycle. On SYNC_MODE=cloud
 * it starts the standing responder and stays running — Ctrl+C to stop, same
 * as the worker.
 */

import { ConfigError, loadConfig } from '../src/platform/config.js';
import { createDb, createPool } from '../src/platform/db.js';
import { createAblyTransport } from '../src/sync/ably-transport.js';
import { SyncOrchestrator } from '../src/sync/sync.orchestrator.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(78);
    }
    throw e;
  }

  if (cfg.SYNC_MODE === 'off') {
    console.error('SYNC_MODE is "off" — nothing to run. Set SYNC_MODE=edge or SYNC_MODE=cloud.');
    process.exit(2);
  }

  const pool = createPool({ connectionString: cfg.DATABASE_URL, max: 2 });
  const db = createDb(pool);
  const transport = createAblyTransport({
    apiKey: cfg.ABLY_API_KEY as string,
    forceOffline: cfg.SYNC_FORCE_OFFLINE ?? false,
  });
  const orchestrator = new SyncOrchestrator(db, transport);

  try {
    if (cfg.SYNC_MODE === 'edge') {
      console.log(`running one edge sync cycle as device "${cfg.SYNC_DEVICE_ID}"...`);
      await orchestrator.runEdgeCycleIfIdle(cfg.SYNC_DEVICE_ID as string);
      console.log('cycle finished');
    } else {
      const edgeDeviceIds = (cfg.SYNC_EDGE_DEVICE_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      console.log(`listening for edge devices: ${edgeDeviceIds.join(', ')} (Ctrl+C to stop)`);
      await orchestrator.startCloudResponder(edgeDeviceIds);
      await new Promise(() => undefined); // stays open; the worker process normally owns this
    }
  } finally {
    transport.close();
    await pool.end();
  }
}

void main();
