/**
 * Asserts that the customer-facing API refuses what the PRD says it refuses.
 *
 * WHY THIS IS AN HTTP SCRIPT AND NOT A UNIT TEST
 *
 * The defects this file guards against were all of one kind: a rule stated in
 * the PRD, implemented in the client, and absent from the server. Unit tests
 * would have passed throughout — the pure logic was never wrong. Only a request
 * sent without a credential finds an endpoint that never asked for one.
 *
 * Same shape as `test-constraints.ts`, one level up the stack. Each case has a
 * violation that MUST be refused and, where a refusal alone would be
 * ambiguous, the adjacent legitimate act that MUST still succeed. A suite made
 * entirely of "this must be rejected" cannot tell you whether you have broken
 * the product — see errata E-006.
 *
 * What it covers:
 *
 *   - a second customer scanning the same poster gets their OWN session
 *   - a session is resumed only by presenting its signed token
 *   - an OTP cannot be attached to a session the caller was not issued
 *   - ordering requires a verified customer, server-side
 *   - a customer can read only their own orders and payments
 *   - cross-customer reads answer 404, never 403
 *
 * Needs the API running, and a seeded court:
 *
 *   npm run setup && npm run dev        # in one terminal
 *   npm run test:auth                   # in another
 */

const BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;

let failures = 0;
let checks = 0;

function pass(name: string): void {
  checks++;
  console.log(`  PASS  ${name}`);
}

function fail(name: string, detail: string): void {
  checks++;
  failures++;
  console.error(`  FAIL  ${name}\n        ${detail}`);
}

