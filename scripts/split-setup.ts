/**
 * ============================================================================
 * ONBOARD A STALL TO EASY SPLIT, SO IT CAN ACTUALLY BE PAID
 * ============================================================================
 *
 *   npm run split:setup                        # what every stall's status is
 *   npm run split:setup -- d621c98d-...        # onboard, by id
 *   npm run split:setup -- "Spice Garden"      # or by name
 *
 * WHY THIS EXISTS
 *
 * Under PLATFORM_COLLECT the customer pays Cashfree once and Easy Split routes
 * the stall its share to a LINKED ACCOUNT. No linked account, no route — and
 * `order.repository` now refuses to place an order at all in that state, so a
 * stall with no `cashfree_vendor_id` simply cannot trade.
 *
 * That refusal is deliberate and it is the reason this script exists. The
 * alternative was letting the payment succeed and quietly keeping the stall's
 * money, which is invisible on every screen and only shows up in a bank
 * statement weeks later. Refusing loudly means somebody has to do setup — so
 * the setup should be one command rather than a dashboard expedition.
 *
 * ----------------------------------------------------------------------------
 * WHAT IT DOES
 * ----------------------------------------------------------------------------
 *
 *   1. creates a vendor on Cashfree's Easy Split sandbox, with test KYC
 *   2. writes the returned id to `vendor.provider_linked_account_id`
 *   3. sets the stall's settlement mode to PLATFORM_COLLECT
 *
 * SANDBOX ONLY. It refuses to run against production, because creating payout
 * accounts with test bank details there is not a mistake worth making
 * available. Real onboarding is a KYC process, not a script.
 *
 * Cashfree moves a sandbox vendor to ACTIVE by itself after about ten minutes.
 * Until then it exists and can be referenced, which is enough to place and pay
 * for an order — the transfer is what waits.
 */

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
  process.stderr.write(
    `\n${RED}Refusing to run against production.${OFF}\n` +
      `This creates payout accounts with TEST bank details. Real vendor\n` +
      `onboarding is a KYC process and belongs in the Cashfree dashboard.\n\n`,
  );
  process.exit(1);
}

const BASE = 'https://sandbox.cashfree.com/pg';

/**
 * Cashfree's accepted `kyc_details.business_type` values, verbatim from the
 * error they return when you send anything else.
 *
 * Recorded here because the field looks like free text and is not, and because
 * a wrong value fails at vendor creation — long after somebody has decided the
 * script works. A food court is `Food and Beverages`; the rest are kept so the
 * next edit is a choice from a list rather than another guess.
 */
const BUSINESS_TYPES = [
  'Grocery',
  'Jewellery',
  'Miscellaneous',
  'Web host/Domain seller',
  'E-commerce',
  'Online Gaming',
  'Society/Trust/Club/Association',
  'Mutual funds/Broking',
  'B2B',
  'Real Estate',
  'Housing',
  'Rentals',
  'Utilities',
  'Travel and Hospitality',
  'Education',
  'Food and Beverages',
  'NBFCs',
] as const;

const BUSINESS_TYPE: (typeof BUSINESS_TYPES)[number] = 'Food and Beverages';

