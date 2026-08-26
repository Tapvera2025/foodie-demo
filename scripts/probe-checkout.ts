/**
 * ============================================================================
 * WHICH FIELD IN OUR ORDER PAYLOAD BREAKS CASHFREE'S CHECKOUT PAGE?
 * ============================================================================
 *
 *   npm run probe:checkout
 *   then open http://localhost:5173/cf-probe.html
 *
 * WHY THIS EXISTS
 *
 * Three hypotheses have now been wrong — a spent session, a missing
 * `return_url`, a stale `x-api-version` — and each cost a round trip. The
 * browser console eventually gave the real error, and it is inside Cashfree's
 * own bundle:
 *
 *     TypeError: Cannot read properties of undefined (reading 'orderCurrency')
 *         at checkout/:99
 *
 * Their page maps over payment methods and reads `orderCurrency` off an object
 * that is undefined. Everything observable from the server says the order is
 * fine: ACTIVE, correct currency, 14 eligible payment methods, valid session,
 * matching environment, `return_url` present. So the fault is in how their
 * page builds its model from something we send — and no amount of reading our
 * own source will identify which field, because none of them is REJECTED.
 *
 * Guessing has been tried. This measures instead.
 *
 * ----------------------------------------------------------------------------
 * HOW
 * ----------------------------------------------------------------------------
 *
 * It creates one sandbox order per VARIATION, changing exactly one thing at a
 * time from what the application sends today, and writes a page with a button
 * per variation. Click each; the ones that render a payment list are fine, the
 * ones that show "Something went wrong" are not. The first difference between
 * a working and a failing variation is the field responsible.
 *
 * The page is written into `apps/pwa/public/` on purpose. Opening it from
 * `file://` would give the SDK a null origin, which is its own failure mode and
 * would confuse the result; served by the PWA's dev server it has exactly the
 * origin the real app has.
 *
 * SAFE: sandbox only, ₹1 per order, nothing is ever paid, and unpaid Cashfree
 * orders expire by themselves. It touches no database.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../src/platform/config.js';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const cfg = config();

if (cfg.CASHFREE_ENV === 'production') {
  process.stderr.write(`\n${RED}Refusing to run against production.${OFF}\n\n`);
  process.exit(1);
}

const BASE = 'https://sandbox.cashfree.com/pg';

interface Variation {
  readonly name: string;
  readonly why: string;
  readonly build: (id: string) => Record<string, unknown>;
}

/** A hyphen-free id, since every `customer_id` in Cashfree's docs is alphanumeric. */
const plain = (): string => `p${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/*
 * ORDERED FROM "EXACTLY WHAT WE SEND" TO "AS PLAIN AS POSSIBLE".
 *
 * If the first fails and the last works, bisecting the middle finds the field.
 * If ALL of them fail, the fault is not in the payload at all and the next
 * place to look is the account or the SDK invocation — which is worth knowing
 * just as much, because it would rule out this whole line of enquiry in one
 * run instead of three more.
 */
const VARIATIONS: Variation[] = [
  {
    name: 'baseline',
    why: 'byte for byte what the app sends today — the control',
    build: (id) => ({
      order_id: id,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: { customer_id: `order_${id}`, customer_phone: '9999999999' },
      order_meta: { return_url: 'http://localhost:5173/pay/{order_id}' },
    }),
  },
  {
    name: 'with-email-and-name',
    why: 'customer_email and customer_name are null on every order we create',
    build: (id) => ({
      order_id: id,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: {
        customer_id: `order_${id}`,
        customer_phone: '9999999999',
        customer_email: 'test@example.com',
        customer_name: 'Test Customer',
      },
      order_meta: { return_url: 'http://localhost:5173/pay/{order_id}' },
    }),
  },
  {
    name: 'alphanumeric-customer-id',
    why: 'ours is `order_<uuid>` and contains hyphens; every documented example is alphanumeric',
    build: (id) => ({
      order_id: id,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: { customer_id: plain(), customer_phone: '9999999999' },
      order_meta: { return_url: 'http://localhost:5173/pay/{order_id}' },
    }),
  },
  {
    name: 'https-return-url',
    why: 'ours is http on localhost; their page may require https',
    build: (id) => ({
      order_id: id,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: { customer_id: `order_${id}`, customer_phone: '9999999999' },
      order_meta: { return_url: 'https://example.com/pay/{order_id}' },
    }),
  },
  {
    name: 'no-order-meta',
    why: 'the state before return_url was added — proves whether it matters either way',
    build: (id) => ({
      order_id: id,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: { customer_id: `order_${id}`, customer_phone: '9999999999' },
    }),
  },
  {
    name: 'minimal-everything-plain',
    why: 'plain ids, real email, https — as close to their own examples as possible',
    build: () => {
      const oid = plain();
      return {
        order_id: oid,
        order_amount: 1.0,
        order_currency: 'INR',
        customer_details: {
          customer_id: plain(),
          customer_phone: '9999999999',
          customer_email: 'test@example.com',
          customer_name: 'Test Customer',
        },
        order_meta: { return_url: 'https://example.com/return?order_id={order_id}' },
      };
    },
  },
];

async function create(body: Record<string, unknown>): Promise<{
  sessionId: string | null;
  status: number;
  error: string;
}> {
  const res = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-version': cfg.CASHFREE_API_VERSION,
      'x-client-id': cfg.CASHFREE_APP_ID ?? '',
      'x-client-secret': cfg.CASHFREE_SECRET_KEY ?? '',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  const sessionId = json['payment_session_id'];
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    status: res.status,
    error: typeof sessionId === 'string' ? '' : text.slice(0, 200),
  };
}

async function main(): Promise<void> {
  process.stdout.write(
    `\n${BOLD}Minting one sandbox order per variation` +
      ` (api-version ${cfg.CASHFREE_API_VERSION})${OFF}\n\n`,
  );

  const results: { v: Variation; sessionId: string | null; note: string }[] = [];

  for (const v of VARIATIONS) {
    const id = `probe-${v.name}-${Date.now()}`;
    const r = await create(v.build(id));
    results.push({ v, sessionId: r.sessionId, note: r.error });
    process.stdout.write(
      `  ${r.sessionId ? `${GREEN}ok  ${OFF}` : `${RED}FAIL${OFF}`}  ${v.name.padEnd(28)}` +
        `${r.sessionId ? '' : ` HTTP ${r.status} ${r.error}`}\n`,
    );
  }

  const usable = results.filter((r) => r.sessionId);
  if (usable.length === 0) {
    process.stderr.write(`\n${RED}No order could be created at all.${OFF}\n\n`);
    process.exit(1);
  }

  /*
   * The page. Deliberately plain: one button per variation, the SDK loaded the
   * same way `apps/pwa/src/lib/cashfree.ts` loads it, and every console message
   * mirrored onto the page so the answer does not require DevTools to be open.
   */
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cashfree checkout probe</title>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 20px; }
  .row { border: 1px solid #ddd; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  .why { color: #666; font-size: 13px; margin: 4px 0 10px; }
  button { font: inherit; padding: 8px 16px; border-radius: 999px; border: 0;
           background: #cf3a32; color: #fff; cursor: pointer; }
  #log { white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace;
         background: #111; color: #ddd; padding: 12px; border-radius: 10px; margin-top: 20px; }
</style>
</head>
<body>
<h1>Cashfree checkout probe</h1>
<p>Click each in order. A variation that shows a payment list is <b>fine</b>;
one that shows “Something went wrong” is <b>not</b>. The first difference
between a working and a failing variation is the field responsible.</p>

${usable
  .map(
    (r) => `<div class="row">
  <b>${r.v.name}</b>
  <div class="why">${r.v.why}</div>
  <button onclick="go('${r.sessionId ?? ''}', '${r.v.name}')">Open checkout</button>
