/**
 * ============================================================================
 * THE SERVICE WORKER MUST NEVER CACHE AN ORDER, A PAYMENT, OR A CREDENTIAL
 * ============================================================================
 *
 * `docs/tech/frontend.md` states the rule this enforces:
 *
 *     Offline — shell + menu cache only. Ordering requires connectivity.
 *               NEVER queue an order client-side.
 *
 * WHY THIS NEEDS A CHECK RATHER THAN A COMMENT
 *
 * Because of how it would fail. Nothing throws. The build succeeds, every test
 * passes, and the app is faster — a cached order status renders instantly.
 * Then somebody collects food against a `READY` that was true four minutes ago,
 * or a customer sees `PAYMENT_PENDING` for an order that has already been
 * refunded, and the screen is confidently, persistently wrong with no error
 * anywhere. A stale cache does not look like a bug; it looks like the product.
 *
 * And it is one line to introduce. A `urlPattern` of `/\/api\//` is the
 * obvious thing to write when someone wants "the API cached for offline", and
 * it silently swallows orders, payments and OTPs along with the menu.
 *
 * WHAT IT DOES
 *
 * Extracts every `urlPattern` regex from the real Workbox config and runs it
 * against URLs that must never be cached. This tests the patterns themselves
 * rather than a list of names, so a pattern that is broader than its author
 * intended is caught by what it MATCHES, not by how it reads.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = 'apps/pwa/vite.config.ts';

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/**
 * Every `urlPattern: /.../` in the config, as live RegExp objects.
 *
 * Parsed out of the source rather than imported, because importing the config
 * means running Vite's plugin pipeline in a plain node process — and a check
 * that needs a build to run is a check that gets skipped.
 */
function urlPatterns(src) {
  const out = [];

  for (const m of src.matchAll(/urlPattern:\s*\//g)) {
    /*
     * Scanned rather than matched, because a `/` inside a character class does
     * not end a regex literal.
     *
     * The first version of this used one pattern to find the whole literal, and
     * `[^/]+` — which appears in every route here, matching a single path
     * segment — cut it short at the slash inside the brackets. That produced
     * `/\/api\/v1\/vendors\/[^/` and a thrown SyntaxError, which at least
     * failed loudly. The same class of bug that returns a SHORTER but still
     * valid regex would have silently tested the wrong thing.
     */
    let i = m.index + m[0].length;
    let body = '';
    let inClass = false;

    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\\') {
        body += ch + src[++i];
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      else if (ch === '\n') throw new Error(`unterminated regex literal near: ${body}`);
      body += ch;
    }

    const flags = /^[gimsuy]*/.exec(src.slice(i + 1))[0];
    out.push(new RegExp(body, flags));
  }

  return out;
}

/**
 * Requests that must reach the network every single time.
 *
 * Written as the URLs the client actually builds — see `apps/pwa/src/lib/api.ts`.
 * A pattern matching any of these is a defect regardless of which handler it
 * would have used: even `NetworkFirst` serves the cache when the network is
 * slow, which is exactly when an order's state is changing.
 */
const MUST_NEVER_CACHE = [
  ['/api/v1/orders', 'placing an order'],
  ['/api/v1/orders/ord_123', 'an order and its live status'],
  ['/api/v1/orders/ord_123/payment', 'a payment record'],
  ['/api/v1/orders/ord_123/payment-intent', 'opening a payment'],
  ['/api/v1/sessions/sess_9/orders', "this session's orders"],
  ['/api/v1/checkout/validate', 'the authoritative re-price before payment'],
  ['/api/v1/auth/otp/request', 'an OTP request'],
  ['/api/v1/auth/otp/verify', 'an OTP verification'],
  ['/api/v1/qr/AbCdEfGhIjKlMnOpQrStUv', 'the scan that opens a session'],
  ['/api/v1/stock-watch', 'restock subscriptions'],
  ['/api/v1/food-courts/fc_1/search?q=momo', 'a live search'],
];

