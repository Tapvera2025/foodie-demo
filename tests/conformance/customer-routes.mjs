/**
 * ============================================================================
 * A SCREEN THAT CALLS A CUSTOMER-GUARDED ENDPOINT MUST SIT ON A GUARDED ROUTE
 * ============================================================================
 *
 * The bug: with an item in the cart but no verification, tapping the cart bar
 * went to `/checkout`, which asked the server to price the basket, got back
 * 401 `TOKEN_INVALID`, and rendered a generic failure card —
 *
 *     Something went wrong
 *     Verify your mobile number to continue.
 *     [ Try again ]
 *
 * — where "Try again" repeats the same unauthenticated request and fails
 * identically, for ever. The one sentence naming the real problem was sitting
 * inside an error box next to a button that could not act on it.
 *
 * The old gate was a `navigate('/verify')` inside `Menu.addToCart`. That covers
 * the first tap and nothing else: back out of the verify screen and the cart
 * still holds the dish — deliberately, the cart is meant to survive
 * authentication — so every later route into checkout was unguarded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SWEEP RATHER THAN A RULE ABOUT ONE FILE
 * ---------------------------------------------------------------------------
 *
 * Asserting "`/checkout` is wrapped" would pin the bug that was reported and
 * nothing near it. The actual invariant is a relation between three files that
 * are edited by different people at different times:
 *
 *     server controller  --@UseGuards(CustomerGuard)-->  needs a token
 *     lib/api.ts         --api.foo() calls that path-->  which method
 *     screens/*.tsx      --calls api.foo()------------>  which screen
 *     main.tsx           --route -> element----------->  is it wrapped?
 *
 * So the check walks that relation. Add a guard to a controller and the screens
 * that call it are covered automatically; add a screen that calls an existing
 * guarded endpoint and it is covered the moment it is written. Neither requires
 * anybody to have read this file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

let checked = 0;
let failures = 0;

console.log('\ncustomer routes — a token-requiring screen sits behind the gate');
console.log('─'.repeat(78));

/*
 * ---------------------------------------------------------------------------
 * 1. WHICH SERVER ROUTES DEMAND A VERIFIED CUSTOMER
 * ---------------------------------------------------------------------------
 * LINE BY LINE, NOT ONE BIG REGEX.
 *
 * The regex version of this returned zero matches and the two sanity checks
 * below are the only reason that was visible — "every screen is behind the
 * gate" passed cleanly against an empty set of guarded routes. A decorator
 * block is a sequence of lines with an arbitrary number of them, some wrapped
 * across several lines, and expressing "the decorators attached to THIS method"
 * as a single pattern is how you get a check that quietly tests nothing.
 *
 * So: walk the decorators, remember the last HTTP verb seen, and settle the
 * question when the method signature arrives.
 */
