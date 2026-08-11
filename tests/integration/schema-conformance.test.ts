/**
 * Asserts `src/platform/schema.ts` and the real database agree.
 *
 * These types are what TypeScript believes about the database. Nothing else
 * checks them: if a migration renames a column, every query still compiles,
 * because the types ARE the compiler's notion of truth. The error surfaces in
 * production as `column "foo" does not exist`, on the one code path nobody
 * exercised.
 *
 * `kysely-codegen` addresses this only at the moment someone remembers to run
 * it — and it was referenced by package.json while absent from
 * devDependencies, so on this repo it had never run at all. A test is better:
 * it runs on every push against the Postgres 16 service in CI, so drift is
 * caught on the commit that causes it.
 *
 * Requires DATABASE_URL. Skipped when absent so `npm test` still works offline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

interface Column {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

/**
 * Parses the declared interfaces out of schema.ts.
 *
 * A regex over source is a blunt instrument, but the alternative — importing
 * the module and reflecting over it — cannot work: TypeScript interfaces are
 * erased at runtime and there is nothing left to inspect. The parse is narrow
 * and the file has a machine-regular shape, so it holds.
 */
function declaredTables(): Map<string, Map<string, string>> {
  const src = readFileSync(join(process.cwd(), 'src', 'platform', 'schema.ts'), 'utf8');

  // Table name -> interface name, from the Database map.
  const dbBlock = /export interface Database \{([\s\S]*?)\n\}/.exec(src);
  if (!dbBlock) throw new Error('no `export interface Database` block found in schema.ts');

  const ifaceOf = new Map<string, string>();
  for (const m of dbBlock[1]!.matchAll(/^\s*'?([a-z_]+)'?:\s*(\w+);/gm)) {
    ifaceOf.set(m[1]!, m[2]!);
  }

  const out = new Map<string, Map<string, string>>();
  for (const [table, iface] of ifaceOf) {
    if (table === 'schema_migrations') continue; // owned by the runner, not the schema
    const block = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
    if (!block) throw new Error(`schema.ts declares ${table}: ${iface}, but ${iface} is not defined`);
    const cols = new Map<string, string>();
    for (const m of block[1]!.matchAll(/^\s*(\w+):\s*(.+);$/gm)) {
      cols.set(m[1]!, m[2]!.trim());
    }
    out.set(table, cols);
  }
  return out;
}

describeDb('schema.ts conforms to the live database', () => {
  let pool: pg.Pool | undefined;
  let actual = new Map<string, Map<string, Column>>();
  let declared = new Map<string, Map<string, string>>();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    const { rows } = await pool.query<Column>(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, ordinal_position
    `);
    actual = new Map();
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Map());
      actual.get(r.table_name)!.set(r.column_name, r);
    }
    declared = declaredTables();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('declares every table the database has', () => {
    const dbTables = [...actual.keys()].filter((t) => t !== 'schema_migrations').sort();
    const missing = dbTables.filter((t) => !declared.has(t));
    expect(missing, 'tables in the database that schema.ts does not declare').toEqual([]);
  });

  it('declares no table the database lacks', () => {
    const extra = [...declared.keys()].filter((t) => !actual.has(t));
    expect(extra, 'tables schema.ts declares that do not exist').toEqual([]);
  });

  it('declares exactly the columns each table has', () => {
    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const real = actual.get(table);
      if (!real) continue; // reported by the test above
      for (const name of real.keys()) {
        if (!cols.has(name)) problems.push(`${table}.${name} exists but is not declared`);
      }
      for (const name of cols.keys()) {
        if (!real.has(name)) problems.push(`${table}.${name} is declared but does not exist`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('marks a column nullable if and only if the database does', () => {
    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const real = actual.get(table);
      if (!real) continue;
      for (const [name, ts] of cols) {
        const col = real.get(name);
        if (!col) continue;
        const tsNullable = /\bnull\b/.test(ts);
        const dbNullable = col.is_nullable === 'YES';
        if (tsNullable !== dbNullable) {
          problems.push(
            `${table}.${name}: schema.ts says ${tsNullable ? 'nullable' : 'NOT NULL'}, ` +
              `database says ${dbNullable ? 'nullable' : 'NOT NULL'}`,
          );
        }
      }
    }
    // Getting this backwards is the expensive direction: a column typed
    // non-null that is actually nullable produces `undefined` reaching code
    // that cannot see it coming.
    expect(problems).toEqual([]);
  });

  it('wraps every defaulted column in Generated<>', () => {
    // Without Generated<>, Kysely requires the column on every insert, and the
    // first thing anyone does is pass a value — which silently overrides the
    // database default. For `created_at` that means clock skew in the audit
    // trail; for `currency` it means a row that is not INR.
    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const real = actual.get(table);
      if (!real) continue;
      for (const [name, ts] of cols) {
        const col = real.get(name);
        if (!col?.column_default) continue;
        if (name === 'updated_at') continue; // DbManaged — stricter than Generated
        if (!ts.startsWith('Generated<')) {
          problems.push(`${table}.${name} has DEFAULT ${col.column_default} but is not Generated<>`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('types every enum column as its own union, never string', () => {
    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const real = actual.get(table);
      if (!real) continue;
      for (const [name, ts] of cols) {
        const col = real.get(name);
        if (col?.data_type !== 'USER-DEFINED') continue;
        // A Postgres enum widened to `string` in TypeScript throws away the
        // whole benefit: every invalid status becomes a runtime 22P02 instead
        // of a compile error.
        if (/\bstring\b/.test(ts)) {
          problems.push(`${table}.${name} is enum ${col.udt_name} but typed as string`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('types every monetary column as a number', () => {
    // PRD PAY-05. Also catches the driver-level trap: without the int8 parser
    // in db.ts, Postgres hands back BIGINT as a string and `a + b` silently
    // becomes concatenation.
    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const real = actual.get(table);
      if (!real) continue;
      for (const [name, ts] of cols) {
        if (!name.endsWith('_paise')) continue;
        if (real.get(name)?.data_type !== 'bigint') {
          problems.push(`${table}.${name} is money but not BIGINT in the database`);
        }
        if (!/\bnumber\b/.test(ts)) problems.push(`${table}.${name} is money but not number in TS`);
      }
    }
    expect(problems).toEqual([]);
  });
});
