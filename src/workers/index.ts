/**
 * The worker process.
 *
 * Same image as the API, different CMD (`dist/workers/index.js`), so the two can
 * never drift to different code versions — Dockerfile and
 * docs/tech/infrastructure.md.
 *
 * WHY POLLING LOOPS AND NOT BULLMQ
 *
 * The infrastructure guide names BullMQ, and BullMQ needs Redis, and no Redis
 * client is installed. Writing the loops against Postgres now means:
 *
 *   - every sweep is a `FOR UPDATE SKIP LOCKED` query, which is correct across
 *     replicas today rather than correct-once-Redis-arrives;
 *   - the work is idempotent by construction, because a poll can always run
 *     twice — which is exactly the property a queue would have demanded anyway;
 *   - there is no window where the system depends on a queue that is not there.
 *
 * The honest cost is latency granularity: an escalation rung fires within one
 * tick of its due time rather than exactly on it. At a 1.5-second tick against
 * a 15-second first rung, that is a rounding error. When Redis lands, these
 * sweeps become the safety net that catches whatever the queue drops, rather
 * than the thing that gets deleted.
 */

import 'reflect-metadata';

import { ConfigError, loadConfig } from '../platform/config.js';
import { createDb, createPool } from '../platform/db.js';
import { rootLogger } from '../platform/logger.js';
import { sweepExpired } from '../platform/rate-limit.js';
import { DispatchRepository } from '../dispatch/dispatch.repository.js';
import { EscalationRepository } from '../dispatch/escalation.repository.js';
import { NotificationRepository } from '../notify/notification.repository.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { RefundRepository } from '../payments/refund.repository.js';
import { StockWatchRepository } from '../catalog/stock-watch.repository.js';
import { buildCustomerLadder, buildOpsLadder } from '../notify/channel.js';
import { PaymentRepository } from '../payments/payment.repository.js';
import { buildPaymentProvider } from '../payments/provider.factory.js';

/**
 * 1.5 seconds, and the number is derived rather than chosen.
 *
 * PRD §16.1 requires a new ticket to appear on the kitchen board in under five
 * seconds, and the board polls every three (§16.1 again). Dispatch latency is
 * therefore worst-case `TICK_MS + 3s`, which at the previous 5000ms was EIGHT
 * seconds — the configuration could not meet its own stated requirement, and
 * nothing would ever have reported that.
 *
 *   1.5s tick + 3s poll = 4.5s worst case, with 0.5s of margin.
 *
 * The sweeps are indexed queries against small working sets, so the cost of
 * running them more often is negligible next to being wrong about the one
 * number a cook actually experiences.
 */