const guarded = [];
for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const controller = /@Controller\('([^']*)'\)/.exec(src)?.[1] ?? '';

  let path = null;
  let hasGuard = false;
  let pending = '';

  for (const raw of src.split('\n')) {
    const line = raw.trim();

    if (pending || line.startsWith('@')) {
      pending += line;
      // A decorator can wrap: `@UseGuards(\n  SessionGuard,\n  CustomerGuard,\n)`.
      const open = (pending.match(/\(/g) ?? []).length;
      const close = (pending.match(/\)/g) ?? []).length;
      if (open > close) continue;

      const verb = /^@(?:Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/.exec(pending);
      if (verb) {
        path = verb[1] ?? '';
        hasGuard = false;
      } else if (/^@UseGuards\(.*\bCustomerGuard\b/.test(pending)) {
        hasGuard = true;
      }
      pending = '';
      continue;
    }

    // A non-decorator, non-blank line ends the block: this is the method.
    if (line !== '' && path !== null) {
      if (hasGuard) {
        guarded.push(`/${[controller, path].filter(Boolean).join('/')}`.replace(/\/+/g, '/'));
      }
      path = null;
      hasGuard = false;
    }
  }
}

checked++;
if (guarded.length === 0) {
  failures++;
  console.log('  FAIL  found no CustomerGuard routes at all — the parser is broken,');
  console.log('        and every assertion below would pass for the wrong reason');
} else {
  console.log(`  ok    ${guarded.length} server routes require a verified customer`);
}

/** `/api/v1/orders/:orderId` -> a regex that also matches `/orders/${orderId}`. */
function pathMatcher(serverPath) {
  const tail = serverPath.replace(/^\/api\/v\d+/, '');
  const body = tail
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^/${body}$`);
}
const matchers = guarded.map(pathMatcher);

/*
 * ---------------------------------------------------------------------------
 * 2. WHICH api.ts METHODS CALL THEM
 * ---------------------------------------------------------------------------
 */
/*
 * SLICE THE OBJECT INTO PROPERTIES FIRST, THEN LOOK INSIDE EACH ONE.
 *
 * The first attempt was one regex that found a `request<...>('path')` and
 * scanned backwards for a name. It reported `method` as an API method — picked
 * out of the `{ method: 'POST' }` in a fetch init — and matched only three of
 * the seven guarded routes, because a lazy `[\s\S]{0,400}?` will happily run
 * across an entry boundary and pair a name with somebody else's path.
 *
 * The api object's members are at exactly two-space indentation, so cutting on
 * that boundary gives each method its own text and the question becomes local:
 * does THIS property's body call a guarded path.
 */
const apiSrc = readFileSync(join(root, 'apps/pwa/src/lib/api.ts'), 'utf8');
const needsToken = new Set();

const propStarts = [...apiSrc.matchAll(/^ {2}(\w+):/gm)];
for (let i = 0; i < propStarts.length; i++) {
  const name = propStarts[i][1];
  const body = apiSrc.slice(
    propStarts[i].index,
    i + 1 < propStarts.length ? propStarts[i + 1].index : apiSrc.length,
  );

  for (const call of body.matchAll(/request<[\s\S]*?>\(\s*[`'"]([^`'"]*)[`'"]/g)) {
    // `${orderId}` in a template literal stands where `:orderId` does on the server.
    const normalised = call[1].replace(/\$\{[^}]*\}/g, 'X');
    if (matchers.some((re) => re.test(normalised))) needsToken.add(name);
  }
}

/*
 * A floor, so this fails loudly if the slicing above regresses to matching
 * almost nothing — not an exact number, which would need an edit here every
 * time an endpoint is added.
 *
 * IT USED TO BE THE CONSTANT 5, AND THAT WAS COUPLED TO SOMETHING INVISIBLE
 *
 * The 5 was calibrated against "seven guarded routes exist", written in a
 * comment and enforced nowhere. When `ORDER_IDENTITY_MODE=counter` moved four
 * of those seven onto `OrderIdentityGuard` — deliberately, so an islanded
 * court can take an order without an OTP — three were left, the client still
 * reached every one of them, and this check failed reporting that "the api.ts
 * parser is dropping methods".
 *
 * The parser was fine. The check was measuring the guarded route COUNT while
 * claiming to measure parser health, and it pointed the person reading it at
 * the wrong file entirely. Derived from `guarded` now, so it scales with
 * whatever the guard set happens to be and only fails when the client really
 * has stopped reaching it.
 */
checked++;
const floor = Math.max(2, Math.ceil(guarded.length * 0.6));
const enough = needsToken.size >= floor;
if (!enough) failures++;
console.log(
  `  ${enough ? 'ok  ' : 'FAIL'}  ${needsToken.size} api methods hit one of the ${guarded.length}` +
    ` guarded routes: ${[...needsToken].sort().join(', ')}` +
    (enough
      ? ''
      : `\n        too few — expected at least ${floor} of ${guarded.length} guarded routes to be` +
        '\n        reached from api.ts. The parser is dropping methods.'),
);

