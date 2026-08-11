/**
 * Static checks on the migration SQL that do not need a database.
 *
 * These exist because of a bug that shipped past both the PostgreSQL parser and
 * every unit test: the `updated_at` trigger loop built its trigger name as
 * `%I_touch`. `%I` quotes an identifier, so for a reserved-word table the
 * generated statement was:
 *
 *     CREATE TRIGGER "order"_touch BEFORE UPDATE ON "order" ...
 *
 * which is a syntax error — and only for the tables whose names are reserved
 * words. `food_court_touch` was fine. `"order"_touch` was not.
 *
 * The static parser could not catch it because the statement lives inside a
 * dollar-quoted plpgsql body, which is just a string literal until runtime.
 * These tests catch the shape of the mistake without needing Postgres running.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'db', 'migrations');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const raw = files.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n');

/**
 * Checks run against EXECUTABLE SQL, with `--` comments stripped.
 *
 * The first version of this file checked the raw text and failed on its own
 * documentation: the header comment says "There is no FLOAT/REAL/DOUBLE
 * anywhere", and the comment explaining the %I bug contains the very pattern it
 * warns about. A test that a prose edit can break is a test people learn to
 * ignore.
 *
 * This schema has no string literal containing `--`, so a per-line strip is
 * safe here. If one is ever added, this needs a real tokeniser.
 */
const sql = raw
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

describe('migration files are well-formed', () => {
  it('there is at least one migration', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every file has an up marker', () => {
    for (const f of files) {
      expect(readFileSync(join(DIR, f), 'utf8'), f).toContain('-- migrate:up');
    }
  });

  it('every filename starts with a sortable version', () => {
    for (const f of files) expect(f).toMatch(/^\d{14}_/);
  });
});

describe('format() identifier placeholders are not concatenated', () => {
  it('never appends text directly after %I', () => {
    // The exact bug. `%I_touch` and friends silently break for any identifier
    // that needs quoting, which is precisely the reserved-word tables.
    const offenders = [...sql.matchAll(/%I[A-Za-z0-9_]+/g)].map((m) => m[0]);
    expect(offenders, 'build the whole identifier and pass it to one %I').toEqual([]);
  });

  it('builds the trigger name as a single identifier', () => {
    expect(sql).toMatch(/t \|\| '_touch'/);
  });
});

describe('the reserved-word table is quoted everywhere it is used', () => {
  it('never writes a bare `ON order` or `FROM order`', () => {
    // `order` is a reserved word. Unquoted it parses as ORDER BY and produces
    // a baffling error a long way from the real cause.
    const bare = [...sql.matchAll(/\b(?:ON|FROM|INTO|UPDATE|TABLE)\s+order\b(?!")/gi)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });
});

describe('conventions the schema promises', () => {
  it('uses no floating-point type for money', () => {
    // PRD PAY-05. A FLOAT column would defeat the branded Paise type entirely.
    expect(sql).not.toMatch(/\b(FLOAT|REAL|DOUBLE PRECISION|NUMERIC|DECIMAL)\b/i);
  });

  it('stores every timestamp with a timezone', () => {
    const naive = [...sql.matchAll(/\bTIMESTAMP\b(?!TZ)/gi)];
    expect(naive.map((m) => m[0])).toEqual([]);
  });

  it('declares the invariant views the ops runbook depends on', () => {
    for (const view of [
      'v_ledger_imbalance',
      'v_credit_refund_conflict',
      'v_unacknowledged_orders',
      'v_stale_vendor_devices',
    ]) {
      expect(sql, `${view} is referenced by Infra & Ops §5.2`).toContain(view);
    }
  });

  it('revokes UPDATE and DELETE on the append-only tables', () => {
    expect(sql).toMatch(/REVOKE UPDATE, DELETE ON ledger_entry/);
    expect(sql).toMatch(/REVOKE UPDATE, DELETE ON order_status_history/);
  });

  /**
   * The REVOKE assertion above passed for weeks while the ledger was in fact
   * editable, because a REVOKE binds nobody until the role exists and binds no
   * superuser even then. Grants are a policy; a trigger is a guarantee. Assert
   * the guarantee, and keep the policy assertion only as a second signal.
   */
  it('guards every append-only table with a trigger, not only a grant', () => {
    expect(sql, 'the function the triggers call').toMatch(
      /CREATE OR REPLACE FUNCTION refuse_mutation\(\)/,
    );

    for (const table of ['ledger_entry', 'order_status_history', 'audit_log']) {
      const trigger = new RegExp(
        `BEFORE UPDATE OR DELETE ON ${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation`,
      );
      expect(sql, `${table} must refuse UPDATE and DELETE from every role`).toMatch(trigger);
    }

    for (const table of ['processed_event', 'dispatch_attempt']) {
      const trigger = new RegExp(
        `BEFORE DELETE ON ${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation`,
      );
      expect(sql, `${table} may be updated but never deleted`).toMatch(trigger);
    }
  });

  it('creates app_rw rather than skipping the grants when it is absent', () => {
    // The original block was `IF EXISTS (role) THEN ... ELSE RAISE NOTICE`,
    // so the default state of a fresh database was "enforced by nothing".
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_rw'\)/);
    expect(sql).toMatch(/CREATE ROLE app_rw/);
    expect(sql, 'a deploy user without CREATEROLE must not fail the migration').toMatch(
      /WHEN insufficient_privilege THEN/,
    );
  });
});
