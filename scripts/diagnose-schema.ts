/**
 * Does the running database actually have the columns the code selects?
 *
 * ============================================================================
 * THE SYMPTOM THIS EXISTS FOR
 * ============================================================================
 *
 *   GET /api/v1/console/offer-slots  ->  500 INTERNAL
 *   { "code": "INTERNAL", "message": "Something went wrong on our side." }
 *
 * That response is deliberately uninformative — it is what a stranger gets, and
 * leaking `column vendor.offer_slot_requested_at does not exist` to the public
 * internet would hand somebody a map of the schema. The cost is that the person
 * who owns the database gets the same blank stare.
 *
 * And the cause is almost always the same one. A feature ships as a migration
 * plus the code that reads it; the code arrives through `git pull`, the
 * migration does not run itself, and every endpoint touching the new columns
 * starts failing with a message designed to say nothing. Nothing typechecks
 * wrong, because `schema.ts` is a DECLARATION of what the database should hold
 * rather than a reading of what it does.
 *
 * So this compares the two directly: every column `Database` declares, against
 * `information_schema.columns` on the database the API is actually pointed at.
 *
 *   npm run diagnose:schema
 *
 * Read-only. It changes nothing, and it never prints a value from a row.
 */

import { sql } from 'kysely';
import { createDb, createPool } from '../src/platform/db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';


const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const OFF = '\x1b[0m';

/*
 * `process.cwd()`, not `import.meta.url`.
 *
 * This tsconfig emits CommonJS, where `import.meta` is a hard compile error —
 * the same reason `migrate.ts` resolves its own directory from the cwd. Every
 * `npm run` script starts in the package root, which is what makes it safe
 * here and would not be if this were a library.
 */
const root = resolve(process.cwd());

function head(s: string): void {
  console.log(`\n${BOLD}${s}${OFF}`);
  console.log('─'.repeat(78));
}

/**
 * What the CODE believes each table holds.
 *
 * Parsed out of `schema.ts` rather than derived from the types, because
 * TypeScript interfaces do not exist at runtime — there is no reflection that
 * can list `VendorTable`'s keys once it is compiled. The file is the only place
 * the truth is written down in a form something can read.
 *
 * Deliberately NOT clever about the parse. It reads `foo: Type;` lines out of
 * each `interface XTable` block and stops there. A field it fails to see is a
 * check not made — the failure mode is a quieter tool, not a wrong answer.
 */