checked++;
const clean = !needsToken.has('method') && !needsToken.has('body') && !needsToken.has('headers');
if (!clean) failures++;
console.log(
  `  ${clean ? 'ok  ' : 'FAIL'}  no fetch-init keys mistaken for api methods`,
);

/*
 * ---------------------------------------------------------------------------
 * 3. WHICH SCREENS CALL THOSE METHODS
 * ---------------------------------------------------------------------------
 */
/*
 * THERE ARE TWO CORRECT ANSWERS, NOT ONE.
 *
 * The first version of this flagged `/court` and `/vendor/:vendorId`, and it
 * was wrong to. Both screens call `api.sessionOrders` — the little dot on the
 * profile button showing you have an order running — and both must stay
 * reachable without a token, because browsing the court is the thing you do
 * BEFORE verifying. Wrapping them would put an OTP form in front of the menu.
 *
 * What makes them safe is that the call is conditional:
 *
 *     enabled: Boolean(sessionId) && signedIn
 *
 * The request is never made without a token, so there is no 401 and no dead
 * error card. That is a different mechanism from the route gate and an equally
 * valid one, and a check that only knows about the gate would push somebody
 * into "fixing" a screen that is already correct — which is worse than no
 * check, because it spends trust.
 *
 * So a guarded call is acceptable when EITHER the route is wrapped, OR the call
 * sits inside a hook whose options mention `signedIn`.
 */
const screensDir = join(root, 'apps/pwa/src/screens');
const screenNeeds = new Map();

/** The `useQuery({...})` / `useMutation({...})` blocks in a file, brace-matched. */
function hookBlocks(src) {
  const blocks = [];
  for (const m of src.matchAll(/use(?:Query|Mutation)\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(m.index, i + 1));
  }
  return blocks;
}

/**
 * Every `api.<method>(` in this file is inside a hook gated on `signedIn`.
 *
 * Conservative on purpose: a call anywhere else — a bare effect, a handler, a
 * helper — counts as ungated, because this cannot see what guards it and
 * guessing in the permissive direction is how the original bug shipped.
 */
function everyCallGated(src, method) {
  const call = new RegExp(`\\bapi\\.${method}\\s*\\(`, 'g');
  const total = [...src.matchAll(call)].length;
  if (total === 0) return true;

  const gated = hookBlocks(src)
    .filter((b) => /signedIn|isSignedIn/.test(b))
    .reduce((n, b) => n + [...b.matchAll(call)].length, 0);

  return gated === total;
}

for (const file of walk(screensDir)) {
  const src = readFileSync(file, 'utf8');
  const used = [...needsToken].filter(
    (m) => new RegExp(`\\bapi\\.${m}\\s*\\(`).test(src) && !everyCallGated(src, m),
  );
  if (used.length > 0) {
    screenNeeds.set(file.split('/').pop().replace(/\.tsx?$/, ''), used);
  }
}

/*
 * ---------------------------------------------------------------------------
 * 4. THE ROUTE TABLE
 * ---------------------------------------------------------------------------
 * Each `{ path: '...', element: <X /> }` entry, and whether `RequireVerified`
 * appears inside that entry's element.
 */
const mainSrc = readFileSync(join(root, 'apps/pwa/src/main.tsx'), 'utf8');

function parseRoutes(src) {
  const routes = [];
  for (const m of src.matchAll(/path:\s*'([^']*)'\s*,\s*element:\s*\(?([\s\S]*?)\)?\s*,?\s*\}/g)) {
    const [, path, element] = m;
    const components = [...element.matchAll(/<([A-Z]\w*)\s*\/?>/g)].map((c) => c[1]);
    routes.push({
      path,
      components: components.filter((c) => c !== 'RequireVerified'),
      wrapped: /RequireVerified/.test(element),
    });
  }
  return routes;
}

const routes = parseRoutes(mainSrc);

checked++;
if (routes.length < 5) {
  failures++;
  console.log(`  FAIL  parsed only ${routes.length} routes — the route-table parser is broken`);
} else {
  console.log(`  ok    parsed ${routes.length} routes from main.tsx`);
}

