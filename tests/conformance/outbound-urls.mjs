/**
 * ============================================================================
 * A URL WE HAND TO A THIRD PARTY MUST BE A ROUTE THAT EXISTS
 * ============================================================================
 *
 * The Cashfree provider told Cashfree to POST every payment event to
 *
 *     /api/v1/webhooks/cashfree
 *
 * which was invented to match the provider's name and does not exist. The real
 * route — provider-agnostic on purpose, so switching aggregator is a config
 * change rather than a new endpoint — is `/api/v1/webhooks/payments`.
 *
 * WHY THIS DESERVES A CHECK RATHER THAN A FIX
 *
 * Because of how it fails. Nothing throws. No test goes red. The customer pays
 * successfully on their phone, Cashfree POSTs to a 404, retries a few times,
 * gives up, and the order sits in PAYMENT_PENDING for ever. The kitchen never
 * sees it. The only signal is a 404 in an access log nobody reads, and the only
 * recovery is a polled status check that exists as a backstop rather than a
 * primary channel.
 *
 * A typo in a string literal, and the money moves while the order does not.
 * That is the exact shape of failure PRD §2.2 is about, so it gets a sweep.
 *
 * WHAT IT DOES
 *
 * Collects every `/api/...` path that appears in a string a provider sends
 * outward, collects every route the Nest controllers actually declare, and
 * asserts the first set is a subset of the second.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

// Shared, because a check that reads prose checks the wrong thing. See _source.mjs.
import { stripComments } from './_source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const files = walk(join(root, 'src'));

/*
 * ---------------------------------------------------------------------------
 * 1. EVERY ROUTE THE SERVER DECLARES
 * ---------------------------------------------------------------------------
 * Controller prefix + method path, normalised. Route parameters are collapsed
 * to `:x` so `/orders/:orderId` and `/orders/:id` compare equal — the check is
 * about a path EXISTING, not about parameter naming.
 */
const routes = new Set();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const prefix = /@Controller\('([^']*)'\)/.exec(src)?.[1] ?? '';
  for (const m of src.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*'([^']*)'\s*\)/g)) {
    routes.add(normalise(`/${[prefix, m[1]].filter(Boolean).join('/')}`));
  }
  // Bare `@Get()` / `@Post()` — the controller prefix IS the route.
  if (/@(?:Get|Post|Put|Patch|Delete)\(\s*\)/.test(src) && prefix) {
    routes.add(normalise(`/${prefix}`));
  }
}

function normalise(p) {
  return p
    .replace(/\/+/g, '/')
    .replace(/:[A-Za-z0-9_]+/g, ':x')
    .replace(/\{[^}]*\}/g, ':x')
    .replace(/\/$/, '');
}

console.log('\noutbound URLs — every path we hand out is a route we serve');
console.log('─'.repeat(78));

check(
  `parsed ${routes.size} declared routes`,
  routes.size > 20,
  `only ${routes.size} — the controller parser is broken, and every check below would pass vacuously`,
);

/*
 * ---------------------------------------------------------------------------
 * 2. EVERY PATH WE SEND OUTWARD
 * ---------------------------------------------------------------------------
 * A template literal interpolating a base URL and then naming an api path —
 * `${base}/api/v1/...` — is the shape of "tell someone else to call us".
 */
const outbound = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\$\{[^}]*(?:aseUrl|ASE_URL|baseUrl)[^}]*\}(\/api\/[^`'"$\s]*)/g)) {
    outbound.push({ path: normalise(m[1]), file: relative(root, file) });
  }
}

check(
  `found ${outbound.length} outbound api path${outbound.length === 1 ? '' : 's'}`,
  outbound.length > 0,
  'none found — the outbound parser is broken, so the real check below proves nothing',
);

/*
 * ---------------------------------------------------------------------------
 * 3. THE ASSERTION
 * ---------------------------------------------------------------------------
 */
{
  const missing = outbound.filter((o) => !routes.has(o.path));
  check(
    'every outbound path resolves to a declared route',
    missing.length === 0,
    missing
      .map(
        (m) =>
          `${m.path} (${m.file}) is not served.\n` +
          `        A third party told to call it gets a 404, and the failure is silent.`,
      )
      .join('\n        '),
  );

  for (const o of outbound) {
    console.log(`          ${o.path.padEnd(34)} <- ${o.file}`);
  }
}

/*
 * The control. This check passes trivially when either parser returns nothing,
 * and the two sanity assertions above only catch a TOTAL failure — so prove the
 * comparison itself rejects the exact path that caused this.
 */
{
  checked++;
  const fakeRoutes = new Set(['/api/v1/webhooks/payments', '/api/v1/orders/:x']);
  const cases = [
    { path: '/api/v1/webhooks/payments', want: true },
    { path: '/api/v1/webhooks/cashfree', want: false }, // the real bug
    { path: '/api/v1/orders/:x', want: true },
    { path: '/api/v1/orders', want: false },
  ];
  const wrong = cases.filter((c) => fakeRoutes.has(c.path) !== c.want);
  const ok = wrong.length === 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  accepts the real webhook path and rejects ` +
      `/api/v1/webhooks/cashfree${ok ? '' : ` — ${JSON.stringify(wrong)}`}`,
  );
}

