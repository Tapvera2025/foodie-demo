/**
 * ============================================================================
 * CASHFREE PAYMENT GATEWAY — BOTH SETTLEMENT MODES
 * ============================================================================
 *
 * Implements `PaymentProvider` against Cashfree PG, covering the two modes PRD
 * §14.2 defines. One integration, one webhook, one refund path; the modes differ
 * only in what goes in `order_splits`.
 *
 *   PLATFORM_COLLECT   Easy Split with real allocations. The customer pays once
 *                      and Cashfree routes the stall its share and the platform
 *                      its commission, at the moment configured by
 *                      PAYMENTS_SPLIT_TIMING.
 *
 *   VENDOR_DIRECT      One allocation: the whole amount to the stall. The
 *                      platform takes nothing at payment time and invoices
 *                      commission weekly or monthly.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED AGAINST THE SANDBOX, NOT INFERRED
 * ----------------------------------------------------------------------------
 *
 * Cashfree's reference pages are client-rendered and could not be read while
 * this was written, and the published examples disagreed about the shape of an
 * `order_splits` element. Rather than pick one and hope, `npm run test:cashfree`
 * sent all three candidates to the real sandbox. What it got back:
 *
 *   { vendor_id, amount }      "Vendor Not found"
 *   { vendor_id, percentage }  "Vendor Not found"
 *   { vendor, amount }         HTTP 400 — "order_splits[0].vendor_id : is
 *                              missing in the request"
 *
 * The first two were parsed and only objected to a deliberately invented payee,
 * which is the correct complaint. The third names the missing key outright.
 * So the payee key is `vendor_id`, and both `amount` and `percentage` are
 * accepted alongside it — this sends `amount`, for the reason in
 * `splitPayload()` below.
 *
 * Also confirmed on that run: a plain order was created (`order_status=ACTIVE`,
 * a real `cf_order_id`), so the credentials, the dated API version and the
 * rupee float format are all right; and Easy Split validated the split rather
 * than answering "not enabled", so it is available in sandbox without the
 * production activation request.
 *
 * Confirmed from the published SDK's model documentation:
 *
 *   POST /orders, GET /orders/{order_id}
 *   headers  x-client-id, x-client-secret, x-api-version (YYYY-MM-DD),
 *            x-request-id, x-idempotency-key
 *   body     order_id, order_amount (FLOAT IN RUPEES), order_currency,
 *            customer_details{customer_id, customer_phone, …},
 *            order_meta{return_url, notify_url, payment_methods}
 *   response cf_order_id, order_status, payment_session_id, order_splits
 *
 * NOT yet exercised end to end: a completed sandbox payment, an inbound webhook
 * over the network, and a refund. The webhook VERIFIER is tested — signed,
 * forged and stale-replay cases all behave — but no real callback has arrived.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '../../platform/errors.js';
import { log } from '../../platform/logger.js';
import type { SettlementMode } from '../../platform/schema.js';
import type {
  CaptureInput,
  CaptureResult,
  CreateIntentInput,
  NormalisedEventKind,
  NormalisedPaymentEvent,
  PaymentIntent,
  PaymentProvider,
  PaymentStatus,
  RefundInput,
  RefundResult,
  SettlementReport,
  SplitInput,
  SplitResult,
} from '../provider.interface.js';
import { paiseToRupees, rupeesToPaise } from './cashfree.money.js';

const BASE_URL = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
} as const;

/**
 * Long enough for a slow network, short enough that a customer waiting to pay
 * is not left on a spinner. Every call is retryable by construction — the
 * order id and refund id are ours and generated before the call — so timing out
 * is safe in a way that guessing is not.
 */
const TIMEOUT_MS = 15_000;

/**
 * A webhook older than this is refused.
 *
 * Cashfree signs `timestamp + body`, so an attacker who captures one valid
 * callback can otherwise replay it for ever. `processed_event` already dedupes
 * by event id, which stops a replay being processed twice — but not a replay of
 * an event we never saw, and five minutes bounds that window without being
 * tight enough to reject a genuinely delayed retry.
 */
