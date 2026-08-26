/**
 * Proves the driver hands back money as integers, not strings.
 *
 * Every monetary column in this schema is BIGINT. `node-postgres` returns
 * BIGINT (oid 20) as a STRING by default — deliberately, because int8 exceeds
 * the JS safe-integer range. `src/platform/db.ts` installs a type parser that
 * converts to number and asserts safety.
 *
 * The failure mode this guards is quiet and expensive. With money arriving as
 * strings, `subtotal + fee` is string concatenation: 18000 + 500 becomes
 * "18000500", a ₹180,005 charge on a ₹185 order. No exception, no type error at
 * compile time — `schema.ts` says `number`, and the driver is not obliged to
 * agree with TypeScript.
 *
 * This is not hypothetical. `scripts/demo-order.ts` built its own `pg.Pool`
 * instead of calling `createPool`, so the parser never loaded, and it failed on
 * `money must be a number, got 18000`. It failed only because `paise()`
 * validates `typeof`. Anywhere that check is absent, the corruption is silent.
 *
 * So: the parser being installed is a testable property, and here it is tested.
 */

import { describe, it, expect, afterAll } from 'vitest';

import { createDb, createPool } from '../../src/platform/db.js';
import { paise } from '../../src/platform/money.js';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('BIGINT money survives the driver as a number', () => {
  const pool = url ? createPool({ connectionString: url }) : undefined;
  const db = pool ? createDb(pool) : undefined;

  afterAll(async () => {
    await db?.destroy();
  });

  it('returns a JS number for a BIGINT literal', async () => {
    const { rows } = await pool!.query<{ v: unknown }>(`SELECT 18000::bigint AS v`);
    expect(typeof rows[0]!.v, 'the int8 parser in db.ts is not installed').toBe('number');
    expect(rows[0]!.v).toBe(18_000);
  });

  it('produces values that paise() will accept', async () => {
    // paise() rejects non-numbers. It is the last line of defence and it
    // should never be the one that fires.
    const { rows } = await pool!.query<{ v: number }>(`SELECT 18000::bigint AS v`);
    expect(() => paise(rows[0]!.v)).not.toThrow();
  });

  it('adds rather than concatenates', async () => {
    const { rows } = await pool!.query<{ a: number; b: number }>(
      `SELECT 18000::bigint AS a, 500::bigint AS b`,
    );
    // The whole point. If the parser is missing this is "18000500".
    expect(rows[0]!.a + rows[0]!.b).toBe(18_500);
  });

  it('refuses a value beyond the safe integer range instead of rounding it', async () => {
    // 2^63-1 cannot be represented exactly as a double. Silently losing
    // precision on a money column is worse than failing, so db.ts throws.
    await expect(pool!.query(`SELECT 9223372036854775807::bigint AS v`)).rejects.toThrow(
      /safe integer/i,
    );
  });

});

/**
 * The tests above cannot catch the actual bug that happened.
 *
 * `pg.types.setTypeParser` mutates the `pg` module globally, so once anything
 * in a process imports `db.ts`, every pool in that process gets the parser —
 * including one built by hand. In a test run, `db.ts` is always imported. The
 * demo failed because it ran in its OWN process where nothing had imported it.
 *
 * An in-process assertion therefore proves nothing about a standalone script.
 * What can be checked is the thing that actually went wrong: a file building
 * its own pool instead of calling `createPool`.
 */
describe('nothing builds its own connection pool without saying why', () => {
  const ALLOWED = new Set([
    // The only sanctioned constructor. Installs the int8 parser.
    'src/platform/db.ts',
    // Standalone tooling: runs DDL and fixed-literal DML, never arithmetic on
    // money read back from the database. Safe without the parser, and kept
    // dependency-free on purpose so it can run before the app compiles.
    'scripts/migrate.ts',
    'scripts/test-constraints.ts',
    // The three `test-*.ts` scripts that read rows back are NOT here, and an
    // earlier version of this list had two of them. The reasoning was that they
    // only compare values rather than adding them, so the int8 parser did not
    // matter. `test-menu.ts` failed on its first run with
    // `got "3000", wanted 3000` — a BIGINT price read as a string, which is
    // exactly the thing this allowlist exists to prevent, arriving through the
    // exemption granted to prevent it.
    //
    // An allowlist entry is an argument that a file is safe. Two of the three
    // arguments were wrong. They call `createPool` now.
  ]);

  it('every `new pg.Pool` is in the allowlist', async () => {
    const { readFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');

    // git enumerates tracked files, so node_modules and dist are excluded for
    // free and no glob dependency is needed.
    const files = execSync('git ls-files "*.ts"', { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.length > 0);

    /**
     * Comments are stripped first, and that is not a nicety.
     *
     * `scripts/demo-order.ts` calls `createPool` correctly and carries a
     * comment saying "must come from here, not from `new pg.Pool(...)`" —
     * explaining the exact hazard, and naming it. The scanner matched the
     * explanation and reported the file that got it right.
     *
     * A guard that fires on the documentation of the rule it enforces trains
     * people to delete the documentation. Crude stripping is enough here: the
     * question is only whether the constructor is reachable code.
     */
    const codeOnly = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const offenders = files.filter(
      (f) => /new pg\.Pool\(|new Pool\(/.test(codeOnly(readFileSync(f, 'utf8'))) && !ALLOWED.has(f),
    );

    expect(
      offenders,
      'call createPool() from src/platform/db.ts — a hand-built pool returns every BIGINT ' +
        'as a string, and money arithmetic silently becomes string concatenation',
    ).toEqual([]);
  });
});
