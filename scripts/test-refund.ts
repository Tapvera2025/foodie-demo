/**
 * Asserts that money owed back actually goes back, and that the ledger says so.
 *
 * WHY THIS RUNS RATHER THAN ASSERTS IN ISOLATION
 *
 * `refund.ts` had nineteen passing unit tests and was imported by nothing. The
 * retry schedule was correct, the decision function was correct, and no
 * customer could ever have been refunded, because nothing called either. Unit
 * tests cannot see that. A request that pays for food, watches a stall ignore
 * it, and then asks for the money back can.
 *
 * The ledger assertions are the point of the file. A refund that moves a status
 * and leaves the vendor still credited is not a refund, it is a discrepancy
 * with good manners — and §14.6's whole argument for double entry is that this
 * class of error should be arithmetic rather than a matter of opinion.
 *
 * Needs the API, the worker, and a seeded court:
 *
 *   npm run setup && npm run dev:all
 *   npm run test:refund
 */

/**
 * `createPool`, not `new pg.Pool`.
 *
 * All three of these scripts were on the allowlist in `money-driver.test.ts`,
 * excused on the grounds that they only compare values rather than adding them.
 * The excuse was wrong, and `test-menu.ts` proved it on its first run:
 * `base_price_paise` came back as the STRING "3000" and every equality check
 * against a number failed. Reading a BIGINT without the int8 parser is the
 * §14.5 hazard whether or not you then do arithmetic on it.
 */
import { createPool } from '../src/platform/db.js';

const BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = createPool({ connectionString: url });

