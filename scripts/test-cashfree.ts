/**
 * ============================================================================
 * TALK TO THE REAL CASHFREE SANDBOX AND REPORT WHAT IT ACTUALLY SAYS
 * ============================================================================
 *
 *   npm run test:cashfree
 *
 * This exists because of one honest gap. Cashfree's reference documentation is
 * client-rendered and could not be read while the provider was written, and the
 * published examples disagree about the shape of an `order_splits` element —
 * some show `{vendor_id, percentage}`, others `{amount, vendor}`.
 *
 * Guessing and shipping would produce the worst available failure: a payment
 * that succeeds, a customer who is charged, and a stall whose share silently
 * stays in the platform's account until somebody reads a bank statement weeks
 * later. Nothing in the app would look wrong.
 *
 * So the uncertainty is resolved the only way it honestly can be — by asking
 * the sandbox. Each probe below prints Cashfree's own error verbatim, which
 * names the field it did not like.
 *
 * ----------------------------------------------------------------------------
 * SAFE TO RUN
 * ----------------------------------------------------------------------------
 *
 * It refuses to run against production, creates orders for ₹1, and never
 * completes a payment — an unpaid Cashfree order expires on its own and costs
 * nothing. It touches no database.
 */

import { config } from '../src/platform/config.js';
import { paiseToRupees } from '../src/payments/providers/cashfree.money.js';
import { paise } from '../src/platform/money.js';

const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const DIM = '[2m';
const OFF = '[0m';

function step(s: string): void {
  process.stdout.write(`\n${BOLD}==> ${s}${OFF}\n`);
}
function ok(s: string): void {
  process.stdout.write(`    ${GREEN}ok${OFF}   ${s}\n`);
}
function bad(s: string): void {
  process.stdout.write(`    ${RED}FAIL${OFF} ${s}\n`);
}
function dim(s: string): void {
  process.stdout.write(`    ${DIM}${s}${OFF}\n`);
}

const cfg = config();

if (cfg.CASHFREE_ENV === 'production') {
  process.stderr.write(
    `\n${RED}Refusing to run against production.${OFF}\n` +
      `This creates real orders. Set CASHFREE_ENV=sandbox and use sandbox credentials.\n\n`,
  );
  process.exit(1);
}

if (!cfg.CASHFREE_APP_ID || !cfg.CASHFREE_SECRET_KEY) {
  process.stderr.write(
    `\n${RED}CASHFREE_APP_ID and CASHFREE_SECRET_KEY are not set.${OFF}\n\n` +
      `Get sandbox credentials from the Cashfree dashboard:\n` +
      `  Developers -> Payment Gateway -> API Keys, with the environment toggle on Test.\n\n` +
      `Then put them in .env (which is gitignored — do not paste them anywhere else):\n` +
      `  CASHFREE_ENV=sandbox\n` +
      `  CASHFREE_APP_ID=...\n` +
      `  CASHFREE_SECRET_KEY=...\n\n`,
  );
  process.exit(1);
}

/*
 * Captured after the guard above, as plain strings.
 *
 * TypeScript narrows `cfg.CASHFREE_APP_ID` at the `if` and loses that narrowing
 * the moment it is read inside a function — the compiler cannot know `cfg` was
 * not reassigned in between. Binding them here does the narrowing once, and
 * removes the `!` assertions that would otherwise be sprinkled over every use.
 */
const APP_ID: string = cfg.CASHFREE_APP_ID;
const SECRET: string = cfg.CASHFREE_SECRET_KEY;

