/**
 * ============================================================================
 * DID THE STALL ACTUALLY GET ITS MONEY?
 * ============================================================================
 *
 *   npm run diagnose:split              # the most recent paid order
 *   npm run diagnose:split -- <orderId>
 *
 * THE FAILURE THIS IS FOR
 *
 * A split that does not happen looks exactly like a split that does. The
 * customer pays, the order cooks, the ledger balances, all three apps show a
 * completed order — and the stall's share sits in the platform's Cashfree
 * account. Nothing on any screen is wrong. The first artefact is a settlement
 * report at the end of a month.
 *
 * So this compares three things that must agree and are computed in three
 * different places:
 *
 *   1. what the ORDER says       our stored distribution
 *   2. what WE decided           `buildSplit`, run against that order
 *   3. what CASHFREE recorded    `order_splits` on the real order
 *
 * (1) vs (2) catches a wiring bug. (2) vs (3) catches the one that matters:
 * we built a split and it never reached them. `tests/conformance/split.mjs`
 * covers the arithmetic without a network; only this can tell you the split
 * left the building.
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
import { paise } from '../src/platform/money.js';
import { buildPaymentProvider } from '../src/payments/provider.factory.js';
import { buildSplit, platformShare } from '../src/payments/split.js';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

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
const BASE =
  cfg.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

/** Rupees, for reading. The arithmetic below stays in paise throughout. */
const rs = (p: number): string => `₹${(p / 100).toFixed(2)}`;