/**
 * ...and the ones that SHOULD be cached.
 *
 * The control for the check above. Patterns that match nothing would pass every
 * forbidden-URL assertion perfectly while caching nothing at all — the offline
 * feature silently absent, and this file reporting all clear.
 */
const MUST_CACHE = [
  ['/api/v1/food-courts/fc_1/vendors', 'the stall list'],
  ['/api/v1/vendors/vnd_1/menu', 'a menu'],
  ['https://res.cloudinary.com/demo/image/upload/w_400/dish.jpg', 'a menu photograph'],
];

const src = readFileSync(resolve(root, CONFIG), 'utf8');
const patterns = urlPatterns(src);

console.log('\nservice worker cache policy — shell and menu, never an order');
console.log('─'.repeat(78));

check(
  `found the Workbox runtime routes (${patterns.length})`,
  patterns.length > 0,
  `No \`urlPattern:\` found in ${CONFIG}. Either the service worker config was\n        removed, or this parser has stopped matching it — both mean the\n        assertions below are proving nothing.`,
);

for (const [url, what] of MUST_NEVER_CACHE) {
  const hit = patterns.find((re) => re.test(url));
  check(
    `never cached — ${what}`,
    !hit,
    hit
      ? `${url}\n        is matched by ${hit}\n        Workbox caches whatever a route matches. Narrow the pattern; do not add\n        an exclusion beside it — see the note in ${CONFIG}.`
      : undefined,
  );
}

for (const [url, what] of MUST_CACHE) {
  check(
    `cached — ${what}`,
    patterns.some((re) => re.test(url)),
    `${url}\n        matches no runtime route, so it is never available offline. The\n        patterns may be right about what to exclude and wrong about what to\n        include, which reads as a pass everywhere else in this file.`,
  );
}

console.log('\nno order ever waits on the client');
console.log('─'.repeat(78));

/*
 * Background Sync is the mechanism that would make a queued order possible: it
 * holds a failed POST in IndexedDB and replays it when connectivity returns.
 * For this product that means a kitchen ticket appearing minutes after the
 * customer gave up and left. The rule is not "configure it carefully" — it is
 * that it must not be here at all.
 */
const sync = /BackgroundSync|backgroundSync|new\s+Queue\(/.test(src);
check(
  'no Background Sync / replay queue',
  !sync,
  `${CONFIG} references a background sync queue. An order that arrives after the\n        customer has left is worse than an order that failed while they were\n        looking at the screen — frontend.md: never queue an order client-side.`,
);

const devOff = /devOptions:\s*\{\s*enabled:\s*false/.test(src);
check(
  'the worker is off in development',
  devOff,
  `A service worker in dev serves the previous bundle from disk, so a stale tab\n        survives both a reload and a server restart. See the STARTED_AT note in\n        ${CONFIG}.`,
);

const denylisted = /navigateFallbackDenylist:[^\]]*\\\/api\\\//.test(src);
check(
  'the navigation fallback excludes /api',
  denylisted,
  'Without the denylist an API request that misses can be answered with the\n        index.html shell — the client then parses HTML as JSON and reports a\n        malformed response instead of an outage.',
);

// ============================================================================
// Negative control — the check must be able to fail
// ============================================================================
console.log('\nnegative control');
console.log('─'.repeat(78));

/*
 * The single most plausible mistake: someone wants "the API available offline"
 * and writes the pattern that says exactly that. If this file cannot catch that
 * line, it cannot catch anything, and every `ok` above is decoration.
 */
const sabotaged = src.replace(
  /urlPattern:\s*\/[^\n]*\/[gimsuy]*,/,
  'urlPattern: /\\/api\\/v1\\//,',
);
const sabotagedPatterns = urlPatterns(sabotaged);
const caught = MUST_NEVER_CACHE.filter(([url]) => sabotagedPatterns.some((re) => re.test(url)));

check(
  `a blanket /api/v1/ rule is caught (${caught.length} of ${MUST_NEVER_CACHE.length} URLs)`,
  caught.length > 0,
  'With a pattern that caches the entire API, every forbidden URL still passed.\n        The extraction or the assertions above are not doing anything.',
);

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