/*
 * ============================================================================
 * THE KEY SAYS WHICH ENVIRONMENT IT IS FOR. CHECK BEFORE SPENDING A ROUND TRIP.
 * ============================================================================
 *
 * Cashfree secret keys are `cfsk_ma_<env>_<random>`, so a production key aimed
 * at the sandbox is detectable locally, instantly, and with certainty.
 *
 * This check exists because the alternative already happened: the first run of
 * this script returned
 *
 *     HTTP 401  {"message":"authentication Failed","type":"authentication_error"}
 *
 * four times, and "authentication Failed" is the same message for a wrong key,
 * a revoked key, an IP block and a right key pointed at the wrong host. The
 * script correctly reported that something was wrong and gave no way to tell
 * which — so the answer came from reading the key prefix by hand afterwards.
 * Doing that here turns a diagnosis into a sentence.
 *
 * Only the `cfsk_ma_test` / `cfsk_ma_prod` SEGMENT is read. It is a category
 * label rather than key material, and it is never printed in full.
 */
{
  const seg = SECRET.split('_').slice(0, 3).join('_');
  const keyEnv = seg === 'cfsk_ma_prod' ? 'production' : seg === 'cfsk_ma_test' ? 'sandbox' : null;

  if (keyEnv === 'production') {
    process.stderr.write(
      `\n${RED}That is a PRODUCTION key.${OFF}\n\n` +
        `  CASHFREE_SECRET_KEY starts with ${seg}_ but this script only talks to the sandbox,\n` +
        `  which is why Cashfree answers "authentication Failed" — the credentials are real,\n` +
        `  they just do not exist on the host being called.\n\n` +
        `  In the Cashfree dashboard press ${BOLD}Switch to Test${OFF} in the top bar (that button\n` +
        `  being visible means you are in Production right now), then\n` +
        `  Developers -> Payment Gateway -> API Keys and take a fresh pair.\n` +
        `  The test secret reads cfsk_ma_test_…\n\n`,
    );
    process.exit(1);
  }

  if (keyEnv === null) {
    dim(`Note: CASHFREE_SECRET_KEY does not match the expected cfsk_ma_<env>_ shape.`);
    dim(`Continuing anyway — Cashfree may have changed the format since this was written.`);
  }
}

const BASE = 'https://sandbox.cashfree.com/pg';

async function call(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-version': cfg.CASHFREE_API_VERSION,
      'x-client-id': APP_ID,
      'x-client-secret': SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* keep the text; some errors are not JSON */
  }
  return { status: res.status, json, text };
}

