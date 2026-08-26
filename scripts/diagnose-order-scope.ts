/**
 * ============================================================================
 * WHO DOES THIS ORDER BELONG TO, AND WHO IS ASKING?
 * ============================================================================
 *
 *   npm run diagnose:scope
 *
 * THE SYMPTOM
 *
 *   { "code": "TENANT_SCOPE_VIOLATION", "message": "No such order" }
 *
 * That message is a 404 by PRD §16.3 — a distinguishable status would confirm
 * the order exists — and it is produced by exactly one comparison, in several
 * places:
 *
 *     order.customer_id  ===  the customer id inside the bearer token
 *
 * So it means one of two things, and they have completely different fixes:
 *
 *   A. the order belongs to a different customer row
 *   B. the token belongs to a different customer row
 *
 * No amount of reading the code distinguishes them, because both are correct
 * code operating on divergent data. Three theories were argued from the source
 * before this script existed — a NULL customer on the session, an expired
 * session silently skipping the bind, a stale idempotency key — and each was
 * plausible, each was cheap to disprove with one query, and none of them was
 * checked first.
 *
 * This prints the rows.
 *
 * ----------------------------------------------------------------------------
 * WHAT TO LOOK FOR
 * ----------------------------------------------------------------------------
 *
 * The most informative column is the LAST one: whether an order's customer
 * still matches the customer currently attached to the session that placed it.
 *
 * They diverge when somebody verifies a DIFFERENT phone number in the same
 * browser. `app_session.customer_id` is updated to the new customer; orders
 * already placed keep the old one. The token then holds the new customer, and
 * every earlier order becomes permanently unreachable to the person who placed
 * it — which is the tenancy rule working exactly as written, on data that moved
 * underneath it.
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

const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const DIM = '[2m';
const OFF = '[0m';

const step = (s: string): void => {
  process.stdout.write(`\n${BOLD}==> ${s}${OFF}\n`);
};
const line = (s: string): void => {
  process.stdout.write(`    ${s}\n`);
};
const dim = (s: string): void => {
  process.stdout.write(`    ${DIM}${s}${OFF}\n`);
};

const short = (id: string | null): string => (id ? id.slice(0, 8) : `${DIM}null${OFF}`);

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: config().DATABASE_URL }));

  try {
    // -----------------------------------------------------------------------
    step('Customers — one row per phone number ever verified');
    // -----------------------------------------------------------------------
    const customers = await db
      .selectFrom('customer')
      .select(['id', 'phone', 'display_name', 'created_at'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute();

    if (customers.length > 1) {
      dim(`${customers.length} customers exist. More than one means more than one PHONE`);
      dim('has been verified in this database — the usual source of a scope mismatch.');
    }
    line(`${'id'.padEnd(10)} ${'phone'.padEnd(18)} ${'name'.padEnd(14)} created`);
    for (const c of customers) {
      line(
        `${short(c.id).padEnd(10)} ${(c.phone ?? '').padEnd(18)} ` +
          `${(c.display_name ?? '—').slice(0, 12).padEnd(14)} ${c.created_at.toISOString().slice(0, 19)}`,
      );
    }

    // -----------------------------------------------------------------------
    step('Sessions — and the customer currently attached to each');
    // -----------------------------------------------------------------------
    const sessions = await db
      .selectFrom('app_session')
      .select(['id', 'customer_id', 'expires_at', 'created_at'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute();

    line(`${'session'.padEnd(10)} ${'customer'.padEnd(10)} ${'expires'.padEnd(21)} live?`);
    for (const s of sessions) {
      const live = s.expires_at.getTime() > Date.now();
      line(
        `${short(s.id).padEnd(10)} ${short(s.customer_id).padEnd(19)} ` +
          `${s.expires_at.toISOString().slice(0, 19)}  ${live ? `${GREEN}yes${OFF}` : `${RED}EXPIRED${OFF}`}`,
      );
    }
    dim('');
    dim('An EXPIRED session matters: OTP verify binds the customer with');
    dim("`where expires_at > now()`, and a zero-row UPDATE is silent — so");
    dim('verifying against a dead session leaves the customer unattached.');

    // -----------------------------------------------------------------------
    step('Orders — the comparison that produces "No such order"');
    // -----------------------------------------------------------------------
    /*
     * Joined to the session so the two customer ids sit side by side. That
     * adjacency IS the diagnosis: equal means the scope check will pass for
     * whoever holds that session's token, different means it cannot.
     */
    const orders = await sql<{
      id: string;
      status: string;
      created_at: Date;
      order_customer: string | null;
      session_customer: string | null;
      session_id: string;
      idempotency_key: string | null;
    }>`
      SELECT o.id,
             o.status::text                AS status,
             o.created_at,
             o.customer_id                 AS order_customer,
             s.customer_id                 AS session_customer,
             o.app_session_id              AS session_id,
             o.idempotency_key
        FROM "order" o
        LEFT JOIN app_session s ON s.id = o.app_session_id
       ORDER BY o.created_at DESC
       LIMIT 10
    `.execute(db);

    if (orders.rows.length === 0) {
      line(`${YELLOW}No orders exist.${OFF} Nothing can be scope-checked.`);
      return;
    }

    line(
      `${'order'.padEnd(10)} ${'status'.padEnd(18)} ${'order.cust'.padEnd(12)} ` +
        `${'sess.cust'.padEnd(12)} match`,
    );

    let mismatches = 0;
    for (const o of orders.rows) {
      const same = o.order_customer === o.session_customer;
      if (!same) mismatches++;
      line(
        `${short(o.id).padEnd(10)} ${o.status.padEnd(18)} ${short(o.order_customer).padEnd(12)} ` +
          `${short(o.session_customer).padEnd(21)} ${same ? `${GREEN}yes${OFF}` : `${RED}NO${OFF}`}`,
      );
    }

    // -----------------------------------------------------------------------
    step('Verdict');
    // -----------------------------------------------------------------------
    if (mismatches > 0) {
      line(`${RED}${mismatches} order(s) belong to a different customer than their session.${OFF}`);
      dim('');
      dim('This is the cause. Somebody verified a second phone number in the same');
      dim('browser: `app_session.customer_id` moved to the new customer, orders');
      dim('already placed kept the old one, and the token now holds the new one.');
      dim('');
      dim('Nothing is broken in the code — the tenancy rule is doing its job on');
      dim('data that moved underneath it. To get a clean run:');
      dim('  - verify with ONE phone number, and');
      dim('  - clear the site data for localhost:5173 (the basket persists the');
      dim('    idempotency key, which outlives the in-memory customer token).');
    } else {
      line(`${GREEN}Every order matches its session's customer.${OFF}`);
      dim('');
      dim('So the order rows are consistent, and "No such order" is coming from a');
      dim('token that is not either of these — most likely a checkout replayed a');
      dim('persisted idempotency key from BEFORE the current verification.');
      dim('');
      dim('Check the browser: Application -> Local Storage -> localhost:5173,');
      dim('the `foodcourt-cart` entry, field `idempotencyKey`. If it is set,');
      dim('it belongs to one of the orders above. Clearing that entry starts a');
      dim('clean checkout.');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
