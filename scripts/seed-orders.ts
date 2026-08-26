/**
 * Fills the kitchen board with orders in every state worth looking at.
 *
 *   npm run seed:orders
 *
 * CLEARING THEM TAKES A DELIBERATE ACT.
 *
 * `ledger_entry` and `order_status_history` refuse DELETE and TRUNCATE from
 * every role including superusers. `npm run reset:orders` is the one sanctioned
 * way to wipe them: it suspends those guards by name, in a transaction, and
 * verifies they came back. Ordinary code cannot remove an order.
 *
 * Placement goes through the REAL OrderRepository — same pricing, same
 * snapshots, same balanced ledger rows. Fabricating order rows directly would
 * produce a board that looks right and money that is fiction, and the first
 * thing anyone would do with fiction is trust it.
 *
 * Only the status ADVANCEMENT is done directly here. The payment webhook and
 * the KDS actions both exist now, so this is a shortcut rather than a stand-in
 * for something missing — the point is a board populated in one command, not a
 * re-enactment of eight customers ordering.
 *
 * Each order gets a verified customer, so the notification ladder has somebody
 * to tell when a ticket is marked ready. Without that every seeded order logs
 * `notification_ladder_exhausted`, which is correct and useless.
 */

import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';

import { createDb, createPool } from '../src/platform/db.js';
import { OrderRepository } from '../src/ordering/order.repository.js';
import { assertTransitionAllowed } from '../src/ordering/state-machine.js';
import { loadConfig } from '../src/platform/config.js';
import type { OrderStatus, RejectionReason } from '../src/platform/schema.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
// The repository reads the tax determination from validated config.
loadConfig();

/** Where each order should end up, and how long ago it was placed. */
interface Scenario {
  readonly target: OrderStatus;
  readonly minutesAgo: number;
  readonly rejection?: RejectionReason;
  readonly note: string;
}

const SCENARIOS: Scenario[] = [
  { target: 'PAYMENT_CONFIRMED', minutesAgo: 0, note: 'just paid, kitchen has not seen it' },
  { target: 'DISPATCHED', minutesAgo: 1, note: 'on the board, unacknowledged' },
  // Deliberately old: the board colours a ticket amber at 2 minutes and red at
  // 3, so there needs to be one of each to check the thresholds actually fire.
  { target: 'DISPATCHED', minutesAgo: 4, note: 'late — should render red' },
  { target: 'ACKNOWLEDGED', minutesAgo: 3, note: 'accepted, not started' },
  { target: 'PREPARING', minutesAgo: 6, note: 'being cooked' },
  { target: 'READY', minutesAgo: 9, note: 'waiting at the counter' },
  { target: 'COLLECTED', minutesAgo: 25, note: 'collected earlier' },
  {
    target: 'REJECTED',
    minutesAgo: 15,
    rejection: 'ITEM_OUT_OF_STOCK',
    note: 'refused by the kitchen',
  },
];

/** The shortest legal route to each target. The state machine verifies it. */
const PATHS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PAYMENT_CONFIRMED: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED'],
  DISPATCHED: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'DISPATCHED'],
  ACKNOWLEDGED: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'DISPATCHED', 'ACKNOWLEDGED'],
  PREPARING: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'DISPATCHED', 'ACKNOWLEDGED', 'PREPARING'],
  READY: [
    'PAYMENT_PENDING',
    'PAYMENT_CONFIRMED',
    'DISPATCHED',
    'ACKNOWLEDGED',
    'PREPARING',
    'READY',
  ],
  COLLECTED: [
    'PAYMENT_PENDING',
    'PAYMENT_CONFIRMED',
    'DISPATCHED',
    'ACKNOWLEDGED',
    'PREPARING',
    'READY',
    'COLLECTED',
  ],
  REJECTED: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'DISPATCHED', 'ACKNOWLEDGED', 'REJECTED'],
};

