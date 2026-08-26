/**
 * Asserts that PRD v5.2 §18.3 constraints are enforced by the DATABASE, not by
 * application code.
 *
 * The distinction matters. Application-level checks can be bypassed by a future
 * engineer in a hurry, a background job, or a psql session at 1am. A unique
 * index cannot.
 *
 * HOW THIS WORKS, and why it is not the obvious shape:
 *
 * Each case has a `setup` that MUST succeed and a `violate` that MUST throw.
 * The control matters — an earlier version of this script used
 * `INSERT ... SELECT ... FROM food_court, vendor LIMIT 1` against an empty
 * database, which inserts zero rows and throws nothing, so every check reported
 * a false PASS. A constraint test that cannot fail is worse than no test.
 *
 * Everything runs inside a transaction that is rolled back, so the database is
 * left exactly as it was found.
 *
 *   DATABASE_URL=postgres://... npm run test:constraints
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });

/** Minimal fixtures every case builds on. Ids are stable within a transaction. */
const ids = {
  court: randomUUID(),
  tableA: randomUUID(),
  vendorA: randomUUID(),
  vendorB: randomUUID(),
  menu: randomUUID(),
  category: randomUUID(),
  item: randomUUID(),
  cart: randomUUID(),
  session: randomUUID(),
  order: randomUUID(),
  /** A second order, used as the CONTROL for the payment-confirmation trigger. */
  orderPaid: randomUUID(),
  payment: randomUUID(),
  customer: randomUUID(),
};

async function seed(c: pg.PoolClient): Promise<void> {
  await c.query(
    `INSERT INTO food_court (id, name, city, status) VALUES ($1,'Test Court','Ahmedabad','ACTIVE')`,
    [ids.court],
  );
  await c.query(
    `INSERT INTO court_table (id, food_court_id, label, qr_token)
     VALUES ($1,$2,'A12',$3)`,
    [ids.tableA, ids.court, 'a'.repeat(22)],
  );
  for (const [id, name] of [
    [ids.vendorA, 'Spice Garden'],
    [ids.vendorB, 'Wok This Way'],
  ] as const) {
    await c.query(
      `INSERT INTO vendor (id, food_court_id, name, status, settlement_mode, provider_linked_account_id)
       VALUES ($1,$2,$3,'ACTIVE','PLATFORM_COLLECT','acc_test')`,
      [id, ids.court, name],
    );
  }
  await c.query(`INSERT INTO menu (id, vendor_id) VALUES ($1,$2)`, [ids.menu, ids.vendorA]);
  await c.query(`INSERT INTO menu_category (id, menu_id, name) VALUES ($1,$2,'Mains')`, [
    ids.category,
    ids.menu,
  ]);
  await c.query(
    `INSERT INTO menu_item (id, menu_id, menu_category_id, name, base_price_paise)
     VALUES ($1,$2,$3,'Veg Manchurian',18000)`,
    [ids.item, ids.menu, ids.category],
  );
  await c.query(
    `INSERT INTO app_session (id, food_court_id, court_table_id, expires_at)
     VALUES ($1,$2,$3, now() + interval '4 hours')`,
    [ids.session, ids.court, ids.tableA],
  );
  await c.query(
    `INSERT INTO cart (id, app_session_id, vendor_id, expires_at)
     VALUES ($1,$2,$3, now() + interval '20 minutes')`,
    [ids.cart, ids.session, ids.vendorA],
  );
  await c.query(
    `INSERT INTO "order" (id, public_order_number, food_court_id, vendor_id, court_table_id,
       settlement_mode_snapshot, fee_rule_snapshot, tax_model_snapshot,
       subtotal_paise, food_tax_paise, total_payable_paise, idempotency_key, correlation_id)
     VALUES ($1,'A-001',$2,$3,$4,'PLATFORM_COLLECT','{}','{}',25000,1250,26250,$5,'corr-1')`,
    [ids.order, ids.court, ids.vendorA, ids.tableA, 'idem-seed'],
  );
  // A second order in PAYMENT_PENDING. The confirmation-trigger case needs one
  // order it can legitimately confirm and one it cannot, or the check would
  // pass on a database where PAYMENT_CONFIRMED is unreachable full stop.
  await c.query(
    `INSERT INTO "order" (id, public_order_number, food_court_id, vendor_id, court_table_id,
       settlement_mode_snapshot, fee_rule_snapshot, tax_model_snapshot,
       subtotal_paise, food_tax_paise, total_payable_paise, idempotency_key, correlation_id, status)
     VALUES ($1,'A-900',$2,$3,$4,'PLATFORM_COLLECT','{}','{}',25000,1250,26250,$5,'corr-2','PAYMENT_PENDING')`,
    [ids.orderPaid, ids.court, ids.vendorA, ids.tableA, 'idem-seed-paid'],
  );
  await c.query(`UPDATE "order" SET status = 'PAYMENT_PENDING' WHERE id = $1`, [ids.order]);
}

