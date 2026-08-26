/**
 * Why did this order never reach the kitchen?
 *
 * THE SYMPTOM THIS EXISTS FOR
 *
 *   the customer sees "Payment successful"
 *   the tracking screen then says "Payment not completed"
 *   the stall never gets a ticket
 *
 * Those three are consistent with exactly one state: the PAYMENT row reached
 * AUTHORIZED and the ORDER row never left PAYMENT_PENDING. They are updated in
 * one transaction, so that combination should be impossible — which means
 * something else wrote the payment row afterwards, and the transaction that was
 * meant to move the order threw.
 *
 * Reading the code did not find it. Four separate seams all looked correct, and
 * a fifth guess would have been a fifth guess. This prints the actual rows and
 * then REPLAYS the webhook against the real ingestion path with the error
 * uncaught, so the failure names itself.
 *
 *   npm run diagnose:payment              # the most recent stuck order
 *   npm run diagnose:payment <order-id>   # a specific one
 *
 * Read-only except for the replay, which is guarded — see `--replay`.
 */

import { createDb, createPool } from '../src/platform/db.js';

const db = createDb(createPool({ connectionString: process.env['DATABASE_URL'] ?? '' }));

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

function head(s: string): void {
  console.log(`\n${BOLD}${s}${OFF}\n${'─'.repeat(74)}`);
}