/*
 * ============================================================================
 * `return_url` AND `notify_url` HAVE DIFFERENT FOLLOWERS AND MUST NOT SHARE A GATE
 * ============================================================================
 *
 * The bug: `order_meta` was emitted only when `publicBaseUrl` was set, so with
 * no tunnel configured an order was created with NEITHER url. Cashfree's v3
 * checkout refuses to render without `return_url`, so local payments failed
 * with "Something went wrong" against a session that was valid, ACTIVE and in
 * the right environment — all three confirmed before the real cause was found.
 *
 * It survived because the pairing looks tidy. Both are urls, both are Cashfree
 * config, both belong in `order_meta`. What differs is who dereferences them:
 * Cashfree fetches `notify_url` and needs a public hostname; the customer's own
 * browser follows `return_url` and does not. Coupling them imposed the harder
 * requirement on the easier one and cost the whole local payment flow.
 *
 * The check reads the emitting code rather than the config: what matters is
 * that `return_url` is not written inside a branch conditioned on the webhook
 * base url.
 */
{
  const provider = stripComments(
    readFileSync(join(root, 'src/payments/providers/cashfree.provider.ts'), 'utf8'),
  );

  const returnAt = provider.indexOf('return_url');
  const notifyAt = provider.indexOf('notify_url');

  checked++;
  const bothPresent = returnAt !== -1 && notifyAt !== -1;
  if (!bothPresent) failures++;
  console.log(
    `  ${bothPresent ? 'ok  ' : 'FAIL'}  both order_meta urls are still emitted` +
      (bothPresent ? '' : `  (return_url=${returnAt !== -1}, notify_url=${notifyAt !== -1})`),
  );

  /*
   * WHICH VARIABLE GOVERNS EACH FIELD, by looking at the code immediately
   * before it.
   *
   * The first version of this check tried to recognise the SHAPE of the old
   * conditional with a regex, and it did not catch the mutation — reverting
   * the provider to the exact broken form left this green. A check that cannot
   * fail against the bug it was written for is worse than none, so it was
   * replaced with a property that is simply true or false rather than a
   * pattern that has to be guessed correctly:
   *
   *     the code just before `return_url` mentions `returnBaseUrl` and does
   *     not mention `publicBaseUrl`, and vice versa for `notify_url`.
   *
   * THE WINDOW IS THE NEAREST ENCLOSING `if (`, capped at 240 characters.
   *
   * A flat 240 was the second thing that went wrong here: the window before
   * `notify_url` reached back over the `return_url` line above it, so it saw
   * BOTH variables and the check failed against correct code. Anchoring on the
   * nearest `if (` gives each field its own guard; the 240 cap is what keeps
   * the old form — which had no `if` at all — from reaching halfway up the
   * file and matching something irrelevant.
   */
  const before = (at) => provider.slice(Math.max(provider.lastIndexOf('if (', at), at - 240), at);
  const returnGuard = before(returnAt);
  const notifyGuard = before(notifyAt);

  checked++;
  const returnOk =
    returnGuard.includes('returnBaseUrl') && !returnGuard.includes('publicBaseUrl');
  if (!returnOk) failures++;
  console.log(
    `  ${returnOk ? 'ok  ' : 'FAIL'}  return_url is governed by returnBaseUrl, not publicBaseUrl` +
      (returnOk
        ? ''
        : `\n        \`publicBaseUrl\` is for the WEBHOOK and needs a public hostname.` +
          `\n        \`return_url\` is followed by the customer's browser and does not.` +
          `\n        Gating them together means no tunnel = no checkout at all, which is` +
          `\n        the bug this check exists for.`),
  );

  checked++;
  const notifyOk =
    notifyGuard.includes('publicBaseUrl') && !notifyGuard.includes('returnBaseUrl');
  if (!notifyOk) failures++;
  console.log(
    `  ${notifyOk ? 'ok  ' : 'FAIL'}  notify_url is governed by publicBaseUrl` +
      (notifyOk
        ? ''
        : `\n        Cashfree fetches this one server to server. A localhost notify_url is` +
          `\n        worse than none: it looks configured and silently never fires.`),
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