interface Case {
  name: string;
  requirement: string;
  /** Must succeed. Proves the violation attempt below is actually meaningful. */
  control?: (c: pg.PoolClient) => Promise<void>;
  /** Must throw. */
  violate: (c: pg.PoolClient) => Promise<void>;
}

const cases: Case[] = [
  {
    name: 'duplicate order.idempotency_key is rejected',
    requirement: 'PRD API-01 / §18.3 — the single most important constraint',
    control: async (c) => {
      await c.query(
        `INSERT INTO "order" (id, public_order_number, food_court_id, vendor_id, court_table_id,
           settlement_mode_snapshot, fee_rule_snapshot, tax_model_snapshot,
           subtotal_paise, total_payable_paise, idempotency_key, correlation_id)
         VALUES ($1,'A-002',$2,$3,$4,'PLATFORM_COLLECT','{}','{}',100,100,'idem-dup','c')`,
        [randomUUID(), ids.court, ids.vendorA, ids.tableA],
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO "order" (id, public_order_number, food_court_id, vendor_id, court_table_id,
           settlement_mode_snapshot, fee_rule_snapshot, tax_model_snapshot,
           subtotal_paise, total_payable_paise, idempotency_key, correlation_id)
         VALUES ($1,'A-003',$2,$3,$4,'PLATFORM_COLLECT','{}','{}',100,100,'idem-dup','c')`,
        [randomUUID(), ids.court, ids.vendorA, ids.tableA],
      );
    },
  },
  {
    name: 'duplicate processed_event is rejected',
    requirement: 'PRD PAY-03 — webhook idempotency by constraint, not by lookup',
    control: async (c) => {
      await c.query(
        `INSERT INTO processed_event (provider, provider_event_id) VALUES ('razorpay','evt_dup')`,
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO processed_event (provider, provider_event_id) VALUES ('razorpay','evt_dup')`,
      );
    },
  },
  {
    name: 'a second LIVE payment on one order is rejected',
    requirement: 'PRD §8 — one basket must never produce two simultaneous charges',
    control: async (c) => {
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250)`,
        [ids.order],
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250)`,
        [ids.order],
      );
    },
  },
  {
    // The other half of the rule above, and the reason the index is partial.
    // Without this case the suite would happily pass on the plain unique index
    // that made retrying impossible — a check that only ever says "no" cannot
    // tell you whether "yes" still works.
    name: 'retrying after a failed payment IS allowed',
    requirement: 'PRD §7.2 — a retry is a new payment on the same order, not an overwrite',
    control: async (c) => {
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise, status)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250,'FAILED')`,
        [ids.order],
      );
      // The retry. This is the assertion; it must NOT throw.
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise, status)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250,'PENDING')`,
        [ids.order],
      );
    },
    violate: async (c) => {
      // A third payment while the retry above is still live must be refused,
      // so the permissiveness has a floor.
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise, status)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250,'PENDING')`,
        [ids.order],
      );
    },
  },
  {
    name: 'UPDATE on ledger_entry is refused',
    requirement: 'PRD LED-01 — append-only enforced by trigger, which binds superusers too',
    control: async (c) => {
      await c.query(
        `INSERT INTO ledger_entry (order_id, food_court_id, entry_type, direction, amount_paise, authority)
         VALUES ($1,$2,'GROSS_ORDER_VALUE','CREDIT',25000,'AUTHORITATIVE')`,
        [ids.order, ids.court],
      );
    },
    violate: async (c) => {
      await c.query(`UPDATE ledger_entry SET amount_paise = 1 WHERE order_id = $1`, [ids.order]);
    },
  },
  {
    name: 'DELETE on ledger_entry is refused',
    requirement: 'PRD LED-01 — corrections are compensating entries, never removals',
    control: async (c) => {
      await c.query(
        `INSERT INTO ledger_entry (order_id, food_court_id, entry_type, direction, amount_paise, authority)
         VALUES ($1,$2,'FOOD_TAX','CREDIT',1250,'AUTHORITATIVE')`,
        [ids.order, ids.court],
      );
    },
    violate: async (c) => {
      await c.query(`DELETE FROM ledger_entry WHERE order_id = $1`, [ids.order]);
    },
  },
  {
    name: 'UPDATE on order_status_history is refused',
    requirement: 'PRD ORD-SM-04 — order state must be reconstructable from history',
    control: async (c) => {
      await c.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, actor_type)
         VALUES ($1,'CREATED','PAYMENT_PENDING','SYSTEM')`,
        [ids.order],
      );
    },
    violate: async (c) => {
      await c.query(`UPDATE order_status_history SET to_status = 'COLLECTED' WHERE order_id = $1`, [
        ids.order,
      ]);
    },
  },
  {
    name: 'DELETE on audit_log is refused',
    requirement: 'PRD SEC-09 — an audit trail somebody can erase is not an audit trail',
    control: async (c) => {
      await c.query(
        `INSERT INTO audit_log (actor_type, action, entity) VALUES ('SYSTEM','refund.initiated','order')`,
      );
    },
    violate: async (c) => {
      await c.query(`DELETE FROM audit_log WHERE true`);
    },
  },
  {
    name: 'DELETE on processed_event is refused',
    requirement: 'PRD PAY-03 — deleting one would let a replayed webhook through',
    control: async (c) => {
      await c.query(
        `INSERT INTO processed_event (provider, provider_event_id) VALUES ('razorpay','evt_keep')`,
      );
    },
    violate: async (c) => {
      await c.query(`DELETE FROM processed_event WHERE provider_event_id = 'evt_keep'`);
    },
  },
  {
    name: 'cart_item for a different vendor than its cart is rejected',
    requirement: 'PRD CUS-CART-01 — single-vendor cart by trigger, not by API check',
    control: async (c) => {
      await c.query(
        `INSERT INTO cart_item (cart_id, menu_item_id, vendor_id, quantity)
         VALUES ($1,$2,$3,1)`,
        [ids.cart, ids.item, ids.vendorA],
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO cart_item (cart_id, menu_item_id, vendor_id, quantity)
         VALUES ($1,$2,$3,1)`,
        [ids.cart, ids.item, ids.vendorB],
      );
    },
  },
  // =========================================================================
  // The vocabulary migrations — 20260817000006 / 007
  // =========================================================================
  {
    name: 'the retired COMPLETED status is refused on an order',
    requirement: 'PRD §7.1 — COLLECTED replaced it; the enum label cannot be dropped',
    control: async (c) => {
      // Proves the UPDATE reaches the row and that a status change is possible
      // at all. Without it the violation below could be matching nothing and
      // reporting a false pass — the exact bug that made an earlier version of
      // this script report 12 green checks against an empty database.
      await c.query(`UPDATE "order" SET status = 'READY' WHERE id = $1`, [ids.order]);
    },
    violate: async (c) => {
      await c.query(`UPDATE "order" SET status = 'COMPLETED' WHERE id = $1`, [ids.order]);
    },
  },
  {
    name: 'the retired SUCCESS payment status is refused',
    requirement: 'PRD §8.1 — SUCCESS cannot express the gap between blocked and taken',
    control: async (c) => {
      await c.query(
        `INSERT INTO payment (id, order_id, settlement_mode, provider, amount_paise, status)
         VALUES ($1,$2,'PLATFORM_COLLECT','stub',26250,'PENDING')`,
        [ids.payment, ids.order],
      );
    },
    violate: async (c) => {
      await c.query(`UPDATE payment SET status = 'SUCCESS' WHERE id = $1`, [ids.payment]);
    },
  },
  {
    name: 'an AUTHORIZED payment without a timestamp is refused',
    requirement: 'PRD §8.1 — a state that asserts an event must carry when it happened',
    control: async (c) => {
      await c.query(
        `INSERT INTO payment (id, order_id, settlement_mode, provider, amount_paise, status, authorized_at)
         VALUES ($1,$2,'PLATFORM_COLLECT','stub',26250,'AUTHORIZED', now())`,
        [randomUUID(), ids.order],
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO payment (id, order_id, settlement_mode, provider, amount_paise, status)
         VALUES ($1,$2,'PLATFORM_COLLECT','stub',26250,'AUTHORIZED')`,
        [randomUUID(), ids.order],
      );
    },
  },
  {
    name: 'PARTIALLY_REFUNDED with the full amount refunded is refused',
    requirement: 'PRD §8.1 — the label and the number must agree',
    violate: async (c) => {
      await c.query(
        `INSERT INTO payment (id, order_id, settlement_mode, provider, amount_paise, status, refunded_paise)
         VALUES ($1,$2,'PLATFORM_COLLECT','stub',26250,'PARTIALLY_REFUNDED',26250)`,
        [randomUUID(), ids.order],
      );
    },
  },
  {
    name: 'refunding more than was charged is refused',
    requirement: 'PRD §14.7 — a refund cannot exceed the payment it reverses',
    violate: async (c) => {
      await c.query(
        `INSERT INTO payment (id, order_id, settlement_mode, provider, amount_paise, status, refunded_paise)
         VALUES ($1,$2,'PLATFORM_COLLECT','stub',26250,'REFUNDED',30000)`,
        [randomUUID(), ids.order],
      );
    },
  },

  // =========================================================================
  // The binding rule. The most important check in this file.
  // =========================================================================
  {
    name: 'an order cannot become PAYMENT_CONFIRMED without an authorised payment',
    requirement:
      'PRD §7.4 / §8.2 — no client request may transition an order into a financially ' +
      'authoritative state. A browser saying "it worked" is a hint, not evidence.',
    control: async (c) => {
      // The control proves the same UPDATE succeeds once a real payment backs
      // it. Without this the check would also pass on a database where nothing
      // can ever reach PAYMENT_CONFIRMED, which is not the property we want.
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise, status, authorized_at)
         VALUES ($1,'PLATFORM_COLLECT','stub',26250,'AUTHORIZED', now())`,
        [ids.orderPaid],
      );
      await c.query(`UPDATE "order" SET status = 'PAYMENT_CONFIRMED' WHERE id = $1`, [
        ids.orderPaid,
      ]);
    },
    violate: async (c) => {
      // ids.order has no AUTHORIZED or CAPTURED payment on it.
      await c.query(`UPDATE "order" SET status = 'PAYMENT_CONFIRMED' WHERE id = $1`, [ids.order]);
    },
  },

  // =========================================================================
  // Product / availability / inventory — 20260817000008
  // =========================================================================
  {
    name: 'an AVAILABLE item with a future available_from is refused',
    requirement: 'PRD §6 — availability and its expiry must not contradict each other',
    control: async (c) => {
      await c.query(
        `UPDATE menu_item SET availability = 'SOLD_OUT', available_from = now() + interval '1 hour'
         WHERE id = $1`,
        [ids.item],
      );
    },
    violate: async (c) => {
      await c.query(
        `UPDATE menu_item SET availability = 'AVAILABLE', available_from = now() + interval '1 hour'
         WHERE id = $1`,
        [ids.item],
      );
    },
  },
  {
    name: 'negative daily stock is refused',
    requirement: 'PRD §6 — a count of how many exist cannot be less than none',
    control: async (c) => {
      await c.query(
        `INSERT INTO menu_item_stock (menu_item_id, service_date, daily_stock)
         VALUES ($1, CURRENT_DATE, 50)`,
        [ids.item],
      );
    },
    violate: async (c) => {
      await c.query(`UPDATE menu_item_stock SET daily_stock = -1 WHERE menu_item_id = $1`, [
        ids.item,
      ]);
    },
  },
  {
    name: 'UPDATE on menu_item_stock_history is refused',
    requirement: '"who set this to zero at 12:40" needs an answer nobody can edit',
    control: async (c) => {
      await c.query(
        `INSERT INTO menu_item_stock_history (menu_item_id, service_date, new_stock, actor_type)
         VALUES ($1, CURRENT_DATE, 50, 'VENDOR_USER')`,
        [ids.item],
      );
    },
    violate: async (c) => {
      await c.query(`UPDATE menu_item_stock_history SET new_stock = 0 WHERE menu_item_id = $1`, [
        ids.item,
      ]);
    },
  },
  {
    name: 'TRUNCATE on menu_item_stock_history is refused',
    requirement: 'TRUNCATE is a separate trigger event; a DELETE trigger does not fire for it',
    violate: async (c) => {
      await c.query(`TRUNCATE TABLE menu_item_stock_history`);
    },
  },

  // =========================================================================
  // Customer identity — 20260817000009
  // =========================================================================
  {
    name: 'a customer phone that is not E.164 is refused',
    requirement:
      'PRD §11.2 — "9876543210" and "+91 98765 43210" are one customer and two rows ' +
      'unless normalisation is enforced rather than remembered',
    control: async (c) => {
      await c.query(`INSERT INTO customer (id, phone) VALUES ($1,'+919876543210')`, [ids.customer]);
    },
    violate: async (c) => {
      await c.query(`INSERT INTO customer (id, phone) VALUES ($1,'9876543210')`, [randomUUID()]);
    },
  },
  {
    name: 'two customers cannot share a phone number',
    requirement: 'PRD §11.2 — the phone IS the identity',
    control: async (c) => {
      await c.query(`INSERT INTO customer (id, phone) VALUES ($1,'+919876543210')`, [ids.customer]);
    },
    violate: async (c) => {
      await c.query(`INSERT INTO customer (id, phone) VALUES ($1,'+919876543210')`, [randomUUID()]);
    },
  },
  {
    name: 'a second live OTP for one phone is refused',
    requirement:
      'PRD §11.2 — requesting a new code must invalidate the old one, or both work and ' +
      'the window in which an overheard code is useful doubles with every resend',
    control: async (c) => {
      await c.query(
        `INSERT INTO customer_otp (phone, code_hash, channel, expires_at)
         VALUES ('+919812345678','h1','CONSOLE', now() + interval '5 minutes')`,
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO customer_otp (phone, code_hash, channel, expires_at)
         VALUES ('+919812345678','h2','CONSOLE', now() + interval '5 minutes')`,
      );
    },
  },
  {
    name: 'an OTP cannot be both consumed and superseded',
    requirement: 'a code has one ending, and reporting two makes the audit meaningless',
    violate: async (c) => {
      await c.query(
        `INSERT INTO customer_otp (phone, code_hash, channel, expires_at, consumed_at, superseded_at)
         VALUES ('+919811111111','h3','CONSOLE', now() + interval '5 minutes', now(), now())`,
      );
    },
  },

  {
    name: 'a fee rule paying a court operator is refused',
    requirement:
      'Two parties split an order: the vendor and the platform. The product is sold ' +
      'direct to vendors, so there is no operator with a settlement account. A rule ' +
      'allocating a share to one is not a pricing decision, it is a leak — and it ' +
      'would only surface in a settlement report months later.',
    violate: async (c) => {
      await c.query(
        `INSERT INTO fee_rule (scope, party, fee_type, rate_bps, tax_rate_bps, allowed_modes, version, effective_from)
         VALUES ('PLATFORM_DEFAULT','OPERATOR','PERCENTAGE',100,1800,ARRAY['PLATFORM_COLLECT']::settlement_mode[],1,now())`,
      );
    },
  },
  {
    name: 'the two parties that remain are still accepted',
    requirement: 'PRD §14.1 — charge the vendor, the customer, both, or neither',
    // The control IS the assertion here. A constraint made entirely of "no"
    // cannot tell you whether the thing you still need has survived it —
    // errata E-006, in its second incarnation.
    control: async (c) => {
      await c.query(
        `INSERT INTO fee_rule (scope, party, fee_type, rate_bps, tax_rate_bps, allowed_modes, version, effective_from)
         VALUES ('PLATFORM_DEFAULT','VENDOR','PERCENTAGE',300,1800,ARRAY['PLATFORM_COLLECT']::settlement_mode[],1,now())`,
      );
      await c.query(
        `INSERT INTO fee_rule (scope, party, fee_type, amount_paise, tax_rate_bps, allowed_modes, version, effective_from)
         VALUES ('PLATFORM_DEFAULT','CUSTOMER','FLAT_PER_ORDER',500,1800,ARRAY['PLATFORM_COLLECT']::settlement_mode[],1,now())`,
      );
    },
    violate: async (c) => {
      await c.query(
        `INSERT INTO fee_rule (scope, party, fee_type, rate_bps, tax_rate_bps, allowed_modes, version, effective_from)
         VALUES ('PLATFORM_DEFAULT','OPERATOR','PERCENTAGE',100,1800,ARRAY['PLATFORM_COLLECT']::settlement_mode[],1,now())`,
      );
    },
  },
  {
    name: 'negative money is rejected',
    requirement: 'PRD PAY-05 — CHECK constraints on monetary columns',
    violate: async (c) => {
      await c.query(
        `INSERT INTO payment (order_id, settlement_mode, provider, amount_paise)
         VALUES ($1,'PLATFORM_COLLECT','stub',-1)`,
        [ids.order],
      );
    },
  },
  {
    name: 'an active vendor without a settlement mode is rejected',
    requirement: 'PRD PAY-MODE-01 — mode cannot be null for an active vendor',
    violate: async (c) => {
      await c.query(
        `INSERT INTO vendor (food_court_id, name, status, settlement_mode)
         VALUES ($1,'No Mode Stall','ACTIVE',NULL)`,
        [ids.court],
      );
    },
  },
  {
    name: 'an order whose totals do not add up is rejected',
    requirement: 'PRD §18.3 — order_total_consistent',
    violate: async (c) => {
      await c.query(
        `INSERT INTO "order" (id, public_order_number, food_court_id, vendor_id, court_table_id,
           settlement_mode_snapshot, fee_rule_snapshot, tax_model_snapshot,
           subtotal_paise, food_tax_paise, total_payable_paise, idempotency_key, correlation_id)
         VALUES ($1,'A-BAD',$2,$3,$4,'PLATFORM_COLLECT','{}','{}',25000,1250,99999,'idem-bad','c')`,
        [randomUUID(), ids.court, ids.vendorA, ids.tableA],
      );
    },
  },
  {
    name: 'a rejected order without a reason is refused',
    requirement: 'PRD KDS-REJ-02 — reason is mandatory',
    violate: async (c) => {
      await c.query(`UPDATE "order" SET status = 'REJECTED' WHERE id = $1`, [ids.order]);
    },
  },
  {
    name: 'an order snapshot cannot be edited after insert',
    requirement: 'PRD DATA-03 — snapshots are immutable',
    violate: async (c) => {
      await c.query(`UPDATE "order" SET subtotal_paise = 1 WHERE id = $1`, [ids.order]);
    },
  },
  {
    name: 'a duplicate QR token is rejected',
    requirement: 'PRD SEC-02 / FC-ONB-02 — one active token per table',
    violate: async (c) => {
      await c.query(
        `INSERT INTO court_table (food_court_id, label, qr_token) VALUES ($1,'B01',$2)`,
        [ids.court, 'a'.repeat(22)],
      );
    },
  },
];

