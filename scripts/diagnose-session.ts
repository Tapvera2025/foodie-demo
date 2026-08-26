/**
 * ============================================================================
 * WHY DID CASHFREE'S CHECKOUT SAY "SOMETHING WENT WRONG"?
 * ============================================================================
 *
 *   npm run diagnose:session            # the most recent order
 *   npm run diagnose:session <orderId>  # a specific one
 *
 * THE SYMPTOM
 *
 *   Cashfree's modal opens and shows "Something went wrong / Share a
 *   screenshot with the seller to help fix it", with a Session ID.
 *
 * That screen is the JS SDK reporting that the `payment_session_id` it was
 * given is not one it can open a checkout with. It does NOT say why, and the
 * candidates have completely different fixes:
 *
 *   A. THE SESSION IS SPENT. Cashfree issues one session per ORDER, and once
 *      a payment attempt on that order reaches a terminal state the order is
 *      no longer ACTIVE and its session cannot be reopened. Our `createIntent`
 *      returns the STORED payload for any live payment row (PAY-REC-03), so
 *      after a completed or failed attempt every retry replays a dead session.
 *
 *   B. THE SESSION IS MANGLED. The value that reached the browser is not the
 *      value Cashfree issued. The screenshot that prompted this script showed
 *      an id ending `...paymentpayment`, and whether that doubled suffix is
 *      normal is not something this codebase can answer by reading itself —
 *      Cashfree defines the format.
 *
 *   C. THE ENVIRONMENTS DISAGREE. A session minted against production opened
 *      with `mode: 'sandbox'`, or the reverse.
 *
 * Reading source cannot separate these. Asking Cashfree can, so this does.
 *
 * ----------------------------------------------------------------------------
 * SAFE TO RUN
 * ----------------------------------------------------------------------------
 *
 * It refuses production. It reads one order from the database and writes
 * nothing. It creates one ₹1 sandbox order purely to see the SHAPE of a
 * freshly-issued session id, and never pays it — an unpaid Cashfree order
 * expires by itself and costs nothing.
 */

import { sql } from 'kysely';

/*
 * THROUGH `createPool`/`createDb`, NOT A HAND-BUILT Kysely.
 *
 * `platform/db.ts` registers a node-pg type parser for INT8 as an IMPORT SIDE
 * EFFECT, because Postgres returns BIGINT as a string and every monetary column
 * in this schema is BIGINT paise. A script that assembles its own Pool skips
 * that registration and gets `"19900"` where the application gets `19900`.
 *
 * That is not cosmetic. `paise()` refuses a non-number by design, so the first
 * money value a script touched threw `money must be a number, got 19900` — and
 * it read as a bug in the money it was reporting on rather than in the
 * reporting. A diagnostic that fails differently from the application is worse
 * than no diagnostic, which is the same lesson `diagnose-cashfree.ts` learned
 * when it hand-built the payment provider.
 */
import { createDb, createPool } from '../src/platform/db.js';
import { config } from '../src/platform/config.js';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

// Braced bodies: `process.stdout.write` returns a boolean, and a concise arrow
// would make these `() => boolean` against a `void` annotation.
const step = (s: string): void => {
  process.stdout.write(`\n${BOLD}==> ${s}${OFF}\n`);
};
const line = (s: string): void => {
  process.stdout.write(`    ${s}\n`);
};
const dim = (s: string): void => {
  process.stdout.write(`    ${DIM}${s}${OFF}\n`);
};

const cfg = config();

if (cfg.CASHFREE_ENV === 'production') {
  process.stderr.write(`\n${RED}Refusing to run against production.${OFF}\n\n`);
  process.exit(1);
}

const BASE = 'https://sandbox.cashfree.com/pg';

async function cf(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  apiVersion: string = cfg.CASHFREE_API_VERSION,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-version': apiVersion,
      'x-client-id': cfg.CASHFREE_APP_ID ?? '',
      'x-client-secret': cfg.CASHFREE_SECRET_KEY ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* some errors are not JSON */
  }
  return { status: res.status, json, text };
}