function expect(name: string, actual: unknown, wanted: unknown): void {
  if (actual === wanted) pass(name);
  else fail(name, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
}

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; session?: string; customer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.session) headers['X-Session-Token'] = opts.session;
  if (opts.customer) headers['Authorization'] = `Bearer ${opts.customer}`;
  if (opts.method === 'POST') headers['Idempotency-Key'] = `auth-test-${crypto.randomUUID()}`;

  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- fixtures
  const courts = await call('/dev/courts');
  const court = (courts.body['courts'] as { token: string }[] | undefined)?.[0];
  if (!court) {
    console.error('No court found. Run `npm run setup` first, and keep NODE_ENV=development.\n');
    process.exit(2);
  }

  const vendors = await call(`/qr/${court.token}`).then(async (scan) => {
    const fc = (scan.body['foodCourt'] as { id: string }).id;
    return call(`/food-courts/${fc}/vendors`);
  });
  const vendorId = (vendors.body['vendors'] as { id: string }[])[0]?.id;
  const menu = await call(`/vendors/${vendorId}/menu`);
  const categories = menu.body['categories'] as { items: { id: string }[] }[];
  const itemId = categories.flatMap((c) => c.items)[0]?.id;
  if (!vendorId || !itemId) {
    console.error('Seeded court has no orderable item. Run `npm run seed:dev`.\n');
    process.exit(2);
  }
  const lines = [{ menuItemId: itemId, quantity: 1 }];

  // ------------------------------------------------- sessions are per-client
  console.log('\nA session belongs to one client (PRD §2.1, §11.1)');

  const a = await call(`/qr/${court.token}`);
  const b = await call(`/qr/${court.token}`);
  const sessionA = a.body['sessionToken'] as string;
  const sessionB = b.body['sessionToken'] as string;
  const idA = a.body['sessionId'] as string;

  if (a.body['sessionId'] !== b.body['sessionId']) {
    pass('a second scan with no token opens its own session');
  } else {
    fail(
      'a second scan with no token opens its own session',
      'both scans returned the same session — every customer in the court is sharing one',
    );
  }

  const resumed = await call(`/qr/${court.token}`, { session: sessionA });
  expect('presenting the token resumes that session', resumed.body['sessionId'], idA);
  expect('  and reports that it resumed', resumed.body['resumed'], true);

  const forged = await call(`/qr/${court.token}`, { session: 'not.a.token' });
  if (forged.body['sessionId'] !== idA) pass('an unverifiable token resumes nothing');
  else fail('an unverifiable token resumes nothing', 'a junk token resumed a real session');

  // ------------------------------------------------------------- OTP binding
  console.log('\nAn OTP attaches only to the session that requested it (§11.2)');

  expect(
    'OTP request with no session token is refused',
    (await call('/auth/otp/request', { method: 'POST', body: { phone: '+919000000101' } })).status,
    401,
  );

  const phoneA = `+9190000${String(Math.floor(Math.random() * 90000) + 10000)}`;
  await call('/auth/otp/request', { method: 'POST', body: { phone: phoneA }, session: sessionA });
  const codeA = (await call('/auth/otp/dev/latest')).body['code'] as string;
  const verifiedA = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: phoneA, code: codeA, name: 'Test A' },
    session: sessionA,
  });
  const customerA = verifiedA.body['token'] as string;
  if (customerA) pass('a customer verifies on their own session');
  else fail('a customer verifies on their own session', JSON.stringify(verifiedA.body));

  // -------------------------------------------------------- ordering is gated
  console.log('\nOrdering requires a verified customer, server-side (DR-0001)');

  expect(
    'no customer token is refused',
    (await call('/orders', { method: 'POST', body: { vendorId, lines }, session: sessionA })).status,
    401,
  );
  expect(
    'no session token is refused',
    (await call('/orders', { method: 'POST', body: { vendorId, lines }, customer: customerA }))
      .status,
    401,
  );
  expect(
    'an unauthenticated price preview is refused',
    (await call('/checkout/validate', { method: 'POST', body: { vendorId, lines } })).status,
    401,
  );

  const placed = await call('/orders', {
    method: 'POST',
    body: { vendorId, lines },
    session: sessionA,
    customer: customerA,
  });
  const orderId = placed.body['orderId'] as string;
  if (orderId) pass('a fully credentialed order is accepted');
  else fail('a fully credentialed order is accepted', JSON.stringify(placed.body));

  // ------------------------------------------------------------- ownership
  console.log('\nA customer reads only their own orders (§16.3)');

  const phoneB = `+9190000${String(Math.floor(Math.random() * 90000) + 10000)}`;
  await call('/auth/otp/request', { method: 'POST', body: { phone: phoneB }, session: sessionB });
  const codeB = (await call('/auth/otp/dev/latest')).body['code'] as string;
  const customerB = (
    await call('/auth/otp/verify', {
      method: 'POST',
      body: { phone: phoneB, code: codeB, name: 'Test B' },
      session: sessionB,
    })
  ).body['token'] as string;

  expect(
    'the owner can read their order',
    (await call(`/orders/${orderId}`, { customer: customerA })).status,
    200,
  );
  expect(
    'another customer gets 404, not 403',
    (await call(`/orders/${orderId}`, { customer: customerB })).status,
    404,
  );
  expect(
    'an anonymous caller is refused',
    (await call(`/orders/${orderId}`)).status,
    401,
  );
  expect(
    "another customer's session listing is empty",
    (
      (await call(`/sessions/${idA}/orders`, { session: sessionB, customer: customerB })).body[
        'orders'
      ] as unknown[]
    ).length,
    0,
  );

  console.log('\nPayment routes carry the same ownership rule');
  expect(
    'another customer cannot open an intent',
    (await call(`/orders/${orderId}/payment-intent`, { method: 'POST', customer: customerB }))
      .status,
    404,
  );
  expect(
    'another customer cannot read the payment',
    (await call(`/orders/${orderId}/payment`, { customer: customerB })).status,
    404,
  );
  expect(
    'the owner can open their own intent',
    (await call(`/orders/${orderId}/payment-intent`, { method: 'POST', customer: customerA }))
      .status,
    201,
  );

  console.log('');
  if (failures > 0) {
    console.error(`${failures} of ${checks} checks failed.\n`);
    process.exit(1);
  }
  console.log(`All ${checks} authorisation checks passed.\n`);
}

void main().catch((e: unknown) => {
  console.error(`\ntest-auth could not run: ${(e as Error).message}`);
  console.error('Is the API up?  npm run dev  (or npm run dev:all)\n');
  process.exit(2);
});
