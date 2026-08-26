/**
 * ============================================================================
 * WHY DID payment-intent RETURN 500?
 * ============================================================================
 *
 *   npm run diagnose:cashfree
 *
 * THE SYMPTOM THIS EXISTS FOR
 *
 *   POST /api/v1/orders/:id/payment-intent
 *   -> { "code": "INTERNAL", "message": "Something went wrong on our side.",
 *        "correlationId": "…" }
 *
 * `INTERNAL` is the catch-all the HTTP filter uses for an exception nothing
 * else claimed. By design it says only THAT something threw — the stack goes to
 * the server log, and the correlation id is the thread between them.
 *
 * That is right for a customer and useless for a developer standing in front of
 * it, because finding the answer means grepping a terminal that may already
 * have scrolled. Twice now the reply to this error has been "please find the
 * log line", which is a diagnosis outsourced rather than made.
 *
 * So this reproduces the call with NOTHING CAUGHT, in layers, so the first
 * layer that throws is the answer:
 *
 *   1. configuration        — is Cashfree even selected, with what keys
 *   2. the database         — are migrations 17 and 18 in, do stalls have modes
 *   3. the provider alone   — createIntent against the real sandbox
 *   4. the whole engine     — the real PaymentRepository against a real order
 *
 * Layer 3 passing and layer 4 failing means the fault is ours, not Cashfree's.
 * That single bit is most of the debugging.
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
import { paise } from '../src/platform/money.js';
import { buildPaymentProvider } from '../src/payments/provider.factory.js';

const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const DIM = '[2m';
const OFF = '[0m';

const step = (s: string): void => {
  process.stdout.write(`\n${BOLD}==> ${s}${OFF}\n`);
};
const ok = (s: string): void => {
  process.stdout.write(`    ${GREEN}ok${OFF}    ${s}\n`);
};
const bad = (s: string): void => {
  process.stdout.write(`    ${RED}FAIL${OFF}  ${s}\n`);
};
const warn = (s: string): void => {
  process.stdout.write(`    ${YELLOW}warn${OFF}  ${s}\n`);
};
const dim = (s: string): void => {
  process.stdout.write(`    ${DIM}${s}${OFF}\n`);
};

async function main(): Promise<void> {
  const cfg = config();

  // -------------------------------------------------------------------------
  step('1. Configuration');
  // -------------------------------------------------------------------------
  dim(`PAYMENTS_PROVIDER    ${cfg.PAYMENTS_PROVIDER}`);
  dim(`CASHFREE_ENV         ${cfg.CASHFREE_ENV}`);
  dim(`CASHFREE_API_VERSION ${cfg.CASHFREE_API_VERSION}`);
  dim(`PUBLIC_BASE_URL      ${cfg.CASHFREE_PUBLIC_BASE_URL ?? '(unset — no webhooks, polling only)'}`);

  if (cfg.PAYMENTS_PROVIDER !== 'cashfree') {
    warn(`PAYMENTS_PROVIDER is "${cfg.PAYMENTS_PROVIDER}", so Cashfree is not in use.`);
    dim('Set PAYMENTS_PROVIDER=cashfree in .env if that is what you meant to test.');
  }
  if (!cfg.CASHFREE_APP_ID || !cfg.CASHFREE_SECRET_KEY) {
    bad('CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not both set.');
    dim('With PAYMENTS_PROVIDER=cashfree the API refuses to boot, so this is likely the cause.');
    process.exit(1);
  }
  ok('credentials are present');

  const db = createDb(createPool({ connectionString: cfg.DATABASE_URL }));

  try {
    // -----------------------------------------------------------------------
    step('2. The database');
    // -----------------------------------------------------------------------
    /*
     * Migrations first, because a missing column throws inside a query the
     * stack trace blames on the repository — which sends you reading the wrong
     * file. `cashfree_vendor_id` arrived in migration 18; if that has not run,
     * every SELECT naming it fails and the error is a Postgres one, not a
     * Cashfree one.
     */
    const applied = await db
      .selectFrom('schema_migrations')
      .select('version')
      .orderBy('version')
      .execute();
    const versions = new Set(applied.map((r) => r.version));

    for (const [v, what] of [
      ['20260821000017', 'ai_descriptions'],
      ['20260822000018', 'cashfree_accounts'],
    ] as const) {
      if (versions.has(v)) ok(`migration ${v} ${what} applied`);
      else {
        bad(`migration ${v} ${what} NOT applied — run: npm run migrate:up`);
        dim('A query naming a column that does not exist throws, and the trace');
        dim('blames the repository rather than the missing migration.');
      }
    }

    const vendors = await db
      .selectFrom('vendor')
      .select(['id', 'name', 'status', 'settlement_mode', 'provider_linked_account_id'])
      .where('status', '=', 'ACTIVE')
      .limit(10)
      .execute();

    dim('');
    dim('stall                    settlement_mode    cashfree_vendor_id');
    for (const v of vendors) {
      dim(
        `${v.name.slice(0, 22).padEnd(24)} ${(v.settlement_mode ?? '(null)').padEnd(18)} ` +
          `${v.provider_linked_account_id ?? '(null)'}`,
      );
    }

    const noMode = vendors.filter((v) => !v.settlement_mode);
    if (noMode.length > 0) {
      bad(`${noMode.length} active stall(s) have no settlement_mode.`);
      dim('order.repository refuses placement for those: "Vendor has no settlement mode".');
      dim("That throws RECONCILIATION_REQUIRED, which is a 409 — not this 500 — but it");
      dim('stops the order before an intent is ever created.');
    } else {
      ok('every active stall has a settlement mode');
    }

    // -----------------------------------------------------------------------
    step('3. The provider, on its own, against the real sandbox');
    // -----------------------------------------------------------------------
    /*
     * THROUGH THE FACTORY, not a hand-built copy.
     *
     * This constructed `CashfreePaymentProvider` itself, with a comment
     * claiming it was "built exactly as `payment.module.ts` builds it". That
     * claim was true when written and stopped being true the moment
     * `returnBaseUrl` was added — this script kept passing the old option set,
     * so it would have created orders WITH a return url missing while the app
     * created them with one, and a diagnostic that disagrees with the
     * application is worse than no diagnostic.
     *
     * `buildPaymentProvider` is the single place that decision lives, which is
     * exactly why it exists (see its own header: the worker used to hardcode
     * the stub for the same reason). Nothing is caught: if Cashfree refuses,
     * the AppError and the `cashfree rejected a request` log line arrive
     * together.
     */
    const provider = buildPaymentProvider(cfg);

    const fakeOrderId = `diag-${Date.now()}`;
    try {
      const intent = await provider.createIntent({
        orderId: fakeOrderId,
        vendorId: vendors[0]?.id ?? 'no-vendor',
        amountPaise: paise(100),
        correlationId: `diag-${Date.now()}`,
      });
      ok('createIntent succeeded — the provider and your credentials are fine');
      dim(`providerOrderRef  ${intent.providerOrderRef}`);
      dim(
        `paymentSessionId  ${String(intent.checkoutPayload['paymentSessionId'] ?? '').slice(0, 24)}…`,
      );
      dim('');
      dim('So the 500 is NOT the Cashfree call. It is the engine or the database');
      dim('around it — step 4 exercises that.');
    } catch (e) {
      bad('createIntent threw. This is the cause of the 500.');
      dim(String(e));
      dim('');
      dim('The `cashfree rejected a request` line just above (if present) carries');
      dim("Cashfree's own words, including which field it did not like.");
      throw e;
    }

    // -----------------------------------------------------------------------
    step('4. The whole engine, against a real order');
    // -----------------------------------------------------------------------
    const order = await db
      .selectFrom('order')
      .select(['id', 'status', 'total_payable_paise', 'vendor_id'])
      .where('status', 'in', ['CREATED', 'PAYMENT_PENDING'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (!order) {
      /*
       * ====================================================================
       * NO PENDING ORDER IS ITSELF THE ANSWER, NOT A MISSING PRECONDITION
       * ====================================================================
       *
       * The first version of this just said "place one and re-run", which
       * wastes a round trip on the most informative outcome available.
       *
       * The checkout does two calls in sequence:
       *
       *     POST /orders                  -> creates the order row
       *     POST /orders/:id/payment-intent
       *
       * If the SECOND were failing, the row from the first would be sitting
       * right here in CREATED or PAYMENT_PENDING. An empty result means
       * placement never got that far — so the 500 is the FIRST call, and
       * Cashfree is not involved in it at all.
       */
      warn('No order is waiting for payment — and that is the finding.');
      dim('');

      const recent = await db
        .selectFrom('order')
        .select(['id', 'status', 'created_at', 'total_payable_paise'])
        .orderBy('created_at', 'desc')
        .limit(5)
        .execute();

      if (recent.length === 0) {
        bad('There are NO orders in this database at all.');
        dim('');
        dim('So POST /api/v1/orders is what returns 500, not the payment intent.');
        dim('Cashfree is not reached during placement — steps 1-3 above already');
        dim('proved the provider works, and it plays no part in creating the row.');
        dim('');
        dim('Look for the failure in the ORDER path, not the payment path:');
        dim('  src/ordering/order.controller.ts   the endpoint');
        dim('  src/ordering/order.repository.ts   pricing, ledger, the transaction');
        dim('');
        dim('Most likely, given this database was restored from a partial dump:');
        dim('  - the fee_rule rows did not survive, so pricing finds no rule');
        dim('  - the court/session rows are inconsistent with the vendor rows');
      } else {
        dim('most recent orders, any status:');
        for (const o of recent) {
          dim(
            `  ${o.created_at.toISOString().slice(0, 19)}  ${String(o.status).padEnd(20)} ` +
              `₹${(o.total_payable_paise / 100).toFixed(2)}`,
          );
        }
        dim('');
        dim('Orders exist but none is awaiting payment, so placement works and the');
        dim('intent either succeeded or was never reached. Place a fresh one and');
        dim('re-run this immediately.');
      }

      // The pricing inputs placement depends on. Cheap to check, and the usual
      // casualty of a restore that dropped rows on foreign-key violations.
      const fees = await db
        .selectFrom('fee_rule')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();
      const courts = await db
        .selectFrom('food_court')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();
      const sessions = await db
        .selectFrom('app_session')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();

      dim('');
      dim(`fee_rule rows     ${fees?.n ?? '0'}`);
      dim(`food_court rows   ${courts?.n ?? '0'}`);
      dim(`app_session rows  ${sessions?.n ?? '0'}`);
      if (Number(fees?.n ?? 0) === 0) {
        bad('No fee rules. Pricing resolves most-specific-wins and finds nothing.');
        dim('Re-seed with: npm run seed:dev');
      }
      return;
    }

    dim(`order ${order.id}  status=${order.status}  ₹${(order.total_payable_paise / 100).toFixed(2)}`);

    const { PaymentRepository } = await import('../src/payments/payment.repository.js');
    const repo = new PaymentRepository(db, provider, {
      splitTiming: cfg.PAYMENTS_SPLIT_TIMING,
      intentTtlSeconds: 15 * 60,
    });

    try {
      const result = await repo.createIntent({
        orderId: order.id,
        correlationId: `diag-${Date.now()}`,
      });
      ok('the engine created an intent too — the 500 is not reproducible here');
      dim(`payment ${result.paymentId}  created=${String(result.created)}`);
      dim('');
      dim('If the app still 500s, the difference is the request context: the');
      dim('customer guard, the session, or the order belonging to another session.');
    } catch (e) {
      bad('the ENGINE threw where the provider did not. The fault is ours.');
      dim(String(e));
      if (e instanceof Error && e.stack) {
        dim('');
        for (const line of e.stack.split('\n').slice(1, 8)) dim(line.trim());
      }
      throw e;
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${BOLD}The failure above is the cause.${OFF}\n`);
  process.stderr.write(`${DIM}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
