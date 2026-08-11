/**
 * Makes the connection pool and the Kysely instance injectable.
 *
 * Until now nothing constructed a pool at all: `HealthController` instantiated
 * `new HealthService(undefined)` with a comment promising the pool would be
 * wired "once DATABASE_URL is reachable". The consequence was that `/readyz`
 * returned 503 with `postgres: pool not configured` on every request, in every
 * environment, permanently — and a readiness probe that always says no is
 * indistinguishable from one that is correctly detecting an outage.
 *
 * Global because the pool is process-wide infrastructure. There must be exactly
 * one: a second pool doubles the connection count against a Postgres whose
 * `max_connections` the ops guide budgets precisely (Infra & Ops §4.1).
 */

import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { config } from './config.js';
import { createDb, createPool } from './db.js';
import { rootLogger } from './logger.js';
import type { Database } from './schema.js';

/** Injection tokens. Interfaces and type aliases vanish at runtime, so Nest needs a value. */
export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): pg.Pool => {
        const cfg = config();
        // API gets 10, worker gets 5. docs/tech/data.md.
        return createPool({ connectionString: cfg.DATABASE_URL, max: 10 });
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Kysely<Database> => createDb(pool),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Drain on shutdown. `main.ts` calls `enableShutdownHooks()`, so this runs
   * before the process exits — a pool left open holds Postgres connections
   * until the server times them out, which during a rolling deploy is how you
   * exhaust `max_connections` with containers that are already gone.
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pool.end();
      rootLogger.info({ event: 'pg_pool_closed' }, 'connection pool drained');
    } catch (e) {
      rootLogger.error(
        { event: 'pg_pool_close_failed', err: e instanceof Error ? e.message : String(e) },
        'could not drain the connection pool',
      );
    }
  }
}