async function cf(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-version': cfg.CASHFREE_API_VERSION,
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

async function main(): Promise<void> {
  /*
   * JOINED, not `argv[2]`.
   *
   * `npm run split:setup -- "Spice Garden"` passes the quoted string through
   * intact, but a caller who omits the quotes gets two arguments and a stall
   * that does not match anything. Joining makes both spellings work, and a
   * stall name with a space is the normal case here rather than the exotic one.
   */
  const wanted = process.argv.slice(2).join(' ').trim() || undefined;

  const db = createDb(createPool({ connectionString: cfg.DATABASE_URL }));

  try {
    /*
     * The COURT comes along, because "which one is Spice Garden in" is the
     * next question after onboarding it — a customer only sees the stalls in
     * the court whose QR they scanned, so onboarding a stall in the wrong court
     * looks exactly like onboarding not working.
     */
    const stalls = await db
      .selectFrom('vendor')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'vendor.id as id',
        'vendor.name as name',
        'vendor.status as status',
        'vendor.settlement_mode as settlement_mode',
        'vendor.provider_linked_account_id as linked_account',
        'food_court.name as court',
      ])
      .where('vendor.status', '=', 'ACTIVE')
      .orderBy('food_court.name')
      .orderBy('vendor.name')
      .execute();

    // ---------------------------------------------------------------------
    if (!wanted) {
      step('Stalls, and whether they can take a split payment');
      // -------------------------------------------------------------------
      dim(
        `${'stall'.padEnd(20)} ${'court'.padEnd(16)} ${'mode'.padEnd(18)} payouts`,
      );
      for (const v of stalls) {
        const ready =
          v.settlement_mode !== 'PLATFORM_COLLECT'
            ? `${DIM}n/a${OFF}`
            : v.linked_account
              ? `${GREEN}${v.linked_account}${OFF}`
              : `${RED}NOT ONBOARDED${OFF}`;
        line(
          `${v.name.slice(0, 18).padEnd(20)} ${v.court.slice(0, 14).padEnd(16)} ` +
            `${(v.settlement_mode ?? '(none)').padEnd(18)} ${ready}`,
        );
      }

      const blocked = stalls.filter(
        (v) => v.settlement_mode === 'PLATFORM_COLLECT' && !v.linked_account,
      );

      dim('');
      if (blocked.length > 0) {
        line(
          `${RED}${blocked.length} stall(s) cannot take orders${OFF} — PLATFORM_COLLECT ` +
            `with no linked account.`,
        );
        dim('');
        dim('Onboard one with:');
        dim(`  npm run split:setup -- "${blocked[0]!.name}"`);
      } else {
        line(`${GREEN}Every PLATFORM_COLLECT stall has a linked account.${OFF}`);
        dim('Place an order and pay, then: npm run diagnose:split');
      }
      return;
    }

    // ---------------------------------------------------------------------
    /*
     * BY ID OR BY NAME.
     *
     * The id is what the listing prints and what a script would use; the name
     * is what a person can actually type from memory. Accepting both costs one
     * comparison and removes the step where somebody copies a UUID wrong — or,
     * as happened, pastes the placeholder from the instructions verbatim and
     * gets a shell parse error.
     *
     * Case-insensitive, because "spice garden" is the same stall.
     */
    const needle = wanted.trim().toLowerCase();
    const matches = stalls.filter(
      (v) => v.id === wanted || v.name.toLowerCase() === needle,
    );

    if (matches.length === 0) {
      line(`${RED}No active stall matching "${wanted}".${OFF}`);
      dim('Run without arguments to list them.');
      process.exit(1);
    }
    if (matches.length > 1) {
      // Two stalls sharing a name is legitimate across courts. Refuse rather
      // than pick, and print the ids so the next attempt is unambiguous.
      line(`${RED}"${wanted}" matches ${matches.length} stalls.${OFF} Use an id:`);
      for (const m of matches) dim(`  ${m.id}  ${m.name}`);
      process.exit(1);
    }
    const stall = matches[0]!;

    step(`Onboarding ${stall.name}`);
    // ---------------------------------------------------------------------
    if (stall.linked_account) {
      line(`${YELLOW}Already linked to ${stall.linked_account}.${OFF}`);
      dim('Nothing to do. Delete the id from the database first if you want a new one.');
      return;
    }

    /*
     * A vendor id WE choose, derived from the stall.
     *
     * Cashfree accepts a merchant-supplied id and uses it as the payee handle
     * in `order_splits`. Deriving it from our own id means the mapping is
     * recoverable from either side without a lookup table, and re-running this
     * script for the same stall produces the same id rather than a second
     * account.
     *
     * Hyphens stripped: every id in Cashfree's own examples is alphanumeric,
     * and a UUID's hyphens are not worth discovering a limit about later.
     */
    const vendorId = `stall${stall.id.replace(/-/g, '').slice(0, 24)}`;

    /*
     * TEST KYC AND TEST BANK DETAILS. These are Cashfree's documented sandbox
     * values — they are not anybody's real account, and this script refuses to
     * run against production precisely so they cannot become one.
     */
    const payload = {
      vendor_id: vendorId,
      status: 'ACTIVE',
      name: stall.name,
      email: `stall-${vendorId}@example.com`,
      phone: '9999999999',
      verify_account: false,
      dashboard_access: false,
      // 1 = standard settlement cycle. The stall's money moves on Cashfree's
      // normal schedule rather than being held.
      schedule_option: 1,
      bank: {
        account_number: '00001111222233',
        account_holder: stall.name,
        ifsc: 'HDFC0000001',
      },
      kyc_details: {
        account_type: 'Proprietorship',
        /*
         * "Food and BeverageS", plural, and from Cashfree's own allow-list.
         *
         * The singular was sent first and refused with INVALID_REQUEST_TYPE —
         * their error helpfully enumerated every accepted value, which is why
         * this script prints their message verbatim rather than paraphrasing
         * it into "Cashfree rejected the request".
         *
         * Not a free-text field. `BUSINESS_TYPES` below is their list, kept so
         * the next person changing this picks from it rather than guessing a
         * plausible-sounding string.
         */
        business_type: BUSINESS_TYPE,
        pan: 'ABCPV1234D',
      },
    };

    let res = await cf('POST', '/easy-split/vendors', payload);
    line(`HTTP ${res.status}`);

    /*
     * ======================================================================
     * "ALREADY EXISTS" IS A SUCCESS, NOT A FAILURE
     * ======================================================================
     *
     * `vendorId` is DERIVED from the stall id, deliberately — so re-running
     * this proposes the same id rather than a second account. That is the
     * property that makes retrying safe, and the first version threw it away
     * by treating Cashfree's rejection as fatal.
     *
     * It bit immediately. The first run created the vendor at Cashfree and
     * then failed on the local UPDATE (a check constraint), leaving the vendor
     * live at Cashfree and unknown here — the one state a retry has to be able
     * to fix. The retry hit "vendoralready exists" and stopped, so the stall
     * was permanently stuck: the id it needed existed and nothing would write
     * it down.
     *
     * A create that fails because the thing is already created has achieved
     * what it was called for. It is CONFIRMED rather than assumed — a GET,
     * because "already exists" from a message we did not write deserves less
     * trust than a 200 from a resource we then read.
     */
    if (res.status >= 400 && /already\s*exists/i.test(res.text)) {
      line(`${YELLOW}Cashfree already has this vendor. Confirming, then saving.${OFF}`);
      const existing = await cf('GET', `/easy-split/vendors/${encodeURIComponent(vendorId)}`);
      if (existing.status < 400) {
        line(`${GREEN}Confirmed ${vendorId}.${OFF}`);
        dim(`status ${String(existing.json['status'] ?? '(none)')}`);
        res = existing;
      } else {
        line(`${RED}It says the vendor exists but will not return it.${OFF}`);
        dim(existing.text.slice(0, 300));
        dim('');
        dim('That usually means the id belongs to a DIFFERENT merchant account —');
        dim('check the dashboard is on the same Test credentials as .env.');
        process.exit(1);
      }
    } else if (res.status >= 400) {
      line(`${RED}Cashfree refused.${OFF}`);
      dim(res.text.slice(0, 500));
      dim('');
      dim('Their message names the field it did not like. Nothing was written');
      dim('to the database, so it is safe to fix and re-run.');
      dim('');
      dim('If it says Easy Split is not enabled: turn it on in the dashboard');
      dim('under Payment Gateway -> Easy Split, with the toggle on Test.');
      process.exit(1);
    }

    line(`${GREEN}Created ${vendorId}.${OFF}`);
    dim(`status ${String(res.json['status'] ?? '(none)')}`);

    /*
     * Written AFTER Cashfree confirms. The other order — save first, call
     * second — leaves a stall pointing at an account that does not exist, and
     * every order it takes would then be refused at `buildSplit` with an error
     * about onboarding that had apparently already happened.
     */
    await db
      .updateTable('vendor')
      .set({ provider_linked_account_id: vendorId, settlement_mode: 'PLATFORM_COLLECT' })
      .where('id', '=', stall.id)
      .execute();

    line(`${GREEN}Saved to the stall, and set it to PLATFORM_COLLECT.${OFF}`);
    dim(`Order from ${stall.name} in ${stall.court} — a customer only sees the`);
    dim('stalls in the court whose QR they scanned.');
    dim('');
    dim('Sandbox vendors go ACTIVE by themselves after about ten minutes. The');
    dim('stall can take orders now — it is the transfer that waits.');
    dim('');
    dim(`${BOLD}Next:${OFF} place an order, pay it, then run:`);
    dim('  npm run diagnose:split');
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
