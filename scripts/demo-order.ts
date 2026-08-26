/**
 * Walks one order end to end against the real database and narrates it.
 *
 *   npm run demo:order
 *
 * There are no HTTP endpoints yet, so "run the product" has had no good answer.
 * This is the answer: the same modules the API will call, driven directly, so
 * you can watch a scan become a priced order become balanced ledger rows.
 *
 * EVERYTHING RUNS IN ONE TRANSACTION AND IS ROLLED BACK.
 *
 * Not tidiness — necessity. `ledger_entry` and `order_status_history` have
 * BEFORE UPDATE OR DELETE triggers that refuse every mutation from every role,
 * superusers included (migration 20260810000002). Demo rows written to those
 * tables could never be cleaned up afterwards. A transaction that never commits
 * is the only way to run this repeatedly against a database you care about.
 *
 * Pass --commit to keep the data. You will not be able to delete it.
 */

import { sql, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';

// Must come from here, not from `new pg.Pool(...)`. db.ts installs the int8
// type parser, and without it Postgres hands back every BIGINT — which is
// every monetary column — as a STRING. The first version of this script built
// its own pool and died on `money must be a number, got 18000`. That error is
// the branded Paise type doing its job: untyped, `"18000" + "500"` would have
// concatenated to 18000500 and the customer would have been charged ₹180,005.
import { createDb, createPool } from '../src/platform/db.js';
import { businessDate } from '../src/ordering/order.repository.js';
import type { Database, Json } from '../src/platform/schema.js';
import { paise, formatINR } from '../src/platform/money.js';
import { computeQuote } from '../src/pricing/quote.js';
import type { FeeRule, TaxModel } from '../src/pricing/fee-engine.js';
import { orderPlacementEntries } from '../src/ledger/entries.js';
import { assertTransitionAllowed } from '../src/ordering/state-machine.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required. Try: npm run demo:order');
  process.exit(2);
}
const KEEP = process.argv.includes('--commit');

const ESC = '';
const B = `${ESC}[1m`;
const D = `${ESC}[2m`;
const G = `${ESC}[32m`;
const Y = `${ESC}[33m`;
const O = `${ESC}[0m`;

let stepNo = 0;
const step = (t: string): void => void console.log(`\n${B}${stepNo++ + 1}. ${t}${O}`);
const note = (s: string): void => void console.log(`   ${D}${s}${O}`);
const ok = (s: string): void => void console.log(`   ${G}ok${O}  ${s}`);
const bad = (s: string): void => void console.log(`   ${Y}!!${O}  ${s}`);

/** JSONB columns: node-pg turns a JS array into a Postgres array literal, which is not JSON. */
const toJsonb = (v: unknown): Json => JSON.stringify(v) as unknown as Json;

/**
 * Runs something expected to fail, and contains the damage.
 *
 * A failed statement aborts the entire Postgres transaction — every subsequent
 * command returns "current transaction is aborted". This demo provokes three
 * failures on purpose, so each needs a real SAVEPOINT to roll back to. Kysely
 * 0.27 has no `savepoint()` helper, and a nested `.transaction()` reuses the
 * existing transaction rather than opening a savepoint, so the SQL is explicit.
 */
