/**
 * Migration runner.
 *
 * Replaces dbmate. The npm `dbmate` package distributes a Go binary through
 * optional platform dependencies, and on a fresh install it failed with
 * "Unable to locate dbmate binary '@dbmate/darwin-arm64/bin/dbmate'" — a
 * well-known failure mode of that distribution pattern, and a silly thing to
 * have between us and a database.
 *
 * The migration format is `-- migrate:up` / `-- migrate:down` markers in a
 * plain .sql file, and we already depend on `pg`. Sixty lines beats a binary.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate.ts up
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate.ts status
 *
 * IMPORTANT: the whole up-section runs as ONE query, deliberately. The schema
 * contains dollar-quoted function bodies ($$ ... $$) with semicolons inside
 * them, so splitting on ';' would corrupt it.
 */

import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

interface Migration {
  readonly version: string;
  readonly file: string;
  readonly up: string;
  /** CREATE INDEX CONCURRENTLY cannot run inside a transaction. */
  readonly noTransaction: boolean;
}

function load(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const upIndex = raw.indexOf('-- migrate:up');
      if (upIndex === -1) {
        throw new Error(`${file} has no "-- migrate:up" marker`);
      }
      const downIndex = raw.indexOf('-- migrate:down');
      const up = raw.slice(
        upIndex + '-- migrate:up'.length,
        downIndex === -1 ? undefined : downIndex,
      );
      return {
        version: file.split('_')[0] ?? file,
        file,
        up,
        noTransaction: /--\s*migrate:no-transaction/.test(raw),
      };
    });
}

async function ensureTable(c: pg.PoolClient): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(c: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await c.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function up(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedVersions(client);
    const pending = load().filter((m) => !done.has(m.version));

    if (pending.length === 0) {
      console.log('  no pending migrations');
      return;
    }

    for (const m of pending) {
      process.stdout.write(`  applying ${m.file} ... `);
      try {
        if (m.noTransaction) {
          await client.query(m.up);
        } else {
          await client.query('BEGIN');
          await client.query(m.up);
          await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [
            m.version,
            m.file,
          ]);
          await client.query('COMMIT');
        }
        if (m.noTransaction) {
          await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [
            m.version,
            m.file,
          ]);
        }
        console.log('ok');
      } catch (e) {
        if (!m.noTransaction) await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        console.error(`\n  ${m.file} did not apply:\n`);
        console.error(`  ${(e as Error).message}\n`);
        const pos = (e as { position?: string }).position;
        if (pos) {
          const offset = Number(pos);
          const context = m.up.slice(Math.max(0, offset - 200), offset + 200);
          console.error('  near:\n');
          console.error(
            context
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n'),
          );
          console.error('');
        }
        process.exit(1);
      }
    }
  } finally {
    client.release();
  }
}

async function status(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedVersions(client);
    for (const m of load()) {
      console.log(`  ${done.has(m.version) ? '[applied]' : '[pending]'} ${m.file}`);
    }
  } finally {
    client.release();
  }
}

/** Connection problems are not SQL problems. Say which one it is. */
function explainConnectionError(e: unknown): string | null {
  const code = (e as { code?: string }).code;
  const safeUrl = (url ?? '').replace(/:\/\/[^@]*@/, '://***@');
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening at ${safeUrl}.\n  Is Postgres running?  brew services start postgresql@16`;
    case 'ENOTFOUND':
      return `Cannot resolve the host in ${safeUrl}.`;
    case '3D000':
      return `The database in ${safeUrl} does not exist.  createdb foodcourt`;
    case '28P01':
    case '28000':
      return `Authentication failed for ${safeUrl}.`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const pool = new pg.Pool({ connectionString: url });
  try {
    if (cmd === 'up') await up(pool);
    else if (cmd === 'status') await status(pool);
    else {
      console.error(`unknown command "${cmd}" — expected "up" or "status"`);
      process.exit(2);
    }
  } catch (e) {
    const hint = explainConnectionError(e);
    console.error(`\n  ${hint ?? (e as Error).message}\n`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main();