const STAMP: Partial<Record<OrderStatus, string>> = {
  PAYMENT_CONFIRMED: 'payment_confirmed_at',
  DISPATCHED: 'dispatched_at',
  ACKNOWLEDGED: 'acknowledged_at',
  PREPARING: 'preparing_at',
  READY: 'ready_at',
  COLLECTED: 'collected_at',
};

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: url! }));
  const orders = new OrderRepository(db);

  const court = await db
    .selectFrom('food_court')
    .select(['id', 'name'])
    .where('status', '=', 'ACTIVE')
    .orderBy('created_at')
    .executeTakeFirst();

  if (!court) {
    console.error('\n  No food court. Run `npm run seed:dev` first.\n');
    process.exit(1);
  }

  const vendors = await db
    .selectFrom('vendor')
    .select(['id', 'name'])
    .where('food_court_id', '=', court.id)
    .where('status', '=', 'ACTIVE')
    .orderBy('name')
    .execute();

  if (vendors.length === 0) {
    console.error('\n  No vendors. Run `npm run seed:dev` first.\n');
    process.exit(1);
  }

  console.log(`\n  ${court.name} — creating ${SCENARIOS.length} orders\n`);

  for (const [i, scenario] of SCENARIOS.entries()) {
    // Spread across stalls so each kitchen login has something to look at,
    // and so the vendor scoping is visible rather than assumed.
    const vendor = vendors[i % vendors.length]!;

    const items = await db
      .selectFrom('menu_item')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .select(['menu_item.id'])
      .where('menu.vendor_id', '=', vendor.id)
      .where('menu_item.status', '=', 'ACTIVE')
      .where('menu_item.availability', '=', 'AVAILABLE')
      .limit(3)
      .execute();

    if (items.length === 0) {
      console.log(`  skipped ${vendor.name} — no menu items`);
      continue;
    }

    // A verified customer, so the notification ladder has somebody to tell.
    //
    // Without this every seeded order logs `notification_ladder_exhausted` at
    // error level — which is CORRECT behaviour for an order with no customer,
    // and useless as a demonstration. A board full of orders nobody can be
    // notified about does not show the feature that makes the product work.
    //
    // Numbers are +9190000000NN: valid E.164, obviously synthetic, and in a
    // range that is not allocated to real subscribers.
    const phone = `+9190000000${String(10 + i).slice(-2)}`;
    const customer = await db
      .insertInto('customer')
      .values({ phone, phone_verified_at: new Date() })
      .onConflict((oc) => oc.column('phone').doUpdateSet({ phone_verified_at: new Date() }))
      .returning('id')
      .executeTakeFirstOrThrow();

    const session = await db
      .insertInto('app_session')
      .values({
        food_court_id: court.id,
        court_table_id: null,
        customer_id: customer.id,
        expires_at: new Date(Date.now() + 4 * 3600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // One or two lines, varied so the board is not a wall of identical cards.
    const lines = items.slice(0, 1 + (i % 2)).map((it, n) => ({
      menuItemId: it.id,
      quantity: 1 + (n % 2),
      ...(i % 3 === 0 ? { instructions: 'Less spicy please' } : {}),
    }));

    const placed = await orders.placeOrder({
      sessionId: session.id,
      vendorId: vendor.id,
      lines,
      idempotencyKey: `seed-${randomUUID()}`,
      correlationId: `seed-${randomUUID().slice(0, 8)}`,
    });

    // Backdate so ticket ages are realistic. Done after placement because the
    // repository stamps created_at itself, and a seed that could set it would
    // be a seed that could also set it wrong in production code.
    const placedAt = new Date(Date.now() - scenario.minutesAgo * 60_000);
    await db
      .updateTable('order')
      .set({ created_at: placedAt })
      .where('id', '=', placed.id)
      .execute();

    // The payment the webhook would have written.
    //
    // Not optional decoration: migration 20260817000007 added a trigger that
    // refuses PAYMENT_CONFIRMED on an order with no AUTHORIZED or CAPTURED
    // payment (PRD §7.4). Without this row the seed fails, which is the
    // constraint doing its job — a seeded "paid" order with no payment behind
    // it is exactly the fiction this script's header refuses to produce.
    const path = PATHS[scenario.target] ?? [];
    if (path.includes('PAYMENT_CONFIRMED')) {
      await db
        .insertInto('payment')
        .values({
          order_id: placed.id,
          settlement_mode: 'PLATFORM_COLLECT',
          provider: 'stub',
          method: 'upi',
          // AUTHORIZED rather than CAPTURED: PAYMENTS_SPLIT_TIMING defaults to
          // ON_ACKNOWLEDGED, so at the moment an order is confirmed the money
          // is blocked and not yet taken. Seeding CAPTURED would make the board
          // look right and the money wrong.
          status: 'AUTHORIZED',
          amount_paise: placed.totalPayablePaise,
          provider_order_ref: `seed_${randomUUID().slice(0, 12)}`,
          authorized_at: placedAt,
          expires_at: new Date(placedAt.getTime() + 15 * 60_000),
        })
        .execute();
    }

    let from: OrderStatus = 'CREATED';
    for (const to of path) {
      // Validated rather than assumed. If a future change to the state machine
      // makes one of these paths illegal, this seed fails loudly instead of
      // writing history that the application could never have produced.
      assertTransitionAllowed(from, to);

      const at = new Date(placedAt.getTime() + 30_000);
      const stamp = STAMP[to];

      await db
        .updateTable('order')
        .set({
          status: to,
          ...(stamp ? { [stamp]: at } : {}),
          ...(to === 'REJECTED'
            ? {
                rejection_reason: scenario.rejection ?? 'OTHER',
                rejection_note: 'Seeded for testing',
                terminal_at: at,
              }
            : {}),
          ...(to === 'COLLECTED' ? { terminal_at: at } : {}),
        })
        .where('id', '=', placed.id)
        .execute();

      await db
        .insertInto('order_status_history')
        .values({
          order_id: placed.id,
          from_status: from,
          to_status: to,
          actor_type: to === 'REJECTED' ? 'VENDOR_USER' : 'SYSTEM',
          ...(to === 'REJECTED' ? { reason: scenario.rejection ?? 'OTHER' } : {}),
        })
        .execute();

      from = to;
    }

    console.log(
      `  ${placed.publicOrderNumber.padEnd(7)} ${scenario.target.padEnd(18)} ` +
        `${vendor.name.padEnd(15)} ${scenario.note}`,
    );
  }

  // The invariant that matters. Every order above wrote real ledger rows, so
  // if any of them failed to balance this view would not be empty.
  // Views are not in the Database type — nothing queries them through Kysely
  // yet — so this goes through raw SQL, the same way demo-order.ts does.
  const imbalance = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM v_ledger_imbalance`.execute(db);
  const n = imbalance.rows[0]?.n ?? 0;

  console.log(
    n === 0
      ? '\n  v_ledger_imbalance is empty — every order balances.\n'
      : `\n  WARNING: v_ledger_imbalance has ${n} rows. Money does not add up.\n`,
  );
  console.log('  Kitchen board: http://localhost:5174\n');

  await db.destroy();
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