/** A fresh order id per probe. Cashfree rejects a reused one, which is correct. */
const oid = (tag: string): string => `smoke-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function baseOrder(id: string): Record<string, unknown> {
  return {
    order_id: id,
    // ₹1, through the real conversion — so this also exercises the money boundary.
    order_amount: paiseToRupees(paise(100)),
    order_currency: 'INR',
    customer_details: { customer_id: `cust_${id}`, customer_phone: '9999999999' },
  };
}

let failures = 0;

/**
 * Wrapped in `main()` rather than run at the top level.
 *
 * This project's tsconfig emits CommonJS for scripts, where top-level `await`
 * is a syntax error rather than a style choice. Every other script here uses
 * the same shape, and the `.catch` is what turns an unhandled rejection into a
 * readable message and a non-zero exit.
 */
async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  step('1. Credentials and API version');
  // ---------------------------------------------------------------------------
  dim(`env=${cfg.CASHFREE_ENV}  api-version=${cfg.CASHFREE_API_VERSION}  app-id=…${APP_ID.slice(-6)}`);

  {
    const id = oid('plain');
    const r = await call('/orders', baseOrder(id));

    if (r.status === 200 && typeof r.json['payment_session_id'] === 'string') {
      ok('a plain order was created — credentials, version and the money format are all good');
      dim(`cf_order_id=${String(r.json['cf_order_id'])}  order_status=${String(r.json['order_status'])}`);
    } else {
      failures++;
      bad(`plain order rejected with HTTP ${r.status}`);
      dim(r.text.slice(0, 400));
      if (r.status === 401) {
        dim('401 usually means the keys are for the other environment — sandbox keys differ from live.');
      }
      if (r.status === 400 && r.text.includes('version')) {
        dim(`Try a different CASHFREE_API_VERSION; the current one is ${cfg.CASHFREE_API_VERSION}.`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  step('2. The order_splits shape — the thing this script exists for');
  // ---------------------------------------------------------------------------
  dim('Trying the shape the provider sends, then the documented alternatives.');
  dim('A vendor id that does not exist is fine: the useful signal is WHICH field it complains about.');

  const VENDOR = process.env['CASHFREE_TEST_VENDOR_ID'] ?? 'smoketestvendor';

  /*
   * `expect` is what makes the output readable.
   *
   * The first version printed a red FAIL for `{ vendor, amount }` being
   * rejected — which is the OPPOSITE of a failure. That shape is a negative
   * control: Cashfree refusing it, and naming `vendor_id` as the missing key,
   * is the single most discriminating piece of evidence this script produces.
   * Reporting the control's success as a failure trains a reader to skim red,
   * which is the one habit a diagnostic must not teach.
   */
  const shapes: { label: string; splits: unknown; expect: 'accepted' | 'refused' }[] = [
    {
      label: '{ vendor_id, amount }   <- what the provider sends',
      splits: [{ vendor_id: VENDOR, amount: 1 }],
      expect: 'accepted',
    },
    {
      label: '{ vendor_id, percentage }',
      splits: [{ vendor_id: VENDOR, percentage: 100 }],
      expect: 'accepted',
    },
    {
      label: '{ vendor, amount }      <- control, should be refused',
      splits: [{ vendor: VENDOR, amount: 1 }],
      expect: 'refused',
    },
  ];

  /** Cashfree understood the fields and only objected to the invented payee. */
  const understood = (msg: string): boolean =>
    /vendor.*(not found|does not exist|invalid vendor)/i.test(msg);

  let winner: string | null = null;

  for (const s of shapes) {
    const id = oid('split');
    const r = await call('/orders', { ...baseOrder(id), order_splits: s.splits });
    const message = String(r.json['message'] ?? r.text).slice(0, 220);

    const parsed = r.status === 200 || understood(message);

    if (s.expect === 'accepted') {
      if (parsed) {
        ok(`${s.label} — shape understood${r.status === 200 ? ' and ACCEPTED' : '; only the made-up vendor id was rejected'}`);
        if (r.status === 200) dim(`echoed back: ${JSON.stringify(r.json['order_splits'])}`);
        else dim(message);
        winner ??= s.label;
      } else {
        failures++;
        bad(`${s.label} was NOT understood (HTTP ${r.status})`);
        dim(message);
      }
    } else {
      if (parsed) {
        /*
         * The control was accepted, which means the field names are looser than
         * this script assumes. Not a failure — but it means the evidence above
         * is weaker than it looks, and somebody should read the echoed payload.
         */
        dim(`note  ${s.label} was ALSO understood — Cashfree accepts more than one spelling`);
      } else {
        ok(`${s.label} — refused, as it should be`);
        dim(message);
      }
    }
  }

  dim('');
  if (winner) {
    ok(`splitPayload() should send: ${(winner.split('<-')[0] ?? winner).trim()}`);
    dim('That is what cashfree.provider.ts sends today. No change needed.');
  } else {
    dim('No shape was understood. If every message says "Easy Split not enabled",');
    dim('activation is pending and this is not a code problem.');
  }

  // ---------------------------------------------------------------------------
  step('3. Webhook signature — verified locally, no network needed');
  // ---------------------------------------------------------------------------
  {
    const { createHmac } = await import('node:crypto');
    const { CashfreePaymentProvider } = await import('../src/payments/providers/cashfree.provider.js');

    const provider = new CashfreePaymentProvider({
      mode: 'PLATFORM_COLLECT',
      appId: APP_ID,
      secretKey: SECRET,
      env: 'sandbox',
      apiVersion: cfg.CASHFREE_API_VERSION,
      publicBaseUrl: cfg.CASHFREE_PUBLIC_BASE_URL,
    });

    const body = Buffer.from(
      JSON.stringify({
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        event_time: new Date().toISOString(),
        data: {
          order: { order_id: 'test-order' },
          payment: { cf_payment_id: 12345, payment_status: 'SUCCESS', payment_amount: 1 },
        },
      }),
    );
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', SECRET)
      .update(ts + body.toString('utf8'))
      .digest('base64');

    try {
      const ev = provider.verifyAndParseWebhook(body, {
        'x-webhook-signature': sig,
        'x-webhook-timestamp': ts,
      });
      ok(`a correctly signed webhook verifies and normalises to ${ev.kind}`);
    } catch (e) {
      failures++;
      bad(`a correctly signed webhook was REJECTED: ${String(e)}`);
    }

    // The negative control. A check that accepts everything is worse than none.
    try {
      provider.verifyAndParseWebhook(body, {
        'x-webhook-signature': Buffer.from('wrong').toString('base64'),
        'x-webhook-timestamp': ts,
      });
      failures++;
      bad('a FORGED signature was accepted — this is a critical hole');
    } catch {
      ok('a forged signature is refused');
    }

    // And a replay of a genuinely signed event from an hour ago.
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = createHmac('sha256', SECRET)
      .update(oldTs + body.toString('utf8'))
      .digest('base64');
    try {
      provider.verifyAndParseWebhook(body, {
        'x-webhook-signature': oldSig,
        'x-webhook-timestamp': oldTs,
      });
      failures++;
      bad('an hour-old but correctly signed replay was accepted');
    } catch {
      ok('a correctly signed but stale replay is refused');
    }
  }

  // ---------------------------------------------------------------------------
  step('Verdict');
  // ---------------------------------------------------------------------------
  if (failures === 0) {
    process.stdout.write(
      `    ${GREEN}Nothing failed.${OFF} Confirm the split shape in step 2 matches what\n` +
        `    splitPayload() sends, and this integration is ready for a sandbox payment.\n\n`,
    );
  } else {
    process.stdout.write(`    ${RED}${failures} check(s) failed.${OFF} Details above.\n\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${String(e)}${OFF}\n\n`);
  process.exit(1);
});