/*
 * ---------------------------------------------------------------------------
 * 5. THE ASSERTION
 * ---------------------------------------------------------------------------
 */
function unguarded(routeList, needs) {
  const bad = [];
  for (const r of routeList) {
    if (r.wrapped) continue;
    for (const c of r.components) {
      const used = needs.get(c);
      if (used) bad.push({ path: r.path, screen: c, calls: used });
    }
  }
  return bad;
}

const bad = unguarded(routes, screenNeeds);
checked++;
if (bad.length > 0) {
  failures++;
  for (const b of bad) {
    console.log(`  FAIL  ${b.path} renders <${b.screen} /> outside RequireVerified`);
    console.log(`        it calls api.${b.calls.join(', api.')} — all of which 401 without a token,`);
    console.log(`        so an unverified customer gets a dead error card instead of the OTP screen`);
  }
} else {
  console.log(`  ok    every screen that needs a token is behind RequireVerified`);
  for (const [screen, calls] of [...screenNeeds].sort()) {
    const r = routes.find((x) => x.components.includes(screen));
    console.log(`          ${(r?.path ?? '?').padEnd(18)} <${screen}>  ${calls.length} guarded call(s)`);
  }
}

/*
 * The verify screen itself must NOT be behind the gate. Obvious, and exactly
 * the kind of obvious thing a broad "wrap everything" fix breaks — the customer
 * would be redirected to a screen that redirects them to itself.
 */
checked++;
const verifyRoute = routes.find((r) => r.path === '/verify');
const verifyOpen = verifyRoute !== undefined && !verifyRoute.wrapped;
if (!verifyOpen) failures++;
console.log(
  `  ${verifyOpen ? 'ok  ' : 'FAIL'}  /verify is reachable without a token — no redirect loop`,
);

/*
 * ---------------------------------------------------------------------------
 * THE CONTROL
 * ---------------------------------------------------------------------------
 * Everything above passes when the parsers return nothing, so prove the
 * assertion fires on a route table that contains the bug that was reported.
 */
{
  checked++;
  const seeded = parseRoutes(`
    { path: '/court', element: <Vendors /> },
    { path: '/checkout', element: <Checkout /> },
    { path: '/orders', element: (<RequireVerified><Orders /></RequireVerified>) },
  `);
  // `Vendors` is absent from the needs map exactly as the real one is: its call
  // is gated, so it never becomes a requirement in the first place.
  const needs = new Map([
    ['Checkout', ['quote']],
    ['Orders', ['sessionOrders']],
  ]);
  const found = unguarded(seeded, needs);
  const routesOk =
    seeded.length === 3 &&
    found.length === 1 &&
    found[0].path === '/checkout' &&
    found[0].screen === 'Checkout';

  /* And the gating detector itself, which is what spared `/court`. */
  const gated = `
    const mine = useQuery({
      queryFn: () => api.sessionOrders(sessionId),
      enabled: Boolean(sessionId) && signedIn,
    });`;
  const ungatedSrc = `
    const mine = useQuery({
      queryFn: () => api.sessionOrders(sessionId),
      enabled: Boolean(sessionId),
    });`;
  const halfGated = gated + ungatedSrc;

  const gateOk =
    everyCallGated(gated, 'sessionOrders') === true &&
    everyCallGated(ungatedSrc, 'sessionOrders') === false &&
    everyCallGated(halfGated, 'sessionOrders') === false &&
    everyCallGated('const x = 1;', 'sessionOrders') === true;

  const ok = routesOk && gateOk;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  flags the unwrapped /checkout, clears the wrapped ` +
      `/orders${routesOk ? '' : ' [ROUTES]'}${gateOk ? '' : ' [GATING]'}`,
  );
  console.log(
    `  ${gateOk ? 'ok  ' : 'FAIL'}  control  a signedIn-gated call passes, an ungated one fails, ` +
      `one of each fails`,
  );
  checked++;
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