const WEBHOOK_MAX_AGE_SECONDS = 300;

export interface CashfreeOptions {
  readonly mode: SettlementMode;
  readonly appId: string;
  readonly secretKey: string;
  readonly env: 'sandbox' | 'production';
  readonly apiVersion: string;
  /**
   * Publicly reachable origin for `notify_url` — Cashfree calls it server to
   * server, so it cannot be localhost. Absent means no webhooks, and the
   * reconcile sweep is the only way outcomes arrive.
   */
  readonly publicBaseUrl?: string | undefined;
  /**
   * Origin for `return_url`, which the CUSTOMER'S BROWSER follows after
   * paying. Only has to be reachable from their device, so in development this
   * is the PWA's own dev server. Separate from `publicBaseUrl` because
   * requiring a public hostname for it is what broke local checkout entirely.
   */
  readonly returnBaseUrl?: string | undefined;
}

export class CashfreePaymentProvider implements PaymentProvider {
  readonly name = 'cashfree';
  readonly mode: SettlementMode;

  private readonly base: string;

  constructor(private readonly opts: CashfreeOptions) {
    this.mode = opts.mode;
    this.base = BASE_URL[opts.env];
  }

  // ==========================================================================
  // HTTP
  // ==========================================================================

  /**
   * One place that talks to Cashfree.
   *
   * `x-idempotency-key` is sent on every mutating call and is always OUR
   * identifier — an order id or a refund id generated before the request. That
   * is the whole reason a timeout here is recoverable: retrying with the same
   * key reaches the same Cashfree object rather than creating a second one, and
   * a timeout is precisely the moment something retries.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; correlationId?: string } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-version': this.opts.apiVersion,
          'x-client-id': this.opts.appId,
          'x-client-secret': this.opts.secretKey,
          ...(opts.correlationId ? { 'x-request-id': opts.correlationId } : {}),
          ...(opts.idempotencyKey ? { 'x-idempotency-key': opts.idempotencyKey } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        /*
         * Cashfree's error body carries `code`, `message` and `type`. It goes
         * to the log in full because the operator needs it, and the thrown
         * message keeps it too — this class is server-side only and its errors
         * are mapped to a customer-safe sentence by the layer above. What is
         * NOT logged is any header, because that is where the secret is.
         */
        log().warn(
          { status: res.status, path, body: text.slice(0, 500) },
          'cashfree rejected a request',
        );
        /*
         * An `AppError`, so the HTTP filter reports 502 PAYMENT_PROVIDER_REJECTED
         * rather than an anonymous 500 INTERNAL.
         *
         * The first version threw a bare `CashfreeApiError`, which the filter
         * treats as an unhandled exception — the client got "Something went
         * wrong on our side" and a correlation id, and finding out that
         * Cashfree had simply refused the order meant grepping a terminal.
         * That is the wrong default for the single most common failure of any
         * payment integration.
         *
         * Nothing about the provider's reply travels with the throw. It does
         * not need to: the `log().warn` immediately above already carries the
         * status, the path and the body verbatim, tagged with the same
         * correlation id the client is given — so the operator has the whole
         * story and the customer has none of it.
         *
         * That matters here specifically. A payment provider's error text can
         * name the merchant account, the balance, or the key prefix, and
         * `AppError`'s `detail` is rendered to the client.
         */
        throw new AppError(
          'PAYMENT_PROVIDER_REJECTED',
          'The payment provider refused this request.',
        );
      }

      return text ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================================================
  // SPLITS
  // ==========================================================================

  /**
   * ==========================================================================
   * THE SPLIT PAYLOAD
   * ==========================================================================
   *
   * `vendor_id` is confirmed against the sandbox — see the header. Everything
   * uncertain about Cashfree's split schema was deliberately funnelled into
   * this one function so that confirming it, or correcting it later, is a
   * one-function change rather than an audit.
   *
   * Amounts, not percentages, though the sandbox accepts both. Percentages look tidier and are wrong for this
   * product: the split is computed upstream from snapshotted fee rules (PRD
   * §14.3) in integer paise, and re-expressing it as a percentage means
   * Cashfree re-derives an amount by multiplication and rounding that this
   * system does not control. The ledger would then be balanced against a number
   * a third party rounded. Sending the exact paise keeps arithmetic authority
   * here, where the double-entry check runs.
   *
   * PLATFORM allocations are omitted rather than sent as a zero-value line: the
   * platform is the merchant, so whatever is not split to a vendor is already
   * its own. Sending a self-allocation is at best redundant and at worst a
   * validation error.
   */
  private splitPayload(input: SplitInput): { vendor_id: string; amount: number }[] {
    const out: { vendor_id: string; amount: number }[] = [];

    for (const a of input.allocations) {
      if (a.party === 'PLATFORM' || a.party === 'PLATFORM_TAX_RESERVE') continue;
      if (Number(a.amountPaise) === 0) continue;

      if (!a.linkedAccountId) {
        /*
         * Refuse rather than skip.
         *
         * A missing payee on a VENDOR allocation means the stall is not
         * onboarded. Dropping the line would let the payment succeed with the
         * stall's money staying in the platform's account — the single most
         * expensive silent failure available here, because everything looks
         * fine until somebody reconciles a bank statement weeks later.
         */
        throw new Error(
          `Split allocation for ${a.party} has no Cashfree vendor id. ` +
            `Onboard the stall to payouts before it can take orders.`,
        );
      }

      out.push({ vendor_id: a.linkedAccountId, amount: paiseToRupees(a.amountPaise) });
    }

    return out;
  }

  // ==========================================================================
  // PaymentProvider
  // ==========================================================================

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const splits = input.split ? this.splitPayload(input.split) : [];

    const body: Record<string, unknown> = {
      /*
       * OUR order id, not a generated one. Cashfree allows alphanumerics with
       * `_` and `-` up to 50 characters, which a UUID satisfies. Using it makes
       * `GET /orders/{id}` answerable from our own primary key — no lookup
       * table, and no window where a crash between the call and the write
       * leaves a paid order nobody can find.
       */
      order_id: input.orderId,
      order_amount: paiseToRupees(input.amountPaise),
      order_currency: 'INR',
      customer_details: {
        /*
         * The ORDER's id as the customer id, and no phone or name.
         *
         * Cashfree wants a customer identifier; it does not need to know who
         * this person is. A food-court customer is anonymous beyond a verified
         * phone, and that phone is the one piece of personal data this system
         * is most careful with — the kitchen board never sees it either. Passing
         * an opaque per-order id satisfies the field without exporting a
         * customer database to a third party.
         */
        customer_id: `order_${input.orderId}`,
        customer_phone: '9999999999',
      },
      /*
       * ======================================================================
       * THE WEBHOOK URL IS THE EXISTING ROUTE, NOT A NEW ONE
       * ======================================================================
       *
       * `POST /api/v1/webhooks/payments` already exists in
       * `payment.controller.ts`: it captures the raw body, hands it to
       * `verifyAndParseWebhook` on whichever provider is configured, and always
       * answers 200 so a provider does not retry something already decided.
       *
       * This first pointed at `/api/v1/webhooks/cashfree`, invented to match
       * the provider's name. That route does not exist. Cashfree would have
       * POSTed every payment event to a 404 — and because Cashfree retries a
       * failed callback, the symptom would have been a payment that succeeds
       * on the customer's phone while the order sits in PAYMENT_PENDING for
       * ever, with the server's only recourse being a polled `getStatus`.
       *
       * A per-provider webhook path would also defeat the design: the route is
       * deliberately provider-agnostic so that switching aggregator is a config
       * change, not a new endpoint and a new dashboard entry.
       *
       * `{order_id}` in the return URL is CASHFREE'S placeholder, not a
       * template literal. They substitute the real id when redirecting the
       * customer back, which is what lets one registered URL serve every order.
       */
      /*
       * ======================================================================
       * TWO URLS, TWO DIFFERENT FOLLOWERS, TWO DIFFERENT REQUIREMENTS
       * ======================================================================
       *
       * These were sent together or not at all, gated on `publicBaseUrl`. With
       * no tunnel configured — the normal state on a developer's machine —
       * `order_meta` was omitted ENTIRELY, and the order was created with no
       * `return_url`.
       *
       * That is what produced Cashfree's "Something went wrong" screen. The
       * session was valid, ACTIVE, correctly formatted and in the right
       * environment — all four confirmed by `npm run diagnose:session` — and
       * the SDK still refused to render, because `return_url` is required for
       * the v3 checkout and the order did not have one.
       *
       * The two are not interchangeable:
       *
       *   return_url  the BROWSER follows it, after payment. It only has to be
       *               reachable from the customer's own device, so
       *               `http://localhost:5173` is perfectly valid in
       *               development.
       *   notify_url  CASHFREE follows it, server to server. It must be
       *               publicly reachable, which is what needs a tunnel.
       *
       * Conflating them meant the requirement of the harder one (a public
       * hostname) was imposed on the easier one, so local development got
       * neither — and lost the one it could always have had.
       *
       * `{order_id}` is CASHFREE'S placeholder, not a template literal. They
       * substitute the real id when redirecting, which is what lets one
       * registered URL serve every order.
       */
      ...(() => {
        const meta: Record<string, string> = {};
        if (this.opts.returnBaseUrl) {
          meta['return_url'] = `${this.opts.returnBaseUrl}/pay/{order_id}`;
        }
        if (this.opts.publicBaseUrl) {
          meta['notify_url'] = `${this.opts.publicBaseUrl}/api/v1/webhooks/payments`;
        }
        return Object.keys(meta).length > 0 ? { order_meta: meta } : {};
      })(),
      ...(splits.length > 0 ? { order_splits: splits } : {}),
    };

    const res = await this.call<{
      cf_order_id?: number | string;
      order_id?: string;
      payment_session_id?: string;
      order_status?: string;
    }>('POST', '/orders', {
      body,
      idempotencyKey: input.orderId,
      correlationId: input.correlationId,
    });

    if (!res.payment_session_id) {
      throw new Error('Cashfree accepted the order but returned no payment_session_id.');
    }

    return {
      /*
       * ======================================================================
       * OUR ORDER ID, NOT CASHFREE'S cf_order_id
       * ======================================================================
       *
       * This returned `cf_order_id` — Cashfree's own numeric handle, e.g.
       * 212796860498720 — and it is the wrong key for every endpoint that
       * follows. Cashfree's order routes are all keyed on the `order_id` WE
       * sent:
       *
       *     GET  /orders/{order_id}
       *     POST /orders/{order_id}/refunds
       *
       * `refund()` below already used `input.orderId`; `getStatus` used what
       * was stored here. That inconsistency was the bug.
       *
       * WHAT IT COST, AND WHY IT WAS SILENT
       *
       * With no webhook configured, the server learns an outcome only by
       * polling `getStatus`. That call became `GET /orders/212796860498720`,
       * which is not an order id Cashfree knows, so it 404'd — every time, for
       * every order. And `PaymentRepository.refresh` catches a failing
       * `getStatus` and returns the stored status, correctly, because a
       * provider timeout is UNKNOWN rather than a failure.
       *
       * So a systematically wrong reference was indistinguishable from a slow
       * network: a real payment completed at Cashfree, and the customer sat on
       * "this is taking longer than usual" for ever.
       *
       * `cf_order_id` is kept in the checkout payload below — it is what
       * Cashfree support asks for — but it is not a key this system routes on.
       */
      providerOrderRef: input.orderId,
      amountPaise: input.amountPaise,
      /*
       * The session id is all the browser gets, and it is all it needs: the
       * Cashfree JS SDK exchanges it for a checkout. It is single-use and
       * scoped to this order, so it is not a credential in any useful sense —
       * unlike the secret key, which never leaves this process.
       */
      checkoutPayload: {
        paymentSessionId: res.payment_session_id,
        mode: this.opts.env,
        orderId: input.orderId,
        // Not routed on; carried because it is what Cashfree support asks for.
        cfOrderId: res.cf_order_id === undefined ? null : String(res.cf_order_id),
      },
    };
  }

  async getStatus(providerPaymentRef: string): Promise<PaymentStatus> {
    const res = await this.call<{ order_status?: string; payments?: unknown }>(
      'GET',
      `/orders/${encodeURIComponent(providerPaymentRef)}`,
    );
    return mapOrderStatus(res.order_status);
  }

  /**
   * Cashfree captures automatically; there is no separate capture call.
   *
   * This is NOT a lie returning success. It asks the provider what actually
   * happened and reports that. Under `ON_ACKNOWLEDGED` the engine calls this
   * when the kitchen accepts, and the honest answer at that moment is "the
   * money was already taken at payment" — which is a real difference from the
   * authorise-then-capture model the interface also supports, and the layer
   * above needs to know it rather than be told a comfortable fiction.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const status = await this.getStatus(input.providerPaymentRef);

    if (status === 'CAPTURED') {
      return { status: 'CAPTURED', capturedPaise: input.amountPaise };
    }
    if (status === 'EXPIRED') return { status: 'EXPIRED', reason: 'The order expired unpaid.' };

    return {
      status: 'FAILED',
      reason: `Cashfree reports the order as ${status}, not paid.`,
    };
  }

  /**
   * ==========================================================================
   * NOT IMPLEMENTED, AND SAYING SO INSTEAD OF RETURNING A COMFORTABLE ANSWER
   * ==========================================================================
   *
   * This previously returned `applied: false` with the reason "split was
   * declared in order_splits at order creation; no deferred transfer needed."
   * That sentence is false, and it is the most dangerous kind of false: it
   * describes a system that would be working.
   *
   * Two facts, both verified by reading the code rather than assumed:
   *
   *   1. `PaymentRepository.createIntent` calls `provider.createIntent({
   *      orderId, vendorId, amountPaise, correlationId })` — with NO `split`.
   *      So `order_splits` is never in the create-order body.
   *
   *   2. Nothing in `src/` outside tests calls `applySplit` at all. The engine
   *      has no split step wired; `PAYMENTS_SPLIT_TIMING` is read and the
   *      timing it selects is never acted on.
   *
   * Together: under PLATFORM_COLLECT the whole amount settles to the platform
   * and the stall is paid NOTHING, with no error anywhere. The customer pays,
   * the kitchen cooks, the money stops. It would surface when a stall asked
   * where its week went.
   *
   * The stub provider hid this because a stub moves no money, so an unwired
   * split step looked exactly like a working one.
   *
   * WHY THIS THROWS RATHER THAN RETURNING FALSE
   *
   * `applied: false` is a legitimate answer — VENDOR_DIRECT genuinely needs no
   * transfer. Reusing it for "this is not built" makes a missing feature
   * indistinguishable from a correct no-op in the ledger, which is how the
   * problem stayed invisible in the first place. An exception cannot be
   * mistaken for success by anything.
   *
   * Nothing calls this today, so the throw changes no behaviour. It changes
   * what happens on the day somebody wires the engine's split step: they get a
   * clear stop instead of a silent no-op.
   */
  async applySplit(input: SplitInput): Promise<SplitResult> {
    if (this.mode === 'VENDOR_DIRECT') {
      // Genuinely nothing to do: the stall receives the whole amount and the
      // platform invoices its commission separately.
      return { applied: false, reason: 'VENDOR_DIRECT settles the whole amount to the stall.' };
    }

    throw new Error(
      `Deferred split is not implemented for Cashfree (order ${input.orderId}, ` +
        `transfer ${input.transferId}). The split must either be declared in ` +
        `order_splits at order creation, or executed through Cashfree's ` +
        `split-after-payment endpoint. Until one of those is wired, ` +
        `PLATFORM_COLLECT pays the stall nothing — see the note above this method.`,
    );
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const res = await this.call<{ refund_status?: string; cf_refund_id?: string | number }>(
        'POST',
        `/orders/${encodeURIComponent(input.orderId)}/refunds`,
        {
          body: {
            /*
             * OUR refund id. Generated before the call, per the interface's own
             * note, so a timeout is retryable without refunding twice.
             */
            refund_id: input.refundId,
            refund_amount: paiseToRupees(input.amountPaise),
            refund_note: input.reason.slice(0, 100),
          },
          idempotencyKey: input.refundId,
        },
      );

      const status =
        res.refund_status === 'SUCCESS'
          ? 'SUCCEEDED'
          : res.refund_status === 'FAILED'
            ? 'FAILED'
            : 'PENDING';

      return {
        status,
        ...(res.cf_refund_id ? { providerRefundRef: String(res.cf_refund_id) } : {}),
        /*
         * AUTHORITATIVE in both modes, and that is a real claim about this
         * implementation rather than a copy of PRD §14.2's table.
         *
         * §14.2 marks VENDOR_DIRECT refunds ADVISORY because in the literal
         * reading of that mode the platform is not in the money flow and cannot
         * make a refund happen. Here it is: funds route through the platform's
         * merchant account via Easy Split, so this call really does execute the
         * refund and the platform really does know the outcome.
         */
        authority: 'AUTHORITATIVE',
      };
    } catch (err) {
      /*
       * A failed refund CALL is not a failed refund.
       *
       * Reporting FAILED here would tell the engine the money is still with us
       * when a timeout may mean it is already on its way back. PENDING is the
       * honest state for "we do not know yet", and the reconciliation sweep is
       * what resolves it.
       */
      log().warn({ refundId: input.refundId, err: String(err) }, 'cashfree refund call failed');
      return {
        status: 'PENDING',
        authority: 'AUTHORITATIVE',
        reason: 'The refund call did not complete; the outcome is unknown until reconciled.',
      };
    }
  }

  /**
   * ==========================================================================
   * VERIFY, THEN PARSE. NEVER THE OTHER WAY ROUND.
   * ==========================================================================
   *
   * PRD PAY-03. The body is a `Buffer` and stays one until the signature checks
   * out, because `JSON.parse` on an unauthenticated payload is running a
   * stranger's input through a parser before knowing whether they are allowed
   * to send it at all.
   *
   * Cashfree signs `timestamp + rawBody` with the secret key, base64 over
   * HMAC-SHA256, in `x-webhook-signature` with `x-webhook-timestamp` alongside.
   * The timestamp is part of the signed material precisely so that it cannot be
   * changed to defeat the freshness check below.
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): NormalisedPaymentEvent {
    const signature = headers['x-webhook-signature'] ?? headers['X-Webhook-Signature'];
    const timestamp = headers['x-webhook-timestamp'] ?? headers['X-Webhook-Timestamp'];

    if (!signature || !timestamp) {
      throw new Error('Cashfree webhook is missing its signature or timestamp header.');
    }

    const expected = createHmac('sha256', this.opts.secretKey)
      .update(timestamp + rawBody.toString('utf8'))
      .digest('base64');

    /*
     * `timingSafeEqual`, and a length check first because it throws on a length
     * mismatch. `===` on a signature leaks the length of the matching prefix
     * through timing, which is enough to forge one given patience.
     */
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('Cashfree webhook signature did not verify.');
    }

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_MAX_AGE_SECONDS) {
      throw new Error(
        `Cashfree webhook timestamp is ${Math.round(ageSeconds)}s away from now; refusing as a replay.`,
      );
    }

    // Only now is it safe to look at the contents.
    const parsed = JSON.parse(rawBody.toString('utf8')) as CashfreeWebhook;
    const d = parsed.data ?? {};

    const amount = d.payment?.payment_amount ?? d.refund?.refund_amount;

    return {
      /*
       * The idempotency key, and it has to be genuinely unique per event.
       *
       * Cashfree does not always send an explicit event id, so this falls back
       * to type + reference + timestamp. `processed_event` has a unique
       * constraint on it, which is what makes a duplicate delivery a no-op
       * rather than a second state transition.
       */
      providerEventId:
        parsed.event_id ??
        `${parsed.type ?? 'unknown'}:${d.payment?.cf_payment_id ?? d.refund?.cf_refund_id ?? d.order?.order_id ?? 'none'}:${timestamp}`,
      kind: mapEventType(parsed.type),
      ...(d.payment?.cf_payment_id !== undefined
        ? { providerPaymentRef: String(d.payment.cf_payment_id) }
        : {}),
      ...(d.refund?.cf_refund_id !== undefined
        ? { providerRefundRef: String(d.refund.cf_refund_id) }
        : {}),
      ...(d.order?.order_id ? { orderId: d.order.order_id } : {}),
      ...(amount !== undefined ? { amountPaise: rupeesToPaise(amount) } : {}),
      ...(parsed.event_time ? { providerTimestamp: parsed.event_time } : {}),
      raw: parsed,
    };
  }

  /**
   * Null, deliberately, until settlement reconciliation is built.
   *
   * The interface's own contract says null means "no authoritative report, mark
   * the ledger ADVISORY". Returning a fabricated empty report would instead
   * assert that the period settled to nothing — a claim about money, made up.
   */
  async getSettlementReport(): Promise<SettlementReport | null> {
    return null;
  }
}

