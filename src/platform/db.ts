/**
 * Database access — Kysely over node-postgres.
 *
 * Why not an ORM: docs/tech/data.md. The short version is `SELECT ... FOR
 * UPDATE`, plus a schema containing triggers, DO blocks and GRANT/REVOKE that
 * no ORM can own.
 *
 * TDD §3, PRD §18.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

/**
 * Postgres returns BIGINT (int8) as a string by default, because it can exceed
 * JS number range. Every monetary column in this schema is BIGINT paise, so we
 * parse to number ONCE, here, and assert the value is a safe integer.
 *
 * ₹92,233,720,368 is the ceiling. A single order will not approach it and
 * neither will a lifetime settlement total. If that ever stops being true,
 * move to BigInt deliberately — not by accident.
 *
 * docs/tech/data.md.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value out of safe integer range: ${v}`);
  }
  return n;
});

/**
 * Table types live in `./schema.js` and are kept honest by
 * `tests/integration/schema-conformance.test.ts`, which compares them against
 * `information_schema` on a real database in CI.
 *
 * This was an empty interface until now, which meant `Kysely<Database>` had no
 * tables at all and every query would have been a type error the moment one
 * was written. Nothing complained because nothing had queried yet.
 */
export type { Database, Json } from './schema.js';

export interface PoolOptions {
  connectionString: string;
  /** API 10, worker 5. docs/tech/data.md. */
  max?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /**
   * How long to wait for a CONNECTION, as opposed to a query.
   *
   * Absent on the API, where the pool should keep trying rather than fail a
   * customer's checkout on a momentary blip. Present here because a diagnostic
   * run against a database that is not up should say so in seconds rather than
   * hang — and that difference is a reason to expose the option, not a reason
   * for scripts to build their own pool and lose the INT8 parser with it.
   */
  connectionTimeoutMillis?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    // A checkout query that takes ten seconds has already failed the customer.
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    // Stops an escalation sweeper stalling behind a long transaction.
    lock_timeout: opts.lockTimeoutMs ?? 3_000,
    // Catches a forgotten await holding a row lock.
    idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs ?? 15_000,
    ...(opts.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: opts.connectionTimeoutMillis }),
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/** Used by /readyz. Cheap, and it proves the pool can actually serve a query. */
export async function pingDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