let failures = 0;
let checks = 0;
const pass = (n: string): void => {
  checks++;
  console.log(`  PASS  ${n}`);
};
const fail = (n: string, d: string): void => {
  checks++;
  failures++;
  console.error(`  FAIL  ${n}\n        ${d}`);
};
const expect = (n: string, a: unknown, w: unknown): void =>
  a === w ? pass(n) : fail(n, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Opts {
  method?: string;
  body?: unknown;
  session?: string;
  customer?: string;
  staff?: string;
}

async function call(path: string, o: Opts = {}): Promise<Record<string, unknown> & { _status: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.session) headers['X-Session-Token'] = o.session;
  if (o.customer ?? o.staff) headers['Authorization'] = `Bearer ${o.customer ?? o.staff}`;
  if (o.method === 'POST') headers['Idempotency-Key'] = `refund-test-${crypto.randomUUID()}`;
  const res = await fetch(`${API}${path}`, {
    method: o.method ?? 'GET',
    headers,
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { ...body, _status: res.status };
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return (rows[0] ? Object.values(rows[0])[0] : null) as T;
}

async function main(): Promise<void> {
  const courts = await call('/dev/courts');
  const token = (courts['courts'] as { token: string }[] | undefined)?.[0]?.token;
  if (!token) {
    console.error('No court. Run `npm run setup` with NODE_ENV=development.\n');
    process.exit(2);
  }

  /** A fresh customer with their own session — sessions are per client now. */
  async function customer(): Promise<{ session: string; auth: string }> {
    const scan = await call(`/qr/${token}`);
    const session = scan['sessionToken'] as string;
    const phone = `+9190000${String(Math.floor(Math.random() * 90000) + 10000)}`;
    await call('/auth/otp/request', { method: 'POST', body: { phone }, session });
    const code = (await call('/auth/otp/dev/latest'))['code'] as string;
    const auth = (
      await call('/auth/otp/verify', { method: 'POST', body: { phone, code, name: 'Refund Test' }, session })
    )['token'] as string;
    return { session, auth };
  }

  async function paidOrder(who: { session: string; auth: string }): Promise<string> {
    const scan = await call(`/qr/${token}`, { session: who.session });
    const fc = (scan['foodCourt'] as { id: string }).id;
    const vendors = await call(`/food-courts/${fc}/vendors`);
    const vendorId = (vendors['vendors'] as { id: string }[])[0]!.id;
    const menu = await call(`/vendors/${vendorId}/menu`);
    const itemId = (menu['categories'] as { items: { id: string }[] }[]).flatMap((c) => c.items)[0]!
      .id;
    const order = await call('/orders', {
      method: 'POST',
      body: { vendorId, lines: [{ menuItemId: itemId, quantity: 1 }] },
      session: who.session,
      customer: who.auth,
    });
    const orderId = order['orderId'] as string;
    await call(`/orders/${orderId}/payment-intent`, { method: 'POST', customer: who.auth });
    await call(`/dev/orders/${orderId}/simulate-payment`, { method: 'POST' });
    await sleep(4_000); // payment webhook + dispatch sweep
    return orderId;
  }

  const untilRefunded = async (orderId: string): Promise<string> => {
    for (let i = 0; i < 15; i++) {
      await sleep(2_000);
      const s = await one<string>(`SELECT status FROM refund WHERE order_id = $1`, [orderId]);
      if (s === 'SUCCEEDED') return s;
    }
    return (await one<string>(`SELECT status FROM refund WHERE order_id = $1`, [orderId])) ?? 'NONE';
  };

  /** The assertions that make a refund a refund rather than a status change. */
  async function assertSettled(orderId: string, label: string): Promise<void> {
    expect(`${label}: refund SUCCEEDED`, await untilRefunded(orderId), 'SUCCEEDED');
    expect(
      `${label}: order REFUNDED`,
      await one<string>(`SELECT status FROM "order" WHERE id = $1`, [orderId]),
      'REFUNDED',
    );
    expect(
      `${label}: payment REFUNDED`,
      await one<string>(`SELECT status FROM payment WHERE order_id = $1`, [orderId]),
      'REFUNDED',
    );
    expect(
      `${label}: ledger balances`,
      Number(await one(`SELECT count(*) FROM v_ledger_imbalance WHERE order_id = $1`, [orderId])),
      0,
    );
    for (const party of ['CUSTOMER', 'VENDOR', 'OPERATOR']) {
      const net = Number(
        await one(
          `SELECT coalesce(sum(CASE WHEN direction='DEBIT' THEN amount_paise ELSE -amount_paise END),0)
             FROM ledger_entry WHERE order_id = $1 AND party = $2`,
          [orderId, party],
        ),
      );
      expect(`${label}: ${party.toLowerCase()} is left owing nothing`, net, 0);
    }
  }

  console.log('\nA customer cancels an order no stall has accepted (§9 case D, §14.7)');
  const a = await customer();
  const cancelled = await paidOrder(a);
  const res = await call(`/orders/${cancelled}/cancel`, { method: 'POST', customer: a.auth });
  expect('the cancel is accepted', res['status'], 'CANCELLED');
  expect('and the customer is told money is coming back', res['refundStarting'], true);
  await assertSettled(cancelled, 'cancel');

  console.log('\nAnother customer cannot cancel it');
  const b = await customer();
  const victim = await paidOrder(b);
  expect(
    'a stranger cancelling gets 404, not 403',
    (await call(`/orders/${victim}/cancel`, { method: 'POST', customer: a.auth }))['_status'],
    404,
  );
  expect(
    'an anonymous caller is refused',
    (await call(`/orders/${victim}/cancel`, { method: 'POST' }))['_status'],
    401,
  );

  console.log('\nA stall rejects — the refund is automatic and the act is recorded (REF-01, §12.1)');
  const staff = (
    await call('/auth/login', {
      method: 'POST',
      body: { email: 'spice.garden@example.com', password: 'kitchen-password-2026' },
    })
  )['token'] as string;
  await call(`/kds/orders/${victim}/reject`, {
    method: 'POST',
    body: { reason: 'ITEM_OUT_OF_STOCK' },
    staff,
  });

  expect(
    'the rejection is audited',
    Number(
      await one(`SELECT count(*) FROM audit_log WHERE action='order.rejected' AND entity_id=$1`, [
        victim,
      ]),
    ),
    1,
  );
  expect(
    'the audit names a vendor user, not the default',
    await one<string>(`SELECT actor_type FROM audit_log WHERE action='order.rejected' AND entity_id=$1`, [
      victim,
    ]),
    'VENDOR_USER',
  );
  expect(
    'the audit records why',
    await one<string>(
      `SELECT after_value->>'reason' FROM audit_log WHERE action='order.rejected' AND entity_id=$1`,
      [victim],
    ),
    'ITEM_OUT_OF_STOCK',
  );
  await assertSettled(victim, 'rejection');
  expect(
    'the refund itself is audited',
    Number(
      await one(`SELECT count(*) FROM audit_log WHERE action='refund.initiated' AND entity_id=$1`, [
        victim,
      ]),
    ),
    1,
  );

  console.log('\nFood that was handed over is not refundable');
  const c = await customer();
  const collected = await paidOrder(c);
  for (const step of ['accept', 'ready', 'collect']) {
    await call(`/kds/orders/${collected}/${step}`, { method: 'POST', staff });
  }
  expect(
    'cancelling a COLLECTED order is refused',
    (await call(`/orders/${collected}/cancel`, { method: 'POST', customer: c.auth }))['_status'],
    409,
  );
  await sleep(4_000);
  expect(
    'and no refund was opened for it',
    Number(await one(`SELECT count(*) FROM refund WHERE order_id = $1`, [collected])),
    0,
  );
  expect(
    'its money was taken, not returned',
    await one<string>(`SELECT status FROM payment WHERE order_id = $1`, [collected]),
    'CAPTURED',
  );

  console.log('\nNothing anywhere is left unbalanced');
  expect('no order has an imbalanced ledger', Number(await one(`SELECT count(*) FROM v_ledger_imbalance`)), 0);
  expect(
    'nobody got a refund and a credit',
    Number(await one(`SELECT count(*) FROM v_credit_refund_conflict`)),
    0,
  );

  await pool.end();
  console.log('');
  if (failures > 0) {
    console.error(`${failures} of ${checks} checks failed.\n`);
    process.exit(1);
  }
  console.log(`All ${checks} refund checks passed.\n`);
}

void main().catch(async (e: unknown) => {
  await pool.end().catch(() => undefined);
  console.error(`\ntest-refund could not run: ${(e as Error).message}`);
  console.error('Are the API and the worker both up?  npm run dev:all\n');
  process.exit(2);
});
