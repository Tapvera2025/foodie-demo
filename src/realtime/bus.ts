/**
 * ============================================================================
 * HOW AN EVENT GETS FROM THE PROCESS THAT CAUSED IT TO THE SOCKET THAT WANTS IT
 * ============================================================================
 *
 * THE PROBLEM, WHICH IS NOT OPTIONAL
 *
 * The worker is a SEPARATE PROCESS from the API. It owns dispatch, the
 * escalation ladder, refunds, capture and payment reconciliation — which is
 * most of the interesting things that happen to an order after checkout. None
 * of those changes happen inside the API process, so an in-process event
 * emitter would deliver nothing for exactly the transitions a customer is
 * sitting on a screen waiting for.
 *
 * The same is true in the other direction once there are two API replicas:
 * a stall accepts an order on replica A while the customer's socket is held by
 * replica B.
 *
 * So the bus has to be OUT of process. That is the whole reason this file
 * exists, and it is the part that a naive `EventEmitter` implementation gets
 * wrong silently — it works perfectly on one developer's machine, where
 * everything is one process.
 *
 * ----------------------------------------------------------------------------
 * WHY POSTGRES LISTEN/NOTIFY AND NOT THE REDIS ADAPTER
 * ----------------------------------------------------------------------------
 *
 * `docs/tech/backend.md` specifies `@socket.io/redis-adapter`, and this is a
 * deliberate, documented departure from that row rather than an oversight.
 * Three reasons, in order of weight:
 *
 * 1. NOTIFY IS TRANSACTIONAL. It fires on COMMIT and not before, and a
 *    rolled-back transaction emits nothing at all. Every other bus makes it
 *    easy to publish "the order is READY" from inside a transaction that then
 *    aborts, and the client refetches to find an order that is not ready. This
 *    codebase has spent a great deal of effort on exactly that class of bug —
 *    a client believing something the database never committed — and this is
 *    the one transport where the mistake is unavailable.
 *
 * 2. NO ADAPTER IS NEEDED FOR FANOUT. Every API instance LISTENs, so every
 *    instance receives every notification and broadcasts to its own local room
 *    members. That is what the Redis adapter exists to arrange, achieved by
 *    the subscription topology instead. At the documented volume — §16.1 sizes
 *    a court at roughly 8 orders a minute — the cost of every instance seeing
 *    every event is not measurable.
 *
 * 3. IT ADDS NO DEPENDENCY AND NO NEW THING THAT CAN BE DOWN. `pg` is already
 *    here and Postgres must be up for any of this to mean anything. The Redis
 *    path needs `ioredis`, `@socket.io/redis-adapter` and
 *    `@socket.io/redis-emitter`, and makes realtime fail whenever Redis does.
 *
 * WHAT IS GIVEN UP, STATED PLAINLY: notifications are not durable. An API
 * instance that is down misses events sent while it was down, and there is no
 * replay. That is survivable here only because of the contract in
 * `rooms.ts` — an event says "refetch", never "here is the new state" — so a
 * missed event costs latency, not correctness, and the reconnect refetch
 * heals it. If events ever start carrying state, this trade-off is void and
 * the transport has to be revisited.
 *
 * The 8000-byte payload limit is not a constraint: payloads are two ids.
 */

import { sql, type Kysely } from 'kysely';
import type pg from 'pg';

import { rootLogger } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';

/** One channel. Filtering happens on the room, not on the channel name. */
export const CHANNEL = 'foodcourt_realtime';

export interface BusMessage {
  /** The socket event name, from `rooms.ts`. */
  readonly event: string;
  /** The rooms to broadcast into. Computed by the publisher, never by a client. */
  readonly rooms: readonly string[];
  readonly payload: unknown;
}

/**
 * Publish, on whatever Kysely executor the caller already has.
 *
 * `Transaction<DB>` extends `Kysely<DB>`, so this one signature accepts both —
 * and passing the TRANSACTION is the whole point. The notification then
 * inherits that transaction's fate: committed with the status change, or
 * discarded with it. A caller that reaches for the top-level `db` instead gets
 * a notification that fires whether or not the change it describes survived,
 * which is the failure this transport was chosen to prevent.
 *
 * `pg_notify(...)` as a SELECT rather than the `NOTIFY` statement, because
 * NOTIFY takes a literal channel and cannot be parameterised — building it by
 * string concatenation is how a channel name becomes an injection point. The
 * function form takes both arguments as bound parameters.
 */
export async function publish(db: Kysely<Database>, message: BusMessage): Promise<void> {
  try {
    await sql`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(message)})`.execute(db);
  } catch (err) {
    /*
     * Swallowed, and that is the correct severity.
     *
     * A failed notification means a client refetches on its fallback timer
     * instead of immediately. A thrown error here would abort the transaction
     * that just accepted an order — trading a real state change for a
     * cosmetic one. Realtime is an accelerator over polling, never a
     * prerequisite for it, and this line is where that is enforced.
     */
    rootLogger.warn(
      { event: 'realtime_publish_failed', err, socketEvent: message.event },
      'realtime notify failed; clients will refetch on their fallback timer',
    );
  }
}

/**
 * A dedicated connection that LISTENs, with reconnection.
 *
 * NOT from the pool. A pooled client is returned after each query and may be
 * handed to somebody else or closed when idle; a LISTEN registered on it
 * disappears with no error and no notifications — the subscription simply
 * stops, and everything looks healthy. So this holds one connection open for
 * the life of the process and never gives it back.
 */
export class BusSubscriber {
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = 500;

  constructor(
    private readonly makeClient: () => pg.Client,
    private readonly onMessage: (m: BusMessage) => void,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) return;

    try {
      const client = this.makeClient();
      this.client = client;

      /*
       * Reconnect on a dropped connection. Postgres restarts, a failover, an
       * idle timeout on a proxy — all of them end this connection, and
       * without this the process keeps running and silently stops hearing
       * anything for ever. A realtime layer that fails closed and loudly is
       * fine; one that fails open and quietly is what puts a customer on a
       * screen that never changes.
       */
      client.on('error', (err) => {
        rootLogger.warn({ event: 'realtime_listen_error', err }, 'listener connection lost');
        void this.reconnect();
      });
      client.on('end', () => {
        if (!this.stopped) void this.reconnect();
      });

      client.on('notification', (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          this.onMessage(JSON.parse(msg.payload) as BusMessage);
        } catch (err) {
          rootLogger.warn({ event: 'realtime_payload_unreadable', err }, 'ignored a bad payload');
        }
      });

      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);

      // Only after a LISTEN has actually succeeded. Resetting it at the top of
      // this method would turn a tight crash-loop into an un-backed-off one.
      this.retryMs = 500;
      rootLogger.info({ event: 'realtime_listening', channel: CHANNEL }, 'realtime bus subscribed');
    } catch (err) {
      rootLogger.warn({ event: 'realtime_listen_failed', err }, 'could not subscribe; retrying');
      void this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;

    const client = this.client;
    this.client = null;
    if (client) {
      // The connection is already broken in the case that brought us here;
      // `end()` is best-effort cleanup, not something to fail on.
      try {
        await client.end();
      } catch {
        /* already gone */
      }
    }

    const wait = this.retryMs;
    // Capped exponential backoff. An unreachable database should not be met
    // with a connection attempt every 500ms from every replica.
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    await new Promise((r) => setTimeout(r, wait));
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.end();
    } catch {
      /* shutting down anyway */
    }
  }
}