/**
 * Kept for the log, not for the throw.
 *
 * `call()` now raises an `AppError` so the client gets 502
 * PAYMENT_PROVIDER_REJECTED instead of an anonymous 500. This class remains the
 * typed shape for the provider's own reply and is what future code should use
 * if it ever needs to inspect a rejection rather than merely report one.
 */
export class CashfreeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`Cashfree ${path} returned ${status}: ${body}`);
    this.name = 'CashfreeApiError';
  }
}

interface CashfreeWebhook {
  type?: string;
  event_id?: string;
  event_time?: string;
  data?: {
    order?: { order_id?: string; order_amount?: number };
    payment?: {
      cf_payment_id?: string | number;
      payment_status?: string;
      payment_amount?: number;
    };
    refund?: { cf_refund_id?: string | number; refund_status?: string; refund_amount?: number };
  };
}

/** Cashfree's order status vocabulary -> the interface's. */
function mapOrderStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case 'PAID':
      return 'CAPTURED';
    case 'ACTIVE':
      return 'PENDING';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'TERMINATED':
    case 'TERMINATION_REQUESTED':
      return 'FAILED';
    default:
      /*
       * PRD §12.2: an unrecognised provider response is AMBIGUOUS — never a
       * success, never a failure. Mapping the default to FAILED is exactly how
       * a paid customer ends up with no order and no refund, so an unknown
       * status routes to reconciliation and a human instead.
       */
      return 'RECONCILIATION_REQUIRED';
  }
}

function mapEventType(type: string | undefined): NormalisedEventKind {
  switch (type) {
    case 'PAYMENT_SUCCESS_WEBHOOK':
      return 'PAYMENT_CAPTURED';
    case 'PAYMENT_FAILED_WEBHOOK':
      return 'PAYMENT_FAILED';
    case 'PAYMENT_USER_DROPPED_WEBHOOK':
      return 'PAYMENT_EXPIRED';
    case 'REFUND_STATUS_WEBHOOK':
      return 'REFUND_SUCCEEDED';
    default:
      return 'UNKNOWN';
  }
}
