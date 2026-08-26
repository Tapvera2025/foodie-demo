/**
 * ============================================================================
 * A SOCKET HEARS ITS OWN EVENTS AND NOBODY ELSE'S — PROVED, NOT ASSERTED
 * ============================================================================
 *
 * This is the one part of the realtime layer where being wrong is a privacy
 * breach rather than a slow screen: a customer receiving another customer's
 * order events, or a stall receiving another stall's tickets.
 *
 * Every other check in this suite reads source. That is not good enough here.
 * "The code says `socket.join(roomsFor(principal))`" does not establish that
 * Socket.IO delivers to those rooms and only those — that is a claim about a
 * library's behaviour, and the only way to know it is to run it.
 *
 * So this boots a REAL Socket.IO server on a real port, connects REAL clients
 * over TCP, broadcasts, and asserts who received what. `socket.io` and
 * `socket.io-client` are already dependencies, and neither has a native
 * binary, so this runs anywhere plain node does.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS REPRODUCED AND WHAT IS NOT
 * ----------------------------------------------------------------------------
 *
 * The gateway's handshake — verifying a JWT, checking `token_version` against
 * the database — is NOT reproduced. It needs keys and a database, and it is
 * the part that already shares an implementation with the HTTP guards
 * (`verifyToken`, the same `customer.token_version` lookup), which their own
 * tests cover.
 *
 * What is reproduced is the part with no other test: `roomsFor` deciding a
 * principal's rooms, and Socket.IO honouring them. The handshake is stubbed to
 * return a principal directly, so a failure here is unambiguously a routing
 * failure rather than an auth one.
 *
 * Run: node tests/conformance/realtime-rooms.mjs
 */

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/*
 * A transcription of `src/realtime/rooms.ts`, and the ONE place this file
 * cheats — it cannot import a `.ts` module without a loader.
 *
 * A copy under test is normally worthless: it proves the copy works. Here it
 * is acceptable for a specific reason — what is being tested is Socket.IO's
 * delivery given a room assignment, not the assignment itself. To stop the
 * copy drifting into a lie anyway, the last check in this file reads the real
 * module's source and asserts the room shapes still match these.
 */
const customerRoom = (id) => `customer:${id}`;
const vendorRoom = (id) => `vendor:${id}`;
const courtRoom = (id) => `court:${id}`;

function roomsFor(p) {
  if (p.kind === 'customer') return [customerRoom(p.customerId)];
  const rooms = new Set();
  for (const v of p.vendorIds) rooms.add(vendorRoom(v));
  for (const c of p.courtIds) rooms.add(courtRoom(c));
  return [...rooms];
}

const ORDER_CHANGED = 'order.changed';

console.log('\nrealtime rooms — a real server, real clients, real delivery');
console.log('─'.repeat(78));

const http = createServer();
const server = new Server(http, { path: '/realtime' });

/*
 * The gateway's connection handling, minus the token verification. Rooms come
 * from the handshake payload and NOT from any later message — which is the
 * property being demonstrated: there is no `subscribe` handler to abuse.
 */
server.use((socket, next) => {
  const p = socket.handshake.auth?.principal;
  if (!p) return next(new Error('unauthorised'));
  socket.data.principal = p;
  next();
});

server.on('connection', (socket) => {
  for (const room of roomsFor(socket.data.principal)) void socket.join(room);
});

const port = await new Promise((resolve) => {
  http.listen(0, () => resolve(http.address().port));
});

const url = `http://127.0.0.1:${port}`;
const clients = [];

function client(principal) {
  const c = connect(url, {
    path: '/realtime',
    auth: { principal },
    transports: ['websocket'],
    reconnection: false,
  });
  c.received = [];
  c.on(ORDER_CHANGED, (p) => c.received.push(p));
  clients.push(c);
  return c;
}

const alice = client({ kind: 'customer', customerId: 'cust-alice' });
const bob = client({ kind: 'customer', customerId: 'cust-bob' });
const tandoor = client({ kind: 'staff', vendorIds: ['v-tandoor'], courtIds: [] });
const dosa = client({ kind: 'staff', vendorIds: ['v-dosa'], courtIds: [] });
const console_ = client({ kind: 'staff', vendorIds: [], courtIds: ['fc-xyz'] });

await Promise.all(
  clients.map(
    (c) =>
      new Promise((resolve, reject) => {
        c.on('connect', resolve);
        c.on('connect_error', reject);
      }),
  ),
);

/*
 * Alice orders from Tandoor. This is exactly what `publishOrderChanged` sends:
 * the vendor room, the customer room, the court room.
 */
server
  .to([vendorRoom('v-tandoor'), customerRoom('cust-alice'), courtRoom('fc-xyz')])
  .emit(ORDER_CHANGED, { orderId: 'o-1', vendorId: 'v-tandoor' });