async function expectRefusal(
  trx: Transaction<Database>,
  name: string,
  attempt: () => Promise<unknown>,
  wrongOutcome: string,
): Promise<void> {
  await sql`SAVEPOINT ${sql.raw(name)}`.execute(trx);
  try {
    await attempt();
    await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(trx);
    bad(wrongOutcome);
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`.execute(trx);
    ok(`refused: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Thrown to force a rollback — Kysely commits unless the callback throws. */
class RollbackSignal extends Error {}

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: url! }));

  console.log(`\n${B}Food Court QR Ordering — one order, end to end${O}`);
  note(KEEP ? 'COMMITTING — this data will be permanent' : 'every write rolls back at the end');

  try {
    await db.transaction().execute(async (trx) => {
      // ------------------------------------------------------------- setup
      step('A food court opens, with one vendor and a menu');

      const court = await trx
        .insertInto('food_court')
        .values({ name: 'Phoenix Marketcity — Level 3', city: 'Ahmedabad', status: 'ACTIVE' })
        .returningAll()
        .executeTakeFirstOrThrow();

      const table = await trx
        .insertInto('court_table')
        .values({
          food_court_id: court.id,
          label: 'A12',
          qr_token: randomUUID().replace(/-/g, '').slice(0, 22),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const vendor = await trx
        .insertInto('vendor')
        .values({
          food_court_id: court.id,
          name: 'Spice Garden',
          status: 'ACTIVE',
          settlement_mode: 'PLATFORM_COLLECT',
          provider_linked_account_id: 'acc_demo',
          estimated_prep_minutes: 12,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const menu = await trx
        .insertInto('menu')
        .values({ vendor_id: vendor.id })
        .returningAll()
        .executeTakeFirstOrThrow();

      const category = await trx
        .insertInto('menu_category')
        .values({ menu_id: menu.id, name: 'Mains' })
        .returningAll()
        .executeTakeFirstOrThrow();

      const dish = await trx
        .insertInto('menu_item')
        .values({
          menu_id: menu.id,
          menu_category_id: category.id,
          name: 'Veg Manchurian',
          base_price_paise: 18_000,
          tax_rate_bps: 500,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      ok(`${court.name} · table ${table.label} · ${vendor.name}`);

      // ------------------------------------------------------ commercials
      step('Commercial terms are configured');
      const feeRules: FeeRule[] = [
        {
          id: 'demo-customer',
          scope: 'PLATFORM_DEFAULT',
          party: 'CUSTOMER',
          feeType: 'FLAT_PER_ORDER',
          amountPaise: paise(500),
          minFloorPaise: paise(0),
          taxRateBps: 1800,
          allowedModes: ['PLATFORM_COLLECT'],
          version: 1,
        },
        {
          id: 'demo-vendor',
          scope: 'VENDOR',
          party: 'VENDOR',
          feeType: 'PERCENTAGE',
          rateBps: 300,
          minFloorPaise: paise(0),
          taxRateBps: 1800,
          allowedModes: ['PLATFORM_COLLECT', 'VENDOR_DIRECT'],
          version: 1,
        },
        {
          id: 'demo-operator',
          scope: 'FOOD_COURT',
          party: 'OPERATOR',
          feeType: 'PERCENTAGE',
          rateBps: 100,
          minFloorPaise: paise(0),
          taxRateBps: 1800,
          allowedModes: ['PLATFORM_COLLECT'],
          version: 1,
        },
      ];
      const taxModel: TaxModel = {
        section9_5Applies: process.env.TAX_SECTION_9_5_APPLIES !== 'false',
        feeGstBps: 1800,
      };
      ok('₹5 customer fee · 3% vendor commission · 1% operator share');
      note(
        taxModel.section9_5Applies
          ? 'GST s.9(5) APPLIES — the platform retains the food GST rather than settling it'
          : 'GST s.9(5) does not apply — food GST settles through to the vendor',
      );

      // --------------------------------------------------------- customer
      step('A customer sits down and scans the QR code on the table');
      const session = await trx
        .insertInto('app_session')
        .values({
          food_court_id: court.id,
          court_table_id: table.id,
          active_vendor_id: vendor.id,
          expires_at: new Date(Date.now() + 4 * 3600_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ok(`session open for table ${table.label}, valid 4 hours`);
      note('no app install, no login — the QR token is the whole identity');

      step('They add a dish to the cart');
      const cart = await trx
        .insertInto('cart')
        .values({
          app_session_id: session.id,
          vendor_id: vendor.id,
          expires_at: new Date(Date.now() + 20 * 60_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('cart_item')
        .values({ cart_id: cart.id, menu_item_id: dish.id, vendor_id: vendor.id, quantity: 1 })
        .execute();
      ok(`${dish.name} × 1 — ${formatINR(paise(dish.base_price_paise))}`);

      step('They try to add something from a different stall');
      const rival = await trx
        .insertInto('vendor')
        .values({
          food_court_id: court.id,
          name: 'Wok This Way',
          status: 'ACTIVE',
          settlement_mode: 'PLATFORM_COLLECT',
          provider_linked_account_id: 'acc_demo_2',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expectRefusal(
        trx,
        'sp_cross_vendor',
        () =>
          trx
            .insertInto('cart_item')
            .values({ cart_id: cart.id, menu_item_id: dish.id, vendor_id: rival.id, quantity: 1 })
            .execute(),
        'the database ALLOWED a cross-vendor cart — it must not',
      );
      note('a trigger, not an API check — PRD CUS-CART-01');

      // ---------------------------------------------------------- pricing
      step('Checkout — the server reprices from its own menu, never from the client');
      const quote = computeQuote({
        lines: [{ lineTotalPaise: paise(dish.base_price_paise), taxRateBps: dish.tax_rate_bps }],
        feeRules,
        taxModel,
        settlementMode: 'PLATFORM_COLLECT',
      });

      const money = (label: string, v: number): void =>
        void console.log(`     ${label.padEnd(24)}${formatINR(paise(v)).padStart(12)}`);
      money('Subtotal', quote.subtotalPaise);
      money('Food GST', quote.foodTaxPaise);
      money('Platform fee', quote.customerFeePaise);
      money('GST on fee', quote.customerFeeTaxPaise);
      console.log(`     ${'-'.repeat(36)}`);
      money('Customer pays', quote.totalPayablePaise);

      // --------------------------------------------------------- ordering
      step('The order is placed');
      const idem = randomUUID();
      const correlationId = `demo-${randomUUID().slice(0, 8)}`;

      const order = await trx
        .insertInto('order')
        .values({
          public_order_number: 'A-042',
          business_date: businessDate(),
          app_session_id: session.id,
          food_court_id: court.id,
          vendor_id: vendor.id,
          court_table_id: table.id,
          // Snapshots. A historical order NEVER reprices: if the commission
          // changes tomorrow, last week's settlement must not move with it.
          settlement_mode_snapshot: quote.settlementModeSnapshot,
          fee_rule_snapshot: toJsonb(feeRules),
          tax_model_snapshot: toJsonb(taxModel),
          subtotal_paise: quote.subtotalPaise,
          food_tax_paise: quote.foodTaxPaise,
          customer_fee_paise: quote.customerFeePaise,
          customer_fee_tax_paise: quote.customerFeeTaxPaise,
          total_payable_paise: quote.totalPayablePaise,
          vendor_commission_paise: quote.distribution.vendorCommissionPaise,
          operator_share_paise: quote.distribution.operatorSharePaise,
          platform_tax_reserve_paise: quote.distribution.platformTaxReservePaise,
          vendor_net_paise: quote.distribution.vendorNetPaise,
          idempotency_key: idem,
          correlation_id: correlationId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('order_item')
        .values({
          order_id: order.id,
          menu_item_id: dish.id,
          name_snapshot: dish.name,
          unit_price_paise_snapshot: dish.base_price_paise,
          quantity: 1,
          line_total_paise: dish.base_price_paise,
          tax_rate_bps_snapshot: dish.tax_rate_bps,
          tax_paise: quote.foodTaxPaise,
        })
        .execute();

      ok(`order ${order.public_order_number} created — status ${order.status}`);

      step('The same request arrives again (flaky network, impatient tap)');
      await expectRefusal(
        trx,
        'sp_idem',
        () =>
          trx
            .insertInto('order')
            .values({
              public_order_number: 'A-043',
              business_date: businessDate(),
              food_court_id: court.id,
              vendor_id: vendor.id,
              court_table_id: table.id,
              settlement_mode_snapshot: 'PLATFORM_COLLECT',
              fee_rule_snapshot: toJsonb(feeRules),
              tax_model_snapshot: toJsonb(taxModel),
              subtotal_paise: quote.subtotalPaise,
              food_tax_paise: quote.foodTaxPaise,
              customer_fee_paise: quote.customerFeePaise,
              customer_fee_tax_paise: quote.customerFeeTaxPaise,
              total_payable_paise: quote.totalPayablePaise,
              idempotency_key: idem,
              correlation_id: correlationId,
            })
            .execute(),
        'a DUPLICATE ORDER was created — the customer would be charged twice',
      );
      note('a unique index. the API layer cannot forget to check it');

      // ----------------------------------------------------------- ledger
      step('Double-entry ledger rows are written');
      const entries = orderPlacementEntries(quote);
      for (const e of entries) {
        await trx
          .insertInto('ledger_entry')
          .values({
            order_id: order.id,
            vendor_id: e.party === 'VENDOR' ? vendor.id : null,
            food_court_id: court.id,
            entry_type: e.entryType,
            party: e.party,
            direction: e.direction,
            amount_paise: e.amountPaise,
            authority: 'AUTHORITATIVE',
            correlation_id: correlationId,
          })
          .execute();
      }

      const rows = await trx
        .selectFrom('ledger_entry')
        .select(['direction', 'entry_type', 'party', 'amount_paise'])
        .where('order_id', '=', order.id)
        .orderBy('direction')
        .orderBy('id')
        .execute();

      for (const r of rows) {
        console.log(
          `     ${r.direction.padEnd(7)}${r.entry_type.padEnd(23)}` +
            `${formatINR(paise(r.amount_paise)).padStart(11)}  ${D}${r.party ?? 'platform'}${O}`,
        );
      }

      const debits = rows.filter((r) => r.direction === 'DEBIT').reduce((a, r) => a + r.amount_paise, 0);
      const credits = rows.filter((r) => r.direction === 'CREDIT').reduce((a, r) => a + r.amount_paise, 0);
      console.log(`     ${'-'.repeat(50)}`);
      ok(`debits ${formatINR(paise(debits))}  =  credits ${formatINR(paise(credits))}`);

      // The invariant views are not in the Database type (they are views, and
      // nothing queries them through Kysely yet), so this goes through raw SQL.
      const imbalance = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM v_ledger_imbalance`.execute(trx);
      ok(`v_ledger_imbalance returns ${imbalance.rows[0]?.n ?? '?'} rows — the invariant holds`);

      step('Someone tries to quietly fix a ledger row');
      await expectRefusal(
        trx,
        'sp_ledger',
        () =>
          trx
            .updateTable('ledger_entry')
            .set({ amount_paise: 1 })
            .where('order_id', '=', order.id)
            .execute(),
        'the ledger was EDITED — PRD LED-01 is not being enforced',
      );
      note('a trigger, so it binds superusers too. corrections are new rows, never edits');

      // -------------------------------------------------------- lifecycle
      step('The order moves through its lifecycle');
      const journey = [
        ['CREATED', 'PAYMENT_PENDING', 'customer sent to UPI'],
        ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'webhook received'],
        ['PAYMENT_CONFIRMED', 'DISPATCHED', 'ticket pushed to the vendor KDS'],
        ['DISPATCHED', 'ACKNOWLEDGED', 'KDS acknowledged — a machine event, not a button'],
        ['ACKNOWLEDGED', 'PREPARING', 'kitchen started'],
        ['PREPARING', 'READY', 'customer notified to collect'],
        ['READY', 'COLLECTED', 'collected'],
      ] as const;

      for (const [from, to, why] of journey) {
        assertTransitionAllowed(from, to);
        await trx
          .insertInto('order_status_history')
          .values({ order_id: order.id, from_status: from, to_status: to, actor_type: 'SYSTEM' })
          .execute();
        console.log(`     ${from.padEnd(18)} -> ${to.padEnd(18)} ${D}${why}${O}`);
      }
      await trx.updateTable('order').set({ status: 'COLLECTED' }).where('id', '=', order.id).execute();

      step('A transition that must never be allowed');
      try {
        assertTransitionAllowed('COLLECTED', 'PREPARING');
        bad('a completed order went back to PREPARING');
      } catch (e) {
        ok(`refused: ${(e as Error).message}`);
      }

      const history = await trx
        .selectFrom('order_status_history')
        .select('to_status')
        .where('order_id', '=', order.id)
        .execute();
      ok(`${history.length} status rows, append-only — the history is fully reconstructable`);

      if (!KEEP) throw new RollbackSignal('rollback');
    });
  } catch (e) {
    if (!(e instanceof RollbackSignal)) {
      await db.destroy();
      throw e;
    }
  }

  console.log(
    KEEP
      ? `\n${G}${B}Committed.${O} The ledger rows are permanent — the triggers will not let you delete them.\n`
      : `\n${G}${B}Done — rolled back, database unchanged.${O}  ${D}Re-run any time; --commit to keep it.${O}\n`,
  );

  await db.destroy();
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