/** Enough of the id to compare shapes; never the whole thing in a log. */
function shape(id: string): string {
  return `${id.length} chars, ends "…${id.slice(-24)}"`;
}

async function main(): Promise<void> {
  const wanted = process.argv[2];

  const db = createDb(createPool({ connectionString: cfg.DATABASE_URL }));

  try {
    // -----------------------------------------------------------------------
    step('1. The order, and the session we stored for it');
    // -----------------------------------------------------------------------
    const row = await sql<{
      order_id: string;
      order_number: string;
      order_status: string;
      payment_status: string | null;
      payment_created: Date | null;
      expires_at: Date | null;
      checkout_payload: Record<string, unknown> | null;
    }>`
      SELECT o.id                       AS order_id,
             o.public_order_number      AS order_number,
             o.status::text             AS order_status,
             p.status::text             AS payment_status,
             p.created_at               AS payment_created,
             p.expires_at,
             p.checkout_payload
        FROM "order" o
        LEFT JOIN LATERAL (
          SELECT * FROM payment
           WHERE order_id = o.id
           ORDER BY created_at DESC
           LIMIT 1
        ) p ON TRUE
       WHERE ${wanted ? sql`o.id = ${wanted}` : sql`TRUE`}
       ORDER BY o.created_at DESC
       LIMIT 1
    `.execute(db);

    const o = row.rows[0];
    if (!o) {
      line(`${YELLOW}No such order.${OFF}`);
      return;
    }

    line(`order      ${o.order_number}  (${o.order_id})`);
    line(`status     ${o.order_status}`);
    line(`payment    ${o.payment_status ?? '(no payment row)'}`);
    if (o.payment_created) {
      const ageMin = Math.round((Date.now() - o.payment_created.getTime()) / 60000);
      line(`intent age ${ageMin} minutes`);
    }

    const stored = o.checkout_payload?.['paymentSessionId'];
    if (typeof stored !== 'string') {
      line(`${RED}No paymentSessionId stored.${OFF}`);
      dim('If `checkout_payload` is null the row predates migration 20, and');
      dim('`createIntent` fell back to `{provider, ref}` — which no SDK can open.');
      dim('Run: npm run migrate:up, then place a NEW order.');
      return;
    }
    line(`session    ${shape(stored)}`);

    // -----------------------------------------------------------------------
    step('2. What Cashfree says about that order RIGHT NOW');
    // -----------------------------------------------------------------------
    /*
     * The decisive question for cause (A). Cashfree keys its order routes on
     * the order id WE sent, which is our own `order.id` — see the long note in
     * cashfree.provider.ts about why this is not `cf_order_id`.
     */
    const status = await cf('GET', `/orders/${encodeURIComponent(o.order_id)}`);
    const cfStatus = String(status.json['order_status'] ?? '(none)');
    line(`HTTP ${status.status}   order_status = ${cfStatus}`);

    /*
     * ======================================================================
     * `return_url` — THE FIELD THAT WAS ACTUALLY MISSING
     * ======================================================================
     *
     * This script's first run ruled out all three of the causes it was built
     * to test: the session was ACTIVE, correctly shaped and in the right
     * environment, and the checkout still refused. The thing it had dismissed
     * in its own closing note — an absent `return_url` — was the answer.
     *
     * Cashfree's v3 checkout will not render for an order without one, and
     * `order_meta` used to be sent only when `CASHFREE_PUBLIC_BASE_URL` was
     * set. That variable exists for the WEBHOOK, which needs a public
     * hostname; the return url is followed by the customer's own browser and
     * never needed one. Gating them together meant every local order was
     * created with neither.
     *
     * So it is printed rather than reasoned about. Null here is the bug.
     */
    const meta = status.json['order_meta'] as Record<string, unknown> | null | undefined;
    const returnUrl = meta?.['return_url'];
    const notifyUrl = meta?.['notify_url'];
    line(`return_url   ${returnUrl ? String(returnUrl) : `${RED}null${OFF}`}`);
    line(`notify_url   ${notifyUrl ? String(notifyUrl) : `${YELLOW}null${OFF}`}`);

    if (!returnUrl) {
      dim('');
      dim(`${RED}No return_url on this order.${OFF} Cashfree's v3 checkout requires one,`);
      dim('which is why the modal said "Something went wrong" for a session that is');
      dim('otherwise perfectly valid. Orders placed BEFORE this was fixed cannot be');
      dim('repaired — the field is set at creation. Place a new one.');
    }

    if (status.status === 404) {
      line(`${RED}Cashfree has never heard of this order.${OFF}`);
      dim('The intent was stored but the provider call did not create the order,');
      dim('or it was created with a different order id.');
    } else if (cfStatus === 'ACTIVE') {
      line(`${GREEN}The order is still ACTIVE, so its session should open.${OFF}`);
      dim('That rules out cause A — a spent session. Read step 3.');
    } else {
      line(`${RED}The order is ${cfStatus}, not ACTIVE — its session is spent.${OFF}`);
      dim('');
      dim('THIS IS THE CAUSE. Cashfree issues one session per order and retires');
      dim('it once a payment attempt on that order reaches a terminal state.');
      dim('`createIntent` hands back the stored payload for any live payment');
      dim('row, so every retry after that first attempt replays a dead session');
      dim('and gets the "Something went wrong" screen.');
      dim('');
      dim('A NEW order works. A retry on this one never will.');
    }

    // -----------------------------------------------------------------------
    step('2b. Does this order have anything to PAY WITH?');
    // -----------------------------------------------------------------------
    /*
     * ======================================================================
     * THE QUESTION TWO WRONG GUESSES DID NOT ASK
     * ======================================================================
     *
     * "Something went wrong" was blamed first on a spent session and then on a
     * missing return_url. Both were checked, both were wrong, and both were
     * about whether the SDK could REACH the order. This asks whether there is
     * anything for it to RENDER once it gets there.
     *
     * An order can be perfectly valid — ACTIVE, correct amount, correct
     * environment, a return url — and still have no enabled payment method
     * behind it, because payment methods are enabled per MERCHANT ACCOUNT in
     * the Cashfree dashboard, not per order. A sandbox account that has never
     * had them switched on creates orders happily and cannot check out.
     *
     * That failure is invisible from this codebase: nothing we send is wrong,
     * so no amount of reading our own source finds it. It is only visible by
     * asking Cashfree what it would offer this customer.
     */
    const eligibility = await cf('POST', '/eligibility/payment_methods', {
      queries: { amount: Number((o.checkout_payload?.['amountRupees'] as number) ?? 1) },
      order_id: o.order_id,
    });

    if (eligibility.status >= 400) {
      line(`${YELLOW}Eligibility check returned HTTP ${eligibility.status}.${OFF}`);
      dim(eligibility.text.slice(0, 300));
      dim('');
      dim('If this says the endpoint is unavailable, ignore it — not every');
      dim('sandbox account exposes it. If it names a configuration problem,');
      dim('that is the answer.');
    } else {
      const methods = Array.isArray(eligibility.json)
        ? (eligibility.json as unknown[])
        : ((eligibility.json['payment_methods'] as unknown[] | undefined) ?? []);

      const enabled = methods.filter((m) => {
        const rec = m as Record<string, unknown>;
        return rec['eligibility'] === true || rec['eligibility'] === undefined;
      });

      line(`${enabled.length} payment method(s) available for this order`);
      for (const m of enabled.slice(0, 8)) {
        const rec = m as Record<string, unknown>;
        const pm = rec['payment_method'] as Record<string, unknown> | undefined;
        dim(`  ${Object.keys(pm ?? rec).join(', ')}`);
      }

      if (enabled.length === 0) {
        line(`${RED}NOTHING IS ENABLED. This is the cause.${OFF}`);
        dim('');
        dim("Cashfree's checkout has no method to offer, so it renders its");
        dim('generic "Something went wrong" instead of an empty payment list.');
        dim('');
        dim('Nothing in this repository can fix that — it is account');
        dim('configuration. In the Cashfree dashboard, with the environment');
        dim('toggle on TEST:  Payment Gateway -> Payment Methods, and enable');
        dim('at least UPI and Cards for the test environment.');
      } else {
        line(`${GREEN}Methods are enabled, so the account is not the problem.${OFF}`);
      }
    }

    // -----------------------------------------------------------------------
    step('3. The shape of a freshly-issued session, for comparison');
    // -----------------------------------------------------------------------
    /*
     * Cause (B). The screenshot that prompted this script showed an id ending
     * `paymentpayment`, and only Cashfree can say whether that is normal. So
     * ask for a new one and compare — if a fresh id has the same tail, the
     * stored value is fine and the fault is elsewhere.
     */
    const probeId = `probe-${Date.now()}`;
    const probe = await cf('POST', '/orders', {
      order_id: probeId,
      order_amount: 1.0,
      order_currency: 'INR',
      customer_details: { customer_id: 'probe', customer_phone: '9999999999' },
    });

    const fresh = probe.json['payment_session_id'];
    if (typeof fresh !== 'string') {
      line(`${YELLOW}Could not mint a probe session (HTTP ${probe.status}).${OFF}`);
      dim(probe.text.slice(0, 200));
    } else {
      line(`fresh      ${shape(fresh)}`);
      line(`stored     ${shape(stored)}`);
      dim('');

      const tailOf = (s: string): string => (s.match(/(payment)+$/)?.[0] ?? '(no payment suffix)');
      const freshTail = tailOf(fresh);
      const storedTail = tailOf(stored);

      if (freshTail === storedTail) {
        line(`${GREEN}Same suffix ("${freshTail}") — the stored id is not mangled.${OFF}`);
        dim('So the doubled "payment" is simply Cashfree\'s format, and cause B');
        dim('is ruled out. The answer is in step 2.');
      } else {
        line(`${RED}Different suffix: fresh "${freshTail}" vs stored "${storedTail}".${OFF}`);
        dim('');
        dim('THE STORED VALUE HAS BEEN ALTERED between Cashfree issuing it and');
        dim('the browser using it. Nothing in this codebase concatenates onto a');
        dim('session id, so look at what wrote `payment.checkout_payload` for');
        dim('this order — and at anything that re-serialises it in between.');
      }
    }

    // -----------------------------------------------------------------------
    step('3b. The same order, read at two API versions');
    // -----------------------------------------------------------------------
    /*
     * ======================================================================
     * THE ONE THING THAT WAS CONSTANT ACROSS EVERY FAILURE
     * ======================================================================
     *
     * The browser console finally gave the real error, and it is inside
     * CASHFREE'S OWN hosted checkout bundle, not ours:
     *
     *     TypeError: Cannot read properties of undefined
     *                (reading 'orderCurrency')     at checkout/:99
     *
     * Their app maps over payment methods and reads `orderCurrency` off an
     * object that is undefined. Nothing we send is rejected — the order is
     * ACTIVE, fourteen payment methods are eligible, the session is valid and
     * the environments agree. The order is fine; the MODEL BUILT FROM IT is
     * incomplete.
     *
     * `x-api-version` is the field that decides that model's shape, and this
     * project pins `2023-08-01` — which Cashfree now files under "previous",
     * their current default being `2025-01-01`. The hosted checkout page is
     * always the newest build. An order minted on an old version, opened by a
     * new checkout, is precisely how a field the new code expects arrives
     * undefined.
     *
     * This does not argue that from the shape of the error. It fetches the
     * SAME order at both versions and compares what comes back. A field
     * present at one and absent at the other is the answer, on the wire.
     */
    const NEW_VERSION = '2025-01-01';
    const oldRead = await cf('GET', `/orders/${encodeURIComponent(o.order_id)}`, undefined, cfg.CASHFREE_API_VERSION);
    const newRead = await cf('GET', `/orders/${encodeURIComponent(o.order_id)}`, undefined, NEW_VERSION);

    line(`configured  ${cfg.CASHFREE_API_VERSION}  -> HTTP ${oldRead.status}`);
    line(`current     ${NEW_VERSION}  -> HTTP ${newRead.status}`);

    if (newRead.status >= 400) {
      line(`${YELLOW}The newer version was refused.${OFF}`);
      dim(newRead.text.slice(0, 250));
      dim('If it says the version is not enabled for this account, that is a');
      dim('dashboard setting rather than a code change.');
    } else {
      const oldKeys = new Set(Object.keys(oldRead.json));
      const newKeys = new Set(Object.keys(newRead.json));
      const onlyNew = [...newKeys].filter((k) => !oldKeys.has(k));
      const onlyOld = [...oldKeys].filter((k) => !newKeys.has(k));

      line(`fields only on ${NEW_VERSION}: ${onlyNew.length ? onlyNew.join(', ') : '(none)'}`);
      line(`fields only on ${cfg.CASHFREE_API_VERSION}: ${onlyOld.length ? onlyOld.join(', ') : '(none)'}`);

      if (onlyNew.length > 0) {
        dim('');
        line(`${RED}The versions return different shapes.${OFF}`);
        dim('');
        dim('This is consistent with the console error: the checkout page is');
        dim('built against the newer shape and reads a field the older order');
        dim('does not carry.');
        dim('');
        dim(`${BOLD}TRY THIS — no code change:${OFF}`);
        dim(`  add   CASHFREE_API_VERSION=${NEW_VERSION}   to .env`);
        dim('  restart the API, place a NEW order, and pay.');
        dim('');
        dim('Existing orders keep the version they were created with, so this');
        dim('cannot be tested on A-019 or anything before it.');
      } else {
        line(`${GREEN}Both versions return the same field set.${OFF}`);
        dim('So the pinned version is probably not the cause, and the missing');
        dim('object is something else in the checkout page\'s model. The raw');
        dim('order below is what Cashfree actually holds — read it against the');
        dim('fields their checkout expects.');
      }
    }

    dim('');
    dim('The order exactly as Cashfree holds it:');
    for (const l of JSON.stringify(newRead.status < 400 ? newRead.json : oldRead.json, null, 2).split('\n')) {
      dim(`  ${l}`);
    }

    // -----------------------------------------------------------------------
    step('4. Environments');
    // -----------------------------------------------------------------------
    const mode = o.checkout_payload?.['mode'];
    const keySeg = (cfg.CASHFREE_SECRET_KEY ?? '').split('_').slice(0, 3).join('_');
    line(`payload mode   ${String(mode ?? '(none)')}`);
    line(`CASHFREE_ENV   ${cfg.CASHFREE_ENV}`);
    line(`key category   ${keySeg}`);
    if (mode !== cfg.CASHFREE_ENV) {
      line(`${RED}The stored payload says "${String(mode)}" but the server is on ` +
        `"${cfg.CASHFREE_ENV}".${OFF}`);
      dim('The browser opens the SDK in the payload\'s mode, so a session minted');
      dim('in one environment is being opened against the other. That is cause C.');
    } else {
      line(`${GREEN}Consistent.${OFF} Cause C ruled out.`);
    }

    // -----------------------------------------------------------------------
    step('Also worth knowing');
    // -----------------------------------------------------------------------
    if (!cfg.CASHFREE_PUBLIC_BASE_URL) {
      line(`${YELLOW}CASHFREE_PUBLIC_BASE_URL is not set.${OFF}`);
      dim('So `notify_url` is omitted and Cashfree sends NO WEBHOOK. The only way');
      dim('this server learns an outcome is the reconcile sweep polling');
      dim('`getStatus` — never wrong, but slower. A tunnel (cloudflared / ngrok)');
      dim('pointed at :3000 fixes it.');
      dim('');
      dim('`return_url` no longer depends on this and is sent regardless — it is');
      dim('followed by the browser, not by Cashfree. An earlier version of this');
      dim('note claimed the missing variable was "not the cause" of a failing');
      dim('checkout. It was. The two urls are now configured separately.');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
