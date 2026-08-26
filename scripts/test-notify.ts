/**
 * Asserts a customer is told once, not once per worker tick.
 *
 * WHY THIS NEEDS TO RUN, NOT BE READ
 *
 * The ladder walks WEBSOCKET → WEB_PUSH → WHATSAPP → SMS and stops on the
 * first tier that reports success. Read on its own, `notify()` did exactly
 * that. The defect only appeared across ticks: `notifyReady` re-queries every
 * READY order every 1.5 seconds by design, the per-tier dedupe index made an
 * already-claimed rung `continue` rather than stop, and so each tick delivered
 * one rung further down. WhatsApp on tick 1, SMS on tick 2.
 *
 * Nothing about that is visible in a single call, and nothing about it is
 * visible today in the log either, because every tier is a console stub. It
 * becomes two paid messages to one confused customer on the day a real BSP and
 * a real DLT registration land — which is the worst possible day to find it.
 *
 * So this drives a real order to READY and then watches the table for twenty
 * seconds, which is what found it in the first place.
 *
 * Needs the API, the worker and a seeded court:
 *
 *   npm run setup && npm run dev:all    # in one terminal
 *   npm run test:notify                 # in another
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
const pass = (n: string): void => console.log(`  PASS  ${n}`);
const fail = (n: string, d: string): void => {
  failures++;
  console.error(`  FAIL  ${n}\n        ${d}`);
};

async function call(
  path: string,
  opts: { method?: string; body?: unknown; session?: string; customer?: string; staff?: string } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.session) headers['X-Session-Token'] = opts.session;
  if (opts.customer) headers['Authorization'] = `Bearer ${opts.customer}`;
  if (opts.staff) headers['Authorization'] = `Bearer ${opts.staff}`;
  if (opts.method === 'POST') headers['Idempotency-Key'] = `notify-test-${crypto.randomUUID()}`;

  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const courts = await call('/dev/courts');
  const token = (courts['courts'] as { token: string }[] | undefined)?.[0]?.token;
  if (!token) {
    console.error('No court. Run `npm run setup` first, with NODE_ENV=development.\n');
    process.exit(2);
  }

  const scan = await call(`/qr/${token}`);
  const session = scan['sessionToken'] as string;
  const fc = (scan['foodCourt'] as { id: string }).id;

  const vendors = await call(`/food-courts/${fc}/vendors`);
  const vendorId = (vendors['vendors'] as { id: string }[])[0]!.id;
  const menu = await call(`/vendors/${vendorId}/menu`);
  const itemId = (menu['categories'] as { items: { id: string }[] }[]).flatMap((c) => c.items)[0]!
    .id;

  const phone = `+9190000${String(Math.floor(Math.random() * 90000) + 10000)}`;
  await call('/auth/otp/request', { method: 'POST', body: { phone }, session });
  const code = (await call('/auth/otp/dev/latest'))['code'] as string;
  const customer = (
    await call('/auth/otp/verify', { method: 'POST', body: { phone, code, name: 'Notify Test' }, session })
  )['token'] as string;

  const order = await call('/orders', {
    method: 'POST',
    body: { vendorId, lines: [{ menuItemId: itemId, quantity: 1 }] },
    session,
    customer,
  });
  const orderId = order['orderId'] as string;
  if (!orderId) {
    console.error(`Could not place an order: ${JSON.stringify(order)}\n`);
    process.exit(2);
  }

  await call(`/orders/${orderId}/payment-intent`, { method: 'POST', customer });
  await call(`/dev/orders/${orderId}/simulate-payment`, { method: 'POST' });
  await sleep(5_000); // the dispatch sweep

  const staff = (
    await call('/auth/login', {
      method: 'POST',
      body: { email: 'spice.garden@example.com', password: 'kitchen-password-2026' },
    })
  )['token'] as string;

  await call(`/kds/orders/${orderId}/accept`, { method: 'POST', staff });
  await call(`/kds/orders/${orderId}/ready`, { method: 'POST', staff });

  console.log('\n  order is READY — watching the notification table for 20 seconds');
  await sleep(20_000);

  const { rows } = await pool.query<{ event_key: string; tier: string; status: string }>(
    `SELECT event_key, tier, status FROM notification WHERE order_id = $1 ORDER BY event_key, id`,
    [orderId],
  );

  console.log('');
  for (const r of rows) console.log(`        ${r.event_key.padEnd(16)} ${r.tier.padEnd(10)} ${r.status}`);
  console.log('');

  const delivered = (key: string): number =>
    rows.filter((r) => r.event_key === key && (r.status === 'SENT' || r.status === 'DELIVERED'))
      .length;

  const ready = delivered('order.ready');
  if (ready === 1) pass('exactly one tier delivered order.ready');
  else fail('exactly one tier delivered order.ready', `${ready} tiers reported delivery`);

  const confirmed = delivered('order.confirmed');
  if (confirmed === 1) pass('exactly one tier delivered order.confirmed');
  else fail('exactly one tier delivered order.confirmed', `${confirmed} tiers reported delivery`);

  // The other half of the promise. A ladder that stops early must not stop
  // early by going quiet — an unavailable tier still owes a row saying why, or
  // "nobody was told" becomes indistinguishable from "nothing needed sending".
  const skipped = rows.filter((r) => r.status === 'SKIPPED').length;
  if (skipped >= 2) pass(`unavailable tiers still record why they skipped (${skipped} rows)`);
  else fail('unavailable tiers still record why they skipped', `only ${skipped} SKIPPED rows`);

  await pool.end();

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('The customer was told once.\n');
}

void main().catch(async (e: unknown) => {
  await pool.end().catch(() => undefined);
  console.error(`\ntest-notify could not run: ${(e as Error).message}`);
  console.error('Are the API and the worker both up?  npm run dev:all\n');
  process.exit(2);
});