const TICK_MS = 1_500;
/** Rate-limit windows and other housekeeping. No need to run this often. */
const HOUSEKEEPING_EVERY_TICKS = 120;

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      rootLogger.fatal({ event: 'config_invalid' }, e.message);
      process.exit(78);
    }
    throw e;
  }

  // Five, not ten. The worker's queries are short and the API needs the
  // headroom — Infra & Ops §4.1 budgets max_connections precisely.
  const pool = createPool({ connectionString: cfg.DATABASE_URL, max: 5 });
  const db = createDb(pool);

  const ladderConfig = {
    step1Seconds: cfg.DISPATCH_LADDER_STEP1_SECONDS,
    step2Seconds: cfg.DISPATCH_LADDER_STEP2_SECONDS,
    step3Seconds: cfg.DISPATCH_LADDER_STEP3_SECONDS,
    step4Seconds: cfg.DISPATCH_LADDER_STEP4_SECONDS,
  };

  const dispatch = new DispatchRepository(db, ladderConfig);
  const escalation = new EscalationRepository(db, dispatch, ladderConfig);
  const notifications = new NotificationRepository(db, buildCustomerLadder(cfg.NODE_ENV));
  /**
   * A second repository, not a second table.
   *
   * Same dedupe index, same claim-then-send ordering, same SKIPPED-with-a-reason
   * honesty — only the tiers and the recipient differ. Sharing the mechanism is
   * the point: the day DLT lands, the alert that wakes somebody up starts
   * working on the same commit as the one that tells a customer their food is
   * ready, rather than being a second integration nobody remembered to do.
   */
  const opsAlerts = new NotificationRepository(db, buildOpsLadder(cfg.NODE_ENV));
  const onCall = cfg.OPS_ONCALL_PHONE ?? null;

  if (onCall === null) {
    rootLogger.warn(
      { event: 'ops_oncall_unset' },
      'OPS_ONCALL_PHONE is not set: a stall that stops answering will alert nobody',
    );
  }

  /*
   * FROM CONFIG, like the API. This was `new StubPaymentProvider(...)`,
   * unconditionally — so with PAYMENTS_PROVIDER=cashfree the API talked to
   * Cashfree while this process, which owns refunds and capture, talked to a
   * stub. See `provider.factory.ts` for what that cost.
   */
  const provider = buildPaymentProvider(cfg);
  const payments = new PaymentRepository(db, provider, {
    splitTiming: cfg.PAYMENTS_SPLIT_TIMING,
    intentTtlSeconds: 15 * 60,
  });
  const refunds = new RefundRepository(db, provider, new AuditRepository(db));
  const stockWatches = new StockWatchRepository(db);

  let running = true;
  let ticks = 0;

  const shutdown = (signal: string): void => {
    rootLogger.info({ event: 'worker_shutdown_started', reason: signal }, 'finishing this tick');
    // Sets the flag rather than exiting. A worker killed mid-refund is
    // precisely the failure this system must not have — INF-03.
    running = false;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  rootLogger.info(
    { event: 'worker_started', tickMs: TICK_MS, ladder: ladderConfig },
    'worker running: dispatch, escalation, notifications, capture, refunds, payment expiry, stock watches',
  );

  while (running) {
    const started = Date.now();

    // Each sweep is wrapped individually. One failing must not stop the others
    // — a worker that dies on a bad row every tick is a worker that never runs
    // the sweeps after it, and the ladder is the last one in the list.
    await safely('dispatch', async () => {
      const pending = await dispatch.claimPending();
      for (const orderId of pending) {
        const result = await dispatch.dispatch(orderId, `worker:dispatch:${orderId}`);
        if (result.dispatched) {
          // Told only after the ticket is really in front of a kitchen. A
          // "confirmed, being prepared" message for an order no stall has seen
          // is a lie the customer acts on by sitting down and waiting.
          const req = await notifications.requestFor(
            orderId,
            'order.confirmed',
            `worker:dispatch:${orderId}`,
          );
          if (req) await notifications.notify(req);
        }
      }
    });

    /*
     * ======================================================================
     * PAYMENTS THE WEBHOOK NEVER RESOLVED
     * ======================================================================
     *
     * FIRST in the tick, before the ladder. The escalation ladder's job is to
     * chase orders the kitchen has not accepted; an order stuck in
     * PAYMENT_PENDING because a callback was lost is not that, and letting the
     * ladder escalate it would alert somebody about a stall that was never told
     * anything in the first place.
     *
     * Reconciling first means the ladder only ever sees orders that genuinely
     * reached a kitchen.
     */
    await safely('reconcile-payments', async () => {
      const { checked, advanced } = await payments.reconcileStalePayments();
      if (advanced > 0) {
        rootLogger.warn(
          { event: 'payments_reconciled', checked, advanced },
          'orders were confirmed by asking the provider — a webhook did not arrive',
        );
      }
    });

    await safely('escalation', async () => {
      const result = await escalation.sweep();
      if (result.escalated > 0 || result.dispatchFailed > 0) {
        rootLogger.info({ event: 'escalation_sweep', ...result }, 'ladder ran');
      }

      /**
       * Wake somebody up.
       *
       * `escalation_state.manager_alerted_at` has been written since the ladder
       * was built and read by nothing — a gap when there was a floor manager
       * who might see a screen, and a dead end now that nobody from the
       * platform is in the building. The stall is blocked at 90 seconds and the
       * order fails at 180, and until this existed no human learned either
       * fact.
       *
       * Failures do not stop the sweep. An alert that cannot be delivered is
       * bad; a ladder that stops running because an alert failed is worse — it
       * would leave the orders after this one un-escalated as well.
       */
      for (const orderId of result.alertedOrderIds) {
        const req = await opsAlerts.opsRequestFor(
          orderId,
          'ops.order_stuck',
          onCall,
          `ops:stuck:${orderId}`,
        );
        if (req) await opsAlerts.notify(req);
      }

      for (const orderId of result.failedOrderIds) {
        const req = await opsAlerts.opsRequestFor(
          orderId,
          'ops.dispatch_failed',
          onCall,
          `ops:failed:${orderId}`,
        );
        if (req) await opsAlerts.notify(req);
      }
    });

    await safely('ready_notifications', async () => {
      await notifyReady(db, notifications);
    });

    /**
     * Take the money the kitchen has committed to cooking.
     *
     * Under PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED the funds are blocked at
     * checkout and taken when a stall accepts. `captureOnAcknowledgement` was
     * written for exactly this and, until now, called by nothing — so every
     * order sat AUTHORIZED for ever: the customer's money blocked but never
     * taken, the block released by their bank days later, and the vendor paid
     * for none of it.
     *
     * A sweep rather than an inline call from the KDS controller, for two
     * reasons. It keeps `ordering` from importing `payments`, which the module
     * boundary rules refuse. And a capture that fails because the provider is
     * briefly unreachable must be retried rather than lost, which a sweep gets
     * for free and a request handler does not.
     */
    await safely('payment_capture', async () => {
      for (const orderId of await payments.claimCapturable()) {
        await payments.captureOnAcknowledgement(orderId, `worker:capture:${orderId}`);
      }
    });

    /**
     * Money owed back, opened and then chased.
     *
     * Two sweeps rather than one, because they fail differently. Opening a
     * refund is a local transaction that either commits or does not. Executing
     * one is a third-party call that can time out, half-succeed, or need five
     * attempts over two hours — REF-03's schedule exists precisely because a
     * refund is never allowed to silently stop being attempted.
     *
     * State-driven, so a stall rejecting an order and a customer accepting the
     * ladder's cancel offer converge on the same path. Neither `kds.controller`
     * nor `order.controller` refunds anything; they move the order and this
     * notices, which is also what keeps `ordering` from importing `payments`.
     */
    await safely('refund_initiation', async () => {
      for (const orderId of await refunds.claimRefundable()) {
        const opened = await refunds.initiate(orderId, `worker:refund:${orderId}`);
        if (opened) {
          const req = await notifications.requestFor(
            orderId,
            'refund.initiated',
            `worker:refund:${orderId}`,
          );
          if (req) await notifications.notify(req);
        }
      }
    });

    await safely('refund_execution', async () => {
      for (const refundId of await refunds.claimDue()) {
        await refunds.attempt(refundId);
      }
    });

    await safely('payment_expiry', async () => {
      const n = await payments.expireStaleIntents();
      if (n > 0) rootLogger.info({ event: 'payments_expired', count: n }, 'stale intents expired');
    });

    /*
     * WHICH SOLD-OUT DISHES CAME BACK.
     *
     * A RECOMPUTE, not a hook on the three places stock is written. The fourth
     * write site somebody adds next month would not fire a hook, silently, for
     * a feature whose only failure mode is silence — nobody notices a
     * notification that never arrived. Asking `itemState` afresh catches every
     * route back to orderable, including ones that do not exist yet.
     *
     * Cheap when idle: one indexed query against a partial index that is empty
     * whenever nobody is waiting, which is most of the time.
     */
    await safely('stock_watch', async () => {
      const { restocked, expired } = await stockWatches.sweep();
      if (restocked > 0) {
        rootLogger.info(
          { event: 'stock_watch_satisfied', watches: restocked },
          'dishes came back; the diners waiting on them will see it on their next poll',
        );
      }
      if (expired > 0) {
        rootLogger.debug({ event: 'stock_watch_expired', deleted: expired }, 'old watches gone');
      }
    });

    if (++ticks % HOUSEKEEPING_EVERY_TICKS === 0) {
      await safely('housekeeping', async () => {
        const n = await sweepExpired(db);
        if (n > 0) rootLogger.debug({ event: 'rate_limit_swept', deleted: n }, 'old windows gone');
      });
    }

    const elapsed = Date.now() - started;
    if (running) await sleep(Math.max(0, TICK_MS - elapsed));
  }

  await pool.end();
  rootLogger.info({ event: 'worker_shutdown_complete' }, 'closed cleanly');
  process.exit(0);
}