async function main(): Promise<void> {
  let failures = 0;
  let controlFailures = 0;

  console.log(`\nRunning ${cases.length} constraint checks against the database.\n`);

  for (const tc of cases) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await seed(client);

      // The control must succeed, or the violation below proves nothing.
      if (tc.control) {
        try {
          await client.query('SAVEPOINT ctl');
          await tc.control(client);
        } catch (e) {
          controlFailures++;
          failures++;
          console.error(`  ERROR ${tc.name}`);
          console.error(`        control insert failed: ${(e as Error).message}`);
          console.error(`        the check below would be meaningless, so it was skipped`);
          await client.query('ROLLBACK');
          continue;
        }
      }

      let threw = false;
      let message = '';
      try {
        await tc.violate(client);
      } catch (e) {
        threw = true;
        message = (e as Error).message.split('\n')[0] ?? '';
      }
      await client.query('ROLLBACK');

      if (threw) {
        console.log(`  PASS  ${tc.name}`);
        console.log(`        -> ${message}`);
      } else {
        failures++;
        console.error(`  FAIL  ${tc.name}`);
        console.error(`        ${tc.requirement}`);
        console.error(`        The database ACCEPTED this. It must not.`);
      }
    } finally {
      client.release();
    }
  }

  // Invariant views must be empty at all times.
  for (const view of ['v_ledger_imbalance', 'v_credit_refund_conflict']) {
    try {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${view}`);
      const n = (rows[0] as { n: number }).n;
      if (n === 0) console.log(`  PASS  ${view} is empty`);
      else {
        failures++;
        console.error(`  FAIL  ${view} returned ${n} rows — an invariant has been violated`);
      }
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${view} could not be queried: ${(e as Error).message}`);
    }
  }

  await pool.end();

  console.log('');
  if (controlFailures > 0) {
    console.error(
      `${controlFailures} control insert(s) failed — the schema does not match this script.\n`,
    );
  }
  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(`All ${cases.length + 2} constraint checks passed.\n`);
}

void main();
