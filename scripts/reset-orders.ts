/**
 * Clears every order and everything derived from one. DEVELOPMENT ONLY.
 *
 *   npm run reset:orders
 *
 * Keeps the food court, vendors, menus, fee rules, QR token and staff logins —
 * so you can re-seed orders repeatedly without rebuilding the world.
 *
 * WHY THIS IS A SEPARATE, DELIBERATE, LOUD SCRIPT
 *
 * Several tables are append-only, enforced by triggers that bind superusers
 * (migrations 20260810000002, 20260812000005, 20260817000008). That is a real
 * product guarantee — PRD LED-01 — and it must not be quietly weakened to make
 * development convenient.
 *
 * So this does the dangerous thing explicitly rather than pretending it is
 * safe: it refuses to run in production, disables the guards inside a
 * transaction, truncates, and turns them back on — then proves every one of
 * them came back. Everything is printed. If this script ever runs where it
 * should not, the reason will be obvious in the output rather than buried in a
 * helper that "just cleans up".
 *
 * Which tables are guarded is READ FROM THE DATABASE, not listed here. The
 * list used to be hardcoded at two entries, three migrations added more, and
 * the script failed naming a table that appeared nowhere in this file.
 *
 * The alternative was leaving the accidental TRUNCATE hole open and using it
 * silently. An intentional door beats an unnoticed gap.
 */

import { sql, type Kysely } from 'kysely';

import { createDb, createPool } from '../src/platform/db.js';
import type { Database } from '../src/platform/schema.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

if (process.env.NODE_ENV === 'production') {
  console.error('\n  Refusing to run: NODE_ENV is production.\n');
  process.exit(1);
}

/**
 * Order matters only for readability — TRUNCATE ... CASCADE handles the
 * foreign keys. Listed explicitly rather than using CASCADE alone so that
 * adding a new order-derived table is a deliberate edit here, not a silent
 * omission that leaves orphans behind.
 */
const TABLES = [
  'ledger_entry',
  'order_status_history',
  'order_item',
  'dispatch_attempt',
  'escalation_state',
  'notification',
  'refund',
  'payment',
  'platform_credit',
  'reconciliation_item',
  'settlement',
  // Explicit, though CASCADE would reach it anyway through its order_id.
  // That implicitness is what broke this script: `processed_event` was never
  // in this list, was pulled in by CASCADE, fired its own TRUNCATE guard, and
  // the failure named a table the reader could not find here.
  'processed_event',
  '"order"',
  'cart_item',
  'cart',
  'analytics_event',
  'app_session',
  'customer_otp',
  // Seeded customers hold a UNIQUE phone. Leaving them behind makes the second
  // `seed:orders` collide on `customer_phone_uq` — a confusing failure for
  // something whose whole job is "let me run that again".
  'customer',
] as const;

/**
 * Which tables are append-only, asked of the DATABASE rather than remembered.
 *
 * This was a hand-written list of two: `ledger_entry` and
 * `order_status_history`. Migration 20260812000005 added TRUNCATE guards to
 * `audit_log` and `processed_event` as well, and nobody came back here. The
 * script then failed with
 *
 *     processed_event is append-only; TRUNCATE is not permitted
 *
 * naming a table that appeared nowhere in this file, because CASCADE had
 * reached it.
 *
 * A list that must be kept in step with a migration will fall out of step with
 * a migration. Deriving it from `pg_trigger` means the next append-only table
 * is handled on the day it is created, by nobody.
 */