/**
 * Tell whoever is waiting that their food is on the counter.
 *
 * This is the single message the product owes a customer, and until now nothing
 * sent it — the tracking screen changed and the customer had to be looking at
 * it. Someone who put their phone in their pocket, which is the entire promise
 * of the product, learned nothing.
 *
 * Driven off order state rather than an event bus: an order in READY with no
 * `order.ready` notification is the query, and it is self-healing. A worker that
 * was down for ten minutes catches up on its next tick instead of losing every
 * message it missed.
 */
async function notifyReady(
  db: ReturnType<typeof createDb>,
  notifications: NotificationRepository,
): Promise<void> {
  const ready = await db
    .selectFrom('order')
    .select(['id'])
    .where('status', '=', 'READY')
    .where('ready_at', '>', new Date(Date.now() - 60 * 60 * 1000))
    .orderBy('ready_at')
    .limit(50)
    .execute();

  for (const o of ready) {
    const req = await notifications.requestFor(o.id, 'order.ready', `worker:ready:${o.id}`);
    // The dedupe index makes this free to re-attempt every tick: the second
    // call finds the slot taken and does nothing. That is why the query can be
    // "everything READY in the last hour" rather than a fragile cursor.
    if (req) await notifications.notify(req);
  }
}

async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    rootLogger.error(
      { event: 'worker_sweep_failed', sweep: name, err: (e as Error).message },
      `${name} sweep failed; continuing`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