function declaredColumns(): Map<string, Set<string>> {
  const src = readFileSync(resolve(root, 'src/platform/schema.ts'), 'utf8');

  // `order_item: OrderItemTable;` inside the Database interface: the mapping
  // from a table NAME to the interface describing it. Reading this rather than
  // guessing that `VendorTable` means `vendor` — `food_court` is `FoodCourtTable`
  // but `v_menu_item_stock_remaining` is not going to follow any rule.
  const dbBlock = src.match(/export interface Database\s*\{([\s\S]*?)\n\}/);
  if (!dbBlock) throw new Error('could not find `interface Database` in schema.ts');

  const out = new Map<string, Set<string>>();

  for (const m of dbBlock[1]!.matchAll(/^\s*(\w+):\s*(\w+);/gm)) {
    const table = m[1]!;
    const iface = m[2]!;

    const block = src.match(new RegExp(`export interface ${iface}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!block) continue;

    const cols = new Set<string>();
    for (const line of block[1]!.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      const f = t.match(/^(\w+)\??:/);
      if (f) cols.add(f[1]!);
    }
    out.set(table, cols);
  }

  return out;
}

/** Migration files on disk, newest last. */
function migrationsOnDisk(): string[] {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.log(`${RED}DATABASE_URL is not set.${OFF}`);
    console.log(`${DIM}This script reads it the same way the API does — from .env.${OFF}`);
    process.exit(1);
  }

  const db = createDb(createPool({ connectionString: url, max: 2 }));

  let problems = 0;

  try {
    // ---------------------------------------------------------------- ping
    head('the database');
    const who = await sql<{
      db: string;
      usr: string;
    }>`SELECT current_database() AS db, current_user AS usr`.execute(db);
    const w = who.rows[0]!;
    console.log(`  ${GREEN}ok${OFF}    connected to ${BOLD}${w.db}${OFF} as ${w.usr}`);

    // ---------------------------------------------------------- migrations
    /*
     * WHICH MIGRATIONS THE DATABASE THINKS IT HAS RUN.
     *
     * The count on disk versus the count applied is the single most useful
     * number here, and it is the one the 500 was really reporting.
     */
    head('migrations');
    const disk = migrationsOnDisk();

    const hasTable = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    `.execute(db);

    if ((hasTable.rows[0]?.n ?? 0) === 0) {
      problems++;
      console.log(`  ${RED}FAIL${OFF}  no \`schema_migrations\` table — nothing has ever been applied`);
      console.log(`        ${CYAN}npm run migrate:up${OFF}`);
    } else {
      /*
       * `version`, which is the TIMESTAMP PREFIX of the filename and not the
       * filename — see `load()` in migrate.ts, which does
       * `file.split('_')[0]`. Matching on the whole name instead would report
       * every applied migration as pending, which is a diagnostic that lies in
       * the same direction as the bug it is diagnosing: the worst kind.
       */
      const applied = await sql<{ version: string }>`
        SELECT version FROM schema_migrations ORDER BY version
      `.execute(db);
      const done = new Set(applied.rows.map((r) => r.version));
      const missing = disk.filter((f) => !done.has(f.split('_')[0] ?? f));

      if (missing.length === 0) {
        console.log(`  ${GREEN}ok${OFF}    ${disk.length} on disk, all applied`);
      } else {
        problems++;
        console.log(
          `  ${RED}FAIL${OFF}  ${disk.length} on disk, ${done.size} applied — ${BOLD}${missing.length} NOT RUN${OFF}`,
        );
        for (const m of missing) console.log(`        ${YELLOW}·${OFF} ${m}`);
        console.log(`\n        ${CYAN}npm run migrate:up${OFF}`);
      }
    }

    // -------------------------------------------------------------- columns
    /*
     * THE ACTUAL COMPARISON.
     *
     * One direction only: a column the CODE expects and the database lacks.
     * The reverse — a column in the database that no interface mentions — is
     * ordinary (a migration landing before the code that reads it) and
     * reporting it would bury the failure that matters in noise.
     */
    head('columns the code selects');

    const live = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
    `.execute(db);

    const actual = new Map<string, Set<string>>();
    for (const r of live.rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }

    const declared = declaredColumns();
    let clean = 0;

    for (const [table, cols] of [...declared].sort()) {
      const have = actual.get(table);

      if (!have) {
        problems++;
        console.log(`  ${RED}FAIL${OFF}  table ${BOLD}${table}${OFF} does not exist`);
        continue;
      }

      const missing = [...cols].filter((c) => !have.has(c));
      if (missing.length === 0) {
        clean++;
        continue;
      }

      problems++;
      console.log(
        `  ${RED}FAIL${OFF}  ${BOLD}${table}${OFF} is missing ${missing.length}: ${missing.join(', ')}`,
      );
      console.log(
        `        ${DIM}every endpoint selecting one of these returns 500 INTERNAL${OFF}`,
      );
    }

    if (problems === 0) {
      console.log(`  ${GREEN}ok${OFF}    ${clean} tables, every declared column present`);
    } else if (clean > 0) {
      console.log(`  ${DIM}${clean} other tables are complete${OFF}`);
    }
  } finally {
    await db.destroy();
  }

  console.log('');
  if (problems === 0) {
    console.log(`${GREEN}${BOLD}The schema matches the code.${OFF}`);
    console.log(
      `${DIM}A 500 is therefore something else — check the API log for the correlationId.${OFF}`,
    );
  } else {
    console.log(`${RED}${BOLD}${problems} problem${problems === 1 ? '' : 's'}.${OFF}`);
    console.log(`${DIM}Almost always: ${OFF}${CYAN}npm run migrate:up${OFF}`);
  }
  process.exit(problems === 0 ? 0 : 1);
}

void main().catch((e: unknown) => {
  console.error(`${RED}${String(e)}${OFF}`);
  process.exit(1);
});