async function main(): Promise<void> {
  const argId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;

  /**
   * "Stuck" means paid for and not dispatched.
   *
   * Deliberately not "the newest order" — that would pick up an order somebody
   * is mid-way through placing and report it as broken.
   */
  const order = argId
    ? await db.selectFrom('order').selectAll().where('id', '=', argId).executeTakeFirst()
    : await db
        .selectFrom('order')
        .selectAll()
        .where('status', 'in', ['CREATED', 'PAYMENT_PENDING'])
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

  if (!order) {
    console.log(
      `\n${GREEN}No order is sitting in CREATED or PAYMENT_PENDING.${OFF}\n` +
        `Either nothing is stuck, or the order you mean already moved on.\n` +
        `Pass an id explicitly to look at a specific one.\n`,
    );
    await db.destroy();
    return;
  }

  head(`ORDER ${order.public_order_number}`);
  console.log(`  id            ${order.id}`);
  console.log(`  status        ${order.status === 'PAYMENT_CONFIRMED' ? GREEN : YELLOW}${order.status}${OFF}`);
  console.log(`  placed        ${order.created_at.toISOString()}`);
  console.log(`  total         ₹${(order.total_payable_paise / 100).toFixed(2)}`);
  console.log(`  vendor        ${order.vendor_id}`);

  // ---------------------------------------------------------------- payments
  const payments = await db
    .selectFrom('payment')
    .selectAll()
    .where('order_id', '=', order.id)
    .orderBy('created_at', 'asc')
    .execute();

  head(`PAYMENT ROWS (${payments.length})`);
  if (payments.length === 0) {
    console.log(`  ${RED}none — the intent was never created${OFF}`);
  }
  for (const p of payments) {
    const paid = p.status === 'AUTHORIZED' || p.status === 'CAPTURED';
    console.log(`  ${paid ? GREEN : YELLOW}${p.status.padEnd(24)}${OFF} ${p.id}`);
    console.log(`    order ref     ${p.provider_order_ref ?? DIM + 'null' + OFF}`);
    console.log(`    payment ref   ${p.provider_payment_ref ?? DIM + 'null' + OFF}`);
    console.log(`    authorized_at ${p.authorized_at?.toISOString() ?? DIM + 'null' + OFF}`);
    console.log(`    expires_at    ${p.expires_at?.toISOString() ?? DIM + 'null' + OFF}`);
  }

  /**
   * THE DIAGNOSIS THAT MATTERS.
   *
   * A payment in AUTHORIZED under an order in PAYMENT_PENDING cannot be
   * produced by the webhook path, because that path writes both in one
   * transaction. It CAN be produced by `refreshFromProvider`, which polls the
   * provider and — correctly — updates only the payment row, leaving the order
   * to the signed webhook.
   *
   * So this combination is proof that the webhook transaction threw.
   */
  const authorised = payments.find((p) => p.status === 'AUTHORIZED' || p.status === 'CAPTURED');
  const stuck = authorised && (order.status === 'PAYMENT_PENDING' || order.status === 'CREATED');

  if (stuck) {
    head('DIAGNOSIS');
    console.log(
      `  ${RED}The payment is ${authorised.status} and the order is ${order.status}.${OFF}\n\n` +
        `  Those are written in ONE transaction by the webhook path, so this pair\n` +
        `  cannot come from a webhook that succeeded. It comes from:\n\n` +
        `    1. the webhook transaction throwing and rolling back, then\n` +
        `    2. the payment screen polling GET /payment, which calls\n` +
        `       refreshFromProvider — that asks the provider, sees AUTHORIZED,\n` +
        `       and writes it to the payment row ALONE, by design.\n\n` +
        `  Which is also why the customer saw "Payment successful": that screen\n` +
        `  was reading the provider's opinion, not the order's state.\n`,
    );
  }

  // ------------------------------------------------------------ webhook trail
  const events = await db
    .selectFrom('processed_event')
    .selectAll()
    .where('order_id', '=', order.id)
    .orderBy('received_at', 'asc')
    .execute();

  head(`WEBHOOKS RECEIVED (${events.length})`);
  if (events.length === 0) {
    console.log(
      `  ${RED}none.${OFF} No webhook ever arrived for this order, so nothing\n` +
        `  could have advanced it. In development that means the simulate call\n` +
        `  never fired or failed before reaching ingestWebhook.`,
    );
  }
  for (const e of events) {
    console.log(`  ${(e.event_type ?? 'unknown').padEnd(28)} ${e.provider_event_id}`);
    console.log(`    received      ${e.received_at.toISOString()}`);
  }

  /**
   * `processed_event` is the claim, not the outcome.
   *
   * The row is inserted BEFORE the decision is applied, so its presence proves
   * the webhook was received and deduplicated — not that it worked. A claim
   * with no corresponding order movement is the signature of a rollback, and
   * it is also why a retry will now be dropped as a duplicate.
   */
  if (events.length > 0 && stuck) {
    console.log(
      `\n  ${YELLOW}A webhook WAS received and the order still did not move.${OFF}\n` +
        `  The claim row is written before the decision is applied, so it\n` +
        `  survives the rollback — which means a retry of the same event will\n` +
        `  now be DROPPED as a duplicate. That is why tapping Pay again does\n` +
        `  nothing.`,
    );
  }

  // --------------------------------------------------------------- transitions
  const history = await db
    .selectFrom('order_status_history')
    .selectAll()
    .where('order_id', '=', order.id)
    .orderBy('created_at', 'asc')
    .execute();

  head(`STATUS HISTORY (${history.length})`);
  for (const h of history) {
    console.log(
      `  ${(h.from_status ?? '—').padEnd(20)} → ${String(h.to_status).padEnd(20)} ${DIM}${h.actor_type}${OFF}`,
    );
  }

  // ----------------------------------------------------------------- dispatch
  const attempts = await db
    .selectFrom('dispatch_attempt')
    .selectAll()
    .where('order_id', '=', order.id)
    .execute();

  head(`DISPATCH ATTEMPTS (${attempts.length})`);
  if (attempts.length === 0) {
    console.log(
      `  ${DIM}none — expected, since dispatch only runs once an order is\n` +
        `  PAYMENT_CONFIRMED. This is a consequence, not the cause.${OFF}`,
    );
  }
  for (const a of attempts) console.log(`  ${a.outcome} at ${a.sent_at.toISOString()}`);

  // ------------------------------------------------------------------- replay
  head('NEXT STEP');

  if (!stuck) {
    console.log(`  Nothing looks stuck in the way this script was written to find.`);
    await db.destroy();
    return;
  }

  console.log(
    `  To see the actual error, replay the webhook with the exception\n` +
      `  uncaught. This writes a NEW event id so the duplicate claim above\n` +
      `  does not swallow it:\n\n` +
      `    ${BOLD}npm run diagnose:payment ${order.id} -- --replay${OFF}\n\n` +
      `  ${DIM}Development only. It forges a stub-provider webhook, exactly as\n` +
      `  the Pay screen does, and prints the stack rather than a 500.${OFF}`,
  );

  if (process.argv.includes('--replay')) {
    head('REPLAY');

    const { StubPaymentProvider } = await import('../src/payments/providers/stub.provider.js');
    const { PaymentRepository } = await import('../src/payments/payment.repository.js');

    const provider = new StubPaymentProvider({ secret: process.env['PAYMENT_WEBHOOK_SECRET'] ?? 'dev-secret' });
    const repo = new PaymentRepository(db, provider, {
      splitTiming: (process.env['PAYMENTS_SPLIT_TIMING'] as 'ON_ACKNOWLEDGED') ?? 'ON_ACKNOWLEDGED',
      intentTtlSeconds: Number(process.env['PAYMENT_INTENT_TTL_SECONDS'] ?? 900),
    });

    const p = payments.at(-1);
    if (!p?.provider_order_ref) {
      console.log(`  ${RED}No provider reference to replay against.${OFF}`);
      await db.destroy();
      return;
    }

    provider.markAuthorized(p.provider_order_ref, {
      orderId: order.id,
      amountPaise: p.amount_paise as never,
    });

    const { rawBody, headers } = provider.signedWebhook({
      // A fresh id. The original claim row is already in processed_event and
      // would drop this as a duplicate — which is the whole reason retrying
      // from the UI does nothing.
      id: `evt_diag_${Date.now()}`,
      type: 'payment.authorized',
      orderId: order.id,
      paymentRef: p.provider_order_ref,
      amountPaise: p.amount_paise,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await repo.ingestWebhook(rawBody, headers);
      console.log(`  ${GREEN}It worked this time.${OFF}`);
      console.log(`  ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}`);
      console.log(
        `\n  ${YELLOW}That means the failure is intermittent or environmental —\n` +
          `  most likely the API restarted between the intent and the webhook,\n` +
          `  losing the stub provider's in-memory state.${OFF}`,
      );
    } catch (e) {
      console.log(`  ${RED}${BOLD}This is the error.${OFF}\n`);
      console.log(`  ${(e as Error).stack?.split('\n').join('\n  ')}`);
    }
  }

  await db.destroy();
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