async function cf(
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-version': cfg.CASHFREE_API_VERSION,
      'x-client-id': cfg.CASHFREE_APP_ID ?? '',
      'x-client-secret': cfg.CASHFREE_SECRET_KEY ?? '',
      ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function main(): Promise<void> {
  const wanted = process.argv[2];

  const db = createDb(createPool({ connectionString: cfg.DATABASE_URL }));

  try {
    // -----------------------------------------------------------------------
    step('0. Is the API even running?');
    // -----------------------------------------------------------------------
    /*
     * ======================================================================
     * FIRST, BECAUSE IT WAS THE ANSWER AND IT WAS ASKED LAST
     * ======================================================================
     *
     * A 502 from POST /payment-intent was read as "Cashfree refused this
     * order", and four rounds went into proving the payload against the live
     * sandbox: the amount, the split allocation, the vendor's account, the
     * whole real `createIntent` body, the idempotency key. All of it passed.
     *
     * It passed because the request never arrived. The browser talks to Vite
     * on :5173, which proxies /api to :3000 — and when that proxy cannot reach
     * the API it answers 502 ITSELF. Identical status, identical empty body,
     * identical URL to the one the API's own filter returns for
     * PAYMENT_PROVIDER_REJECTED. The API runs under `node --watch`, so every
     * source edit restarts it and opens a window where this happens.
     *
     * So the cheapest question goes first. If the API is down, nothing below
     * matters and every green tick in it is about a request nobody sent.
     */
    const API = 'http://localhost:3000';
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const health = await fetch(`${API}/healthz`, { signal: ctl.signal });
      clearTimeout(t);
      if (health.ok) {
        line(`${GREEN}up${OFF}  ${API} answered ${health.status}`);
      } else {
        line(`${YELLOW}reachable but unhealthy${OFF}  ${API} answered ${health.status}`);
      }
    } catch {
      line(`${RED}THE API IS NOT REACHABLE at ${API}.${OFF}`);
      dim('');
      dim('Every 502 the browser sees is the Vite proxy reporting that, not the');
      dim('API and not Cashfree. Start it with `npm run dev` and retry the payment');
      dim('before reading anything below — the rest of this report describes an');
      dim('order whose payment request is not currently able to leave the browser.');
    }

    // -----------------------------------------------------------------------
    step('1. The order, as we priced it');
    // -----------------------------------------------------------------------
    const rows = await sql<{
      id: string;
      order_number: string;
      status: string;
      settlement_mode_snapshot: string;
      total_payable_paise: number;
      vendor_net_paise: number;
      platform_tax_reserve_paise: number;
      customer_fee_paise: number;
      customer_fee_tax_paise: number;
      vendor_commission_paise: number;
      operator_share_paise: number;
      vendor_name: string;
      linked_account: string | null;
    }>`
      SELECT o.id, o.public_order_number AS order_number, o.status::text AS status,
             o.settlement_mode_snapshot::text AS settlement_mode_snapshot,
             o.total_payable_paise, o.vendor_net_paise, o.platform_tax_reserve_paise,
             o.customer_fee_paise, o.customer_fee_tax_paise,
             o.vendor_commission_paise, o.operator_share_paise,
             -- ALIASED, and the missing alias was a real bug in this file.
             --
             -- sql<{...}> is an ASSERTION, not a check: Kysely cannot read
             -- column names out of a raw template, so a declared field the
             -- query never returns is undefined at runtime and silent at
             -- compile time. This selected provider_linked_account_id while
             -- the type and every use said linked_account, so the diagnostic
             -- reported "linked acct none" for a correctly onboarded stall and
             -- buildSplit, handed undefined, refused a split it should have
             -- built. A diagnostic that accuses correct code is worse than none.
             --
             -- SQL line comments, not a block comment: this is inside a
             -- template literal, and the backticks a JS comment would want for
             -- identifiers terminate the string.
             v.name AS vendor_name,
             v.provider_linked_account_id AS linked_account
        FROM "order" o
        JOIN vendor v ON v.id = o.vendor_id
       WHERE ${wanted ? sql`o.id = ${wanted}` : sql`TRUE`}
       /*
        * PLATFORM_COLLECT FIRST when no order is named.
        *
        * Defaulting to the newest order full stop was close to useless: most
        * stalls are VENDOR_DIRECT, so the answer was almost always "nothing to
        * divide, which is correct" — a true statement about an order nobody was
        * asking about. Somebody running this is testing the SPLIT, so the
        * default is the newest order that could have one.
        *
        * It still falls back to any order, so a court with no PLATFORM_COLLECT
        * stall gets a report rather than silence.
        */
       ORDER BY (o.settlement_mode_snapshot = 'PLATFORM_COLLECT') DESC,
                o.created_at DESC
       LIMIT 1
    `.execute(db);

    const o = rows.rows[0];
    if (!o) {
      line(`${YELLOW}No such order.${OFF}`);
      return;
    }

    /*
     * The row really carries the fields the type claims.
     *
     * Cheap, and it exists because the alternative already happened: a raw SQL
     * template lost an alias, `linked_account` came back undefined, and every
     * conclusion after it was drawn from a missing column rather than a missing
     * value. `undefined` and `null` mean completely different things here — one
     * is "this stall has no payout account", the other is "this query is
     * broken" — and only the second is worth stopping for.
     */
    if (!('linked_account' in o)) {
      line(`${RED}The query did not return linked_account.${OFF}`);
      dim(`columns: ${Object.keys(o).join(', ')}`);
      dim('That is an alias bug in this file, not a problem with the stall.');
      process.exit(1);
    }

    line(`order        ${o.order_number}  (${o.id})`);
    line(`stall        ${o.vendor_name}`);
    line(`status       ${o.status}`);
    line(`mode         ${o.settlement_mode_snapshot}`);
    if (!wanted && o.settlement_mode_snapshot !== 'PLATFORM_COLLECT') {
      dim('');
      dim(`${YELLOW}This is the newest order of ANY kind — no PLATFORM_COLLECT order`);
      dim(`exists yet.${OFF} A split only happens in that mode, so to test one:`);
      dim('  npm run split:setup            (find a PLATFORM_COLLECT stall)');
      dim('  npm run split:setup -- <id>    (onboard it)');
      dim('  then order from THAT stall and pay.');
    }
    line(`linked acct  ${o.linked_account ?? `${RED}none${OFF}`}`);
    dim('');
    line(`total paid   ${rs(o.total_payable_paise)}`);
    dim(`  vendor net        ${rs(o.vendor_net_paise)}   -> the stall`);
    dim(`  food GST s.9(5)   ${rs(o.platform_tax_reserve_paise)}   -> platform`);
    dim(`  convenience fee   ${rs(o.customer_fee_paise)}   -> platform`);
    dim(`  fee GST           ${rs(o.customer_fee_tax_paise)}   -> platform`);
    dim(`  commission        ${rs(o.vendor_commission_paise)}   -> platform`);
    dim(`  operator share    ${rs(o.operator_share_paise)}   -> platform`);

    if (o.customer_fee_paise === 0 && o.settlement_mode_snapshot === 'PLATFORM_COLLECT') {
      dim('');
      line(`${YELLOW}No convenience fee on this order.${OFF}`);
      dim('Either it predates migration 22, or no CUSTOMER fee rule is in force.');
      dim('Fee rules are snapshotted at placement — an order priced before the');
      dim('rule existed keeps its original terms for ever, including refunds.');
      dim('Place a NEW order to see the fee.');
    }

    // -----------------------------------------------------------------------
    step('2. What buildSplit decides for it');
    // -----------------------------------------------------------------------
    /*
     * The REAL function, not a re-implementation. A diagnostic that reasons
     * about what the code probably does is a diagnostic that can agree with
     * itself while disagreeing with production.
     */
    const decision = buildSplit({
      money: {
        orderId: o.id,
        totalPayablePaise: o.total_payable_paise,
        vendorNetPaise: o.vendor_net_paise,
        platformTaxReservePaise: o.platform_tax_reserve_paise,
        customerFeePaise: o.customer_fee_paise,
        customerFeeTaxPaise: o.customer_fee_tax_paise,
        vendorCommissionPaise: o.vendor_commission_paise,
        operatorSharePaise: o.operator_share_paise,
      },
      settlementMode: o.settlement_mode_snapshot as 'PLATFORM_COLLECT' | 'VENDOR_DIRECT',
      vendorLinkedAccountId: o.linked_account,
    });

    line(`decision     ${decision.kind}`);
    if (decision.kind === 'REFUSE') {
      line(`${RED}${decision.reason}${OFF}`);
      dim('');
      dim('This order should never have been placed — order.repository refuses');
      dim('the same condition earlier. Run: npm run split:setup');
      return;
    }
    if (decision.kind === 'NONE') {
      dim('Nothing to divide. Under VENDOR_DIRECT that is correct and expected:');
      dim('the money never reaches a platform account.');
      return;
    }

    for (const a of decision.split.allocations) {
      line(`  ${a.party} ${a.linkedAccountId} -> ${rs(a.amountPaise)}`);
    }
    line(`  PLATFORM keeps the residue -> ${rs(platformShare({
      orderId: o.id,
      totalPayablePaise: o.total_payable_paise,
      vendorNetPaise: o.vendor_net_paise,
      platformTaxReservePaise: o.platform_tax_reserve_paise,
      customerFeePaise: o.customer_fee_paise,
      customerFeeTaxPaise: o.customer_fee_tax_paise,
      vendorCommissionPaise: o.vendor_commission_paise,
      operatorSharePaise: o.operator_share_paise,
    }))}`);

    // -----------------------------------------------------------------------
    step('2b. Will Cashfree accept a split to this stall RIGHT NOW?');
    // -----------------------------------------------------------------------
    /*
     * ========================================================================
     * THE QUESTION A 502 CANNOT ANSWER
     * ========================================================================
     *
     * `POST /orders/:id/payment-intent` answers 502 PAYMENT_PROVIDER_REJECTED
     * when Cashfree refuses to create the order, and deliberately sends the
     * customer none of Cashfree's reply — an aggregator's internal complaint is
     * not something to put on a phone.
     *
     * That is right for a customer and useless for anybody testing, and the
     * remedy is not "go and read the server log". This asks Cashfree the same
     * question directly, with the SAME allocation the real order would carry,
     * and prints their answer verbatim.
     *
     * A THROWAWAY ₹1 ORDER, never paid. An unpaid Cashfree order expires by
     * itself and costs nothing — far cheaper than another round of guessing at
     * which of the payload's fields they disliked.
     *
     * The most likely answer, and the reason this step exists: a vendor in
     * IN_BANK_VALIDATION may not be a valid payee yet. Sandbox vendors take
     * about ten minutes to reach ACTIVE, and "the stall can take orders now"
     * was an assumption rather than something anybody had checked.
     */
    const vendorState = await cf(
      `/easy-split/vendors/${encodeURIComponent(o.linked_account ?? '')}`,
    );
    line(`vendor status  ${String(vendorState.json['status'] ?? `HTTP ${vendorState.status}`)}`);

    /*
     * ======================================================================
     * THE PROBE USES THE REAL ORDER'S NUMBERS, NOT ROUND ONES
     * ======================================================================
     *
     * The first version sent ₹1 with a ₹0.50 split — half the order — and
     * reported "Cashfree accepts a split to this vendor" for an order whose
     * real allocation is ₹199.00 of ₹210.13, or 94.7%. It answered a question
     * nobody asked and cleared a payload that was never sent.
     *
     * That is the same failure as a script building its own database pool:
     * a probe that differs from the application tells you about the probe.
     * Aggregators have rules about how much of an order may be allocated away
     * — the merchant has to retain enough to cover the gateway's own fee — and
     * a 50% split cannot discover a rule that binds at 95%.
     *
     * So it mirrors the real payload exactly: same amount, same allocation,
     * same customer shape. Only the order id differs, because Cashfree refuses
     * a duplicate.
     */
    const probeId = `splitprobe${Date.now()}`;
    const probeSplit = decision.split.allocations.map((a) => ({
      vendor_id: a.linkedAccountId,
      amount: Number((a.amountPaise / 100).toFixed(2)),
    }));

    dim(
      `probing with ${rs(o.total_payable_paise)} and a split of ` +
        `${probeSplit.map((p) => `₹${p.amount}`).join(' + ')} ` +
        `(${((probeSplit[0]!.amount * 100) / o.total_payable_paise * 100).toFixed(1)}% of the order)`,
    );

    const probe = await cf('/orders', {
      order_id: probeId,
      order_amount: Number((o.total_payable_paise / 100).toFixed(2)),
      order_currency: 'INR',
      customer_details: { customer_id: `probe${Date.now()}`, customer_phone: '9999999999' },
      order_splits: probeSplit,
    });

    if (probe.status < 400) {
      line(`${GREEN}Cashfree accepts this exact split.${OFF}`);
      dim('Same amount, same allocation, same vendor as the real order — so a');
      dim('502 on payment-intent is not the split. What differs is order_meta');
      dim('and the order id; check the API log for the cashfree line.');
    } else {
      line(`${RED}Cashfree refuses a split to this vendor:${OFF}`);
      dim(probe.text.slice(0, 400));
      dim('');
      if (/vendor/i.test(probe.text)) {
        dim('This is the VENDOR, not our code — and the status above says why.');
        dim('');
        dim('BANK_VALIDATION_FAILED means Cashfree rejected the test bank');
        dim('details, so the account never became a valid payee. Delete the');
        dim('stall\'s linked account and re-run split:setup to mint a fresh one:');
        dim('');
        dim('  UPDATE vendor SET provider_linked_account_id = NULL,');
        dim("         settlement_mode = 'VENDOR_DIRECT'");
        dim('   WHERE name = \'...\';');
        dim('');
        dim('Splits are fixed at order creation, so an existing order cannot');
        dim('pick up a new vendor — place a new one.');
      } else {
        dim('Their message names the field. Nothing above this line is at fault:');
        dim('the order priced correctly and buildSplit produced an allocation.');
      }
    }

    // -----------------------------------------------------------------------
    step('2c. The REAL provider, with the REAL payload');
    // -----------------------------------------------------------------------
    /*
     * ======================================================================
     * NO REPRODUCTION GAP AT ALL
     * ======================================================================
     *
     * Step 2b hand-builds a request, and hand-built requests keep being wrong
     * in ways that clear payloads nobody sends. First it used ₹1 and a 50%
     * split against a real order of ₹210.13 at 94.7%. Fixing that left three
     * more differences: no `order_meta`, no `x-idempotency-key` header, and a
     * `customer_id` of `probe…` where the application sends `order_<uuid>`.
     *
     * Each round of narrowing the gap costs a round trip and answers a
     * question about the probe. So this stops narrowing and calls
     * `buildPaymentProvider(cfg).createIntent()` — the exact function
     * `payment.repository` calls, assembling the exact body, with the exact
     * headers.
     *
     * The ONLY difference left is the order id, because Cashfree refuses a
     * duplicate and the real one may already exist. Earlier orders proved a
     * UUID order id is accepted, so that difference is known-safe — unlike the
     * four this replaces, which were assumed safe and were not.
     *
     * Nothing is caught. If Cashfree refuses, the AppError and the
     * `cashfree rejected a request` log line arrive together, which is the
     * 502's cause stated in Cashfree's own words.
     */
    const provider = buildPaymentProvider(cfg);
    const probeOrderId = `probe-${o.id}`;

    try {
      const intent = await provider.createIntent({
        orderId: probeOrderId,
        vendorId: 'diagnostic',
        amountPaise: paise(o.total_payable_paise),
        correlationId: `diagnose-split-${Date.now()}`,
        split: {
          ...decision.split,
          orderId: probeOrderId,
          transferId: `split-${probeOrderId}`,
        },
      });
      line(`${GREEN}createIntent SUCCEEDED with the real payload.${OFF}`);
      dim(`providerOrderRef ${intent.providerOrderRef}`);
      dim('');
      dim('So the 502 was NOT the payload. The remaining suspects are the order');
      dim('id itself — an earlier attempt may have left one at Cashfree — or the');
      dim('API running older code than this script. Restart it and place a new');
      dim('order.');
    } catch (e) {
      line(`${RED}createIntent threw — this is the 502.${OFF}`);
      dim(String(e instanceof Error ? e.message : e));
      dim('');
      dim('The `cashfree rejected a request` log line just above carries their');
      dim('verbatim complaint, including which field they did not like.');
    }

    // -----------------------------------------------------------------------
    step('2d. Is a POISONED IDEMPOTENCY KEY replaying an old failure?');
    // -----------------------------------------------------------------------
    /*
     * ======================================================================
     * THE LAST STRUCTURAL DIFFERENCE, AND A REAL PRODUCT BUG EITHER WAY
     * ======================================================================
     *
     * `createIntent` sends `x-idempotency-key: <orderId>` — the order id, and
     * nothing else. Cashfree answers a reused key by REPLAYING THE CACHED
     * RESPONSE rather than re-running the request, and a cached response can
     * be a FAILURE.
     *
     * So if this order's very first payment attempt failed — and it would
     * have, because for a while this stall had no linked account at all and
     * then had one in BANK_VALIDATION_FAILED — that failure is welded to the
     * key. Every retry since replays it. The payload being fixed changes
     * nothing, which is exactly the shape of the last several rounds:
     *
     *   - the same body succeeds under a different key   (step 2c)
     *   - Cashfree has no record of the order            (step 3, 404)
     *   - the 502 never changes, whatever gets fixed
     *
     * This sends a request Cashfree would certainly accept, under the REAL
     * order's key. What comes back distinguishes the two cases:
     *
     *   an error   -> the key is poisoned, and its message is the ORIGINAL
     *                 failure, verbatim, from whenever it was first cached
     *   success    -> the key is clean; the 502 is not idempotency, and the
     *                 API log line is the only remaining source of truth
     *
     * NOTE THE BUG THIS EXPOSES REGARDLESS OF THE ANSWER. Keying on the order
     * id alone means one transient provider failure makes an order
     * permanently unpayable, with no way out but a new order — the customer
     * retries, sees the same 502 forever, and nothing in our logs suggests
     * why. The key needs an attempt component.
     */
    const idemProbeId = `idemprobe${Date.now()}`;
    const idemProbe = await cf(
      '/orders',
      {
        order_id: idemProbeId,
        order_amount: Number((o.total_payable_paise / 100).toFixed(2)),
        order_currency: 'INR',
        customer_details: {
          customer_id: `idem${Date.now()}`,
          customer_phone: '9999999999',
        },
        order_splits: decision.split.allocations.map((a) => ({
          vendor_id: a.linkedAccountId,
          amount: Number((a.amountPaise / 100).toFixed(2)),
        })),
      },
      // The REAL order's key — this is the whole point of the request.
      o.id,
    );

    if (idemProbe.status >= 400) {
      line(`${RED}The idempotency key for this order is POISONED.${OFF}`);
      dim(`HTTP ${idemProbe.status}`);
      dim(idemProbe.text.slice(0, 400));
      dim('');
      dim('That message is the ORIGINAL failure, replayed. It is what the customer');
      dim('has been getting as a 502 on every retry since, no matter what changed');
      dim('underneath — and it will keep replaying for as long as the key is the');
      dim('bare order id.');
    } else {
      line(`${GREEN}The key is clean — Cashfree ran this as a fresh request.${OFF}`);
      dim(`created ${idemProbeId}`);
      dim('');
      dim('So idempotency is not the 502 either. Every part of the request has now');
      dim('been cleared against the live sandbox, which leaves the API process:');
      dim('open its terminal and find the line `cashfree rejected a request`. It');
      dim("carries Cashfree's verbatim complaint, and nothing else does — the");
      dim('AppError deliberately drops it so it cannot reach a customer.');
    }

    // -----------------------------------------------------------------------
    step('3. What Cashfree actually recorded');
    // -----------------------------------------------------------------------
    /*
     * THE DECISIVE STEP. Everything above can be right while this is empty —
     * that is the exact bug this feature fixed, and the only way to know it
     * stayed fixed is to ask them.
     */
    const res = await cf(`/orders/${encodeURIComponent(o.id)}`);
    line(`HTTP ${res.status}   order_status = ${String(res.json['order_status'] ?? '(none)')}`);

    if (res.status === 404) {
      line(`${RED}Cashfree has never heard of this order.${OFF}`);
      dim('No payment intent was ever created for it — it was placed but not paid.');
      return;
    }

    const splits = res.json['order_splits'];
    const list = Array.isArray(splits) ? (splits as Record<string, unknown>[]) : [];

    if (list.length === 0) {
      line(`${RED}NO SPLITS ON THE ORDER AT CASHFREE.${OFF}`);
      dim('');
      dim('We built a split and it did not reach them. The whole payment will');
      dim("settle to the platform and the stall gets nothing — the exact silent");
      dim('failure this feature exists to end.');
      dim('');
      dim('Most likely: the order was created BEFORE the split was wired. Splits');
      dim('are declared at order creation and cannot be added afterwards, so');
      dim('check a NEW order before looking anywhere else.');
      return;
    }

    for (const s of list) {
      line(`  ${JSON.stringify(s)}`);
    }

    /*
     * Compare on AMOUNT, in paise. Cashfree returns rupees as a float and our
     * side is integer paise — `cashfree.money.ts` exists because that boundary
     * is where money goes missing, so the comparison happens in paise and the
     * float is converted once.
     */
    const theirTotal = list.reduce((n, s) => {
      const amt = s['amount'];
      return n + (typeof amt === 'number' ? Math.round(amt * 100) : 0);
    }, 0);
    const ourTotal = decision.split.allocations.reduce((n, a) => n + a.amountPaise, 0);

    dim('');
    if (theirTotal === ourTotal) {
      line(`${GREEN}Agreed: ${rs(ourTotal)} to the stall, ${rs(o.total_payable_paise - ourTotal)} to the platform.${OFF}`);
      dim('');
      dim('Settlement itself is on Cashfree\'s schedule and a sandbox vendor only');
      dim('goes ACTIVE about ten minutes after creation — so the transfer may');
      dim('still be pending. What this proves is that it is ROUTED.');
    } else {
      line(`${RED}DISAGREEMENT: we allocated ${rs(ourTotal)}, Cashfree holds ${rs(theirTotal)}.${OFF}`);
      dim('');
      dim('One of the two is wrong about somebody\'s money. Check the paise-to-');
      dim('rupee conversion first — that boundary is why cashfree.money.ts');
      dim('refuses more than two decimals rather than rounding.');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