</div>`,
  )
  .join('\n')}

<div id="log">console output appears here</div>

<script>
  const logEl = document.getElementById('log');
  function say(s) { logEl.textContent += '\\n' + s; }

  // Mirror the console so the answer is visible without DevTools open.
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      say('[' + level + '] ' + args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
      }).join(' '));
    };
  }
  window.addEventListener('unhandledrejection', e => say('[unhandled] ' + (e.reason?.message ?? e.reason)));
  window.addEventListener('error', e => say('[error] ' + e.message));

  async function go(sessionId, name) {
    logEl.textContent = 'opening: ' + name;
    try {
      const cashfree = Cashfree({ mode: 'sandbox' });
      const result = await cashfree.checkout({
        paymentSessionId: sessionId,
        redirectTarget: '_modal',
      });
      say('checkout() resolved: ' + JSON.stringify(result));
    } catch (e) {
      say('checkout() threw: ' + (e && e.message ? e.message : String(e)));
    }
  }
</script>
</body>
</html>
`;

  const out = resolve(process.cwd(), 'apps/pwa/public/cf-probe.html');
  writeFileSync(out, html, 'utf8');

  process.stdout.write(
    `\n${BOLD}Wrote${OFF} apps/pwa/public/cf-probe.html\n\n` +
      `  Open ${BOLD}http://localhost:5173/cf-probe.html${OFF} and click through.\n\n` +
      `${DIM}  Served by the PWA dev server on purpose — opening it from file://\n` +
      `  gives the SDK a null origin, which fails for its own unrelated reason.${OFF}\n\n`,
  );
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
