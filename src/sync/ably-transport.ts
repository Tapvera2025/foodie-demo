/**
 * Thin wrapper over the Ably SDK. Nothing here knows about orders, catalog,
 * or Postgres — it only knows how to connect, publish (waiting for Ably's own
 * ack, not just the local send), and subscribe. Keeping it this narrow is
 * what makes `sync.orchestrator.ts` testable without a real Ably account.
 */

import Ably from 'ably';

import { rootLogger } from '../platform/logger.js';

export interface SyncTransport {
  /**
   * Attempts a connection and resolves within `timeoutMs` — true if
   * connected, false otherwise. Never throws: an edge device that is
   * genuinely offline is the expected case, not a bug to report.
   */
  probe(timeoutMs: number): Promise<boolean>;
  /** Resolves only once Ably has acknowledged the message was received. */
  publish(channelName: string, message: unknown): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(channelName: string, onMessage: (data: unknown) => void): Promise<() => void>;
  close(): void;
}

export interface AblyTransportOptions {
  apiKey: string;
  /**
   * DEMO-ONLY: when true, `probe()` always resolves false without touching
   * the network — simulates "no connectivity" so the offline phase of a demo
   * doesn't depend on actually cutting the machine off from the internet.
   * See SYNC_FORCE_OFFLINE in src/platform/config.ts.
   */
  forceOffline?: boolean;
}

const EVENT_NAME = 'sync';

export function createAblyTransport(options: AblyTransportOptions): SyncTransport {
  let client: InstanceType<typeof Ably.Realtime> | null = null;

  const getClient = (): InstanceType<typeof Ably.Realtime> => {
    if (!client) {
      client = new Ably.Realtime({ key: options.apiKey });
      client.connection.on((change) => {
        rootLogger.debug(
          { event: 'sync_ably_connection_state', state: change.current },
          'ably connection state changed',
        );
      });
    }
    return client;
  };

  return {
    async probe(timeoutMs) {
      if (options.forceOffline) return false;

      const c = getClient();
      if (c.connection.state === 'connected') return true;

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (result: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        setTimeout(() => settle(false), timeoutMs);
        c.connection.once('connected', () => settle(true));
        c.connection.once('failed', () => settle(false));
        c.connection.once('suspended', () => settle(false));
      });
    },

    async publish(channelName, message) {
      const channel = getClient().channels.get(channelName);
      await channel.publish(EVENT_NAME, message);
    },

    async subscribe(channelName, onMessage) {
      const channel = getClient().channels.get(channelName);
      const handler = (msg: Ably.Message): void => onMessage(msg.data);
      await channel.subscribe(EVENT_NAME, handler);
      return () => {
        channel.unsubscribe(EVENT_NAME, handler);
      };
    },

    close() {
      client?.close();
      client = null;
    },
  };
}