async function guardedTables(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT DISTINCT c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class     c ON c.oid = t.tgrelid
    JOIN pg_proc      p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND p.proname IN ('refuse_mutation', 'refuse_truncate')
    ORDER BY 1
  `.execute(db);

  return rows.map((r) => r.table_name);
}

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: url! }));

  const before = await sql<{ n: number }>`SELECT count(*)::int AS n FROM "order"`.execute(db);
  const orderCount = before.rows[0]?.n ?? 0;

  console.log(`\n  Clearing ${orderCount} order(s) and everything derived from them.`);
  console.log('  Keeping: food court, vendors, menus, fee rules, staff logins.\n');

  const guarded = await guardedTables(db);

  await db.transaction().execute(async (trx) => {
    // Printed one by one, not as a count, so the output shows exactly which
    // guarantee is being suspended and for how long.
    for (const t of guarded) {
      console.log(`  suspending append-only guard on ${t}`);
      await sql`ALTER TABLE ${sql.raw(t)} DISABLE TRIGGER USER`.execute(trx);
    }

    await sql`TRUNCATE TABLE ${sql.raw(TABLES.join(', '))} RESTART IDENTITY CASCADE`.execute(trx);
    console.log(`  truncated ${TABLES.length} tables`);

    /**
     * Vendor state that OUTLIVES the orders that caused it.
     *
     * The escalation ladder sets `dispatch_blocked_at` on a stall that has not
     * acknowledged in 90 seconds, and it is cleared when that stall
     * acknowledges. Delete the orders instead and the block has nothing left
     * to clear it — the stall stays blocked for ever, and the next
     * `seed:orders` dies with VENDOR_DISPATCH_BLOCKED against a stall whose
     * queue is empty.
     *
     * This is the general hazard with truncating a table that other rows point
     * at *conceptually* rather than by foreign key. CASCADE cannot help,
     * because there is no constraint to follow.
     */
    const unblocked = await trx
      .updateTable('vendor')
      .set({ dispatch_blocked_at: null, temp_closed_until: null })
      .where((eb) =>
        eb.or([
          eb('dispatch_blocked_at', 'is not', null),
          eb('temp_closed_until', 'is not', null),
        ]),
      )
      .executeTakeFirst();

    const n = Number(unblocked.numUpdatedRows ?? 0);
    if (n > 0) console.log(`  unblocked ${n} stall(s) left blocked by the escalation ladder`);

    for (const t of guarded) {
      await sql`ALTER TABLE ${sql.raw(t)} ENABLE TRIGGER USER`.execute(trx);
      console.log(`  restored append-only guard on ${t}`);
    }
  });

  /**
   * Prove EVERY guard came back, not just the one that is easy to test.
   *
   * Re-enabling inside a transaction that later rolled back would leave these
   * tables editable and nothing else in the system would notice.
   *
   * Two checks, because neither alone is enough:
   *
   *  1. `pg_trigger.tgenabled` — the direct state of the thing that was
   *     changed, for every guarded table. This is what catches a trigger left
   *     disabled on `processed_event`, whose guard covers DELETE and TRUNCATE
   *     but not UPDATE, so an UPDATE probe against it would pass while the
   *     table sat wide open to the operations that matter.
   *
   *  2. A real refused UPDATE on `ledger_entry` — behavioural proof that the
   *     mechanism works and not merely that a catalogue column says it should.
   *     A trigger can be enabled and still be pointing at a function somebody
   *     replaced with a no-op.
   */
  const { rows: disabled } = await sql<{ table_name: string; trigger_name: string }>`
    SELECT c.relname AS table_name, t.tgname AS trigger_name
    FROM pg_trigger t
    JOIN pg_class     c ON c.oid = t.tgrelid
    JOIN pg_proc      p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND p.proname IN ('refuse_mutation', 'refuse_truncate')
      AND t.tgenabled = 'D'
  `.execute(db);

  let stillGuarded = false;
  try {
    await sql`UPDATE ledger_entry SET amount_paise = 1 WHERE false`.execute(db);
  } catch {
    stillGuarded = true;
  }

  if (disabled.length > 0 || !stillGuarded) {
    console.error('\n  FAILED: an append-only guard did not come back.');
    for (const d of disabled) console.error(`    ${d.table_name}.${d.trigger_name} is DISABLED`);
    if (!stillGuarded) console.error('    ledger_entry accepted an UPDATE');
    console.error('\n  Run `npm run verify:db` and do not trust any money written since.\n');
    await db.destroy();
    process.exit(1);
  }

  console.log(`\n  ok  ${guarded.length} append-only guard(s) verified back in force`);
  console.log('  Re-seed with: npm run seed:orders\n');

  await db.destroy();
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