// Delivery is asynchronous over a real socket. Not a race: this is one event
// over loopback, and 150ms is three orders of magnitude of headroom.
await new Promise((r) => setTimeout(r, 150));

check('the customer who placed it is told', alice.received.length === 1, JSON.stringify(alice.received));
check(
  'the stall making it is told',
  tandoor.received.length === 1,
  JSON.stringify(tandoor.received),
);
check("the court's console is told", console_.received.length === 1, JSON.stringify(console_.received));

/* ------------------------------------------------------ what must NOT happen */

check(
  'ANOTHER CUSTOMER HEARS NOTHING',
  bob.received.length === 0,
  `bob received ${JSON.stringify(bob.received)} — a customer receiving another ` +
    `customer's order events is a privacy breach, not a bug in a screen`,
);

check(
  'ANOTHER STALL HEARS NOTHING',
  dosa.received.length === 0,
  `the dosa stall received ${JSON.stringify(dosa.received)} — one stall must not ` +
    `see another's tickets`,
);

/* ------------------------------------------- a client cannot join what it likes */
{
  /*
   * The attack the design is meant to make impossible: a connected client
   * asking to be put in somebody else's room. There is no handler for it on
   * the server, so the message goes nowhere — this asserts that emitting it
   * changes nothing, which is what "no inbound path" means in practice.
   */
  bob.emit('join', customerRoom('cust-alice'));
  bob.emit('subscribe', { room: customerRoom('cust-alice') });
  await new Promise((r) => setTimeout(r, 100));

  server
    .to(customerRoom('cust-alice'))
    .emit(ORDER_CHANGED, { orderId: 'o-2', vendorId: 'v-tandoor' });
  await new Promise((r) => setTimeout(r, 150));

  check(
    'a client asking to join another customer\'s room is ignored',
    bob.received.length === 0,
    `bob received ${JSON.stringify(bob.received)} after asking to join alice's room`,
  );
  check('and the rightful owner still receives it', alice.received.length === 2, JSON.stringify(alice.received));
}

/* ------------------------------------------------ multi-role staff, deduplicated */
{
  const both = client({ kind: 'staff', vendorIds: ['v-a', 'v-a'], courtIds: ['fc-1'] });
  await new Promise((resolve, reject) => {
    both.on('connect', resolve);
    both.on('connect_error', reject);
  });

  server.to([vendorRoom('v-a'), courtRoom('fc-1')]).emit(ORDER_CHANGED, { orderId: 'o-3', vendorId: 'v-a' });
  await new Promise((r) => setTimeout(r, 150));

  check(
    'a socket in two of the targeted rooms receives ONE copy, not two',
    both.received.length === 1,
    `received ${both.received.length} — a duplicated event makes a kitchen ` +
      `chime twice for one order`,
  );
}

/* --------------------------------------- the transcription above is still honest */
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve, join } = await import('node:path');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const real = readFileSync(join(root, 'src/realtime/rooms.ts'), 'utf8');

  const shapes = [
    ['customerRoom', 'customer:${customerId}'],
    ['vendorRoom', 'vendor:${vendorId}'],
    ['courtRoom', 'court:${courtId}'],
  ];
  const drifted = shapes.filter(([fn, shape]) => !real.includes(`${fn} = (`) || !real.includes(shape));

  check(
    'the room names copied into this file still match src/realtime/rooms.ts',
    drifted.length === 0,
    `${drifted.map(([f]) => f).join(', ')} no longer match. This file tests DELIVERY ` +
      `given a room assignment; if the real names changed, it is now testing names ` +
      `nothing uses and every check above is meaningless.`,
  );

  /*
   * COMMENTS STRIPPED FIRST, and this check is why the shared helper exists.
   *
   * Its first run FAILED — on the gateway's own sentence "there is no
   * `@SubscribeMessage`, no `socket.on('subscribe')`". The regex could not
   * tell a handler from a promise that there is no handler, which is the third
   * time that has happened in this suite. `_source.mjs` records all three.
   */
  const { stripComments, strippedReport } = await import('./_source.mjs');
  const gatewayRaw = readFileSync(join(root, 'src/realtime/realtime.gateway.ts'), 'utf8');
  const gateway = stripComments(gatewayRaw);
  const strip = strippedReport(gatewayRaw, gateway);

  check(
    'comments were really removed before scanning the gateway',
    strip.ok,
    `${strip.text} — without this the scan below is reading prose`,
  );

  check(
    'the real gateway still has no inbound message handler',
    !/@SubscribeMessage|socket\.on\(\s*['"](?!disconnect)/.test(gateway),
    'a handler for client messages reopens the "client names a room" hole this ' +
      'whole design exists to close',
  );
}

for (const c of clients) c.disconnect();
await new Promise((resolve) => server.close(() => resolve()));
http.close();

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
