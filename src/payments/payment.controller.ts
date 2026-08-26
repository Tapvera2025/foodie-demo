/**
 * The payment HTTP surface. Three endpoints, and only one of them is trusted.
 *
 *   POST /orders/:id/payment-intent   customer asks for something to pay with
 *   POST /webhooks/payments           the provider tells us what happened
 *   GET  /orders/:id/payment          the client asks; we ask the provider
 *
 * The middle one is the only channel that may advance an order into a
 * financially authoritative state, because it is the only one with a signature
 * on it. PRD §7.4.
 */

import {
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';

import type { Kysely } from 'kysely';

import {
  CustomerGuard,
  customerOf,
  type RequestWithCustomer,
} from '../identity/customer.guard.js';
import { config } from '../platform/config.js';
import { currentCorrelationId, setActor } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { paise } from '../platform/money.js';
import type { Database } from '../platform/schema.js';
import { PAYMENT_ENGINE, PAYMENT_PROVIDER } from './payment.tokens.js';
import type { PaymentRepository } from './payment.repository.js';
import type { PaymentProvider } from './provider.interface.js';
import { StubPaymentProvider } from './providers/stub.provider.js';

@Controller('api/v1')
export class PaymentController {
  constructor(
    @Inject(PAYMENT_ENGINE) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(DB) private readonly db: Kysely<Database>,
  ) {}

  /**
   * Assert this customer placed this order, or answer as if it did not exist.
   *
   * Every customer-facing payment route needs it. Opening a payment intent
   * against a stranger's order, or reading its payment state, is the same
   * ownership hole as reading the order itself — and the payment routes are
   * the ones that touch money.
   */
  private async ownedOrder(orderId: string, req: RequestWithCustomer): Promise<void> {
    const { customerId } = customerOf(req);
    const owned = await this.db
      .selectFrom('order')
      .select('id')
      .where('id', '=', orderId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();

    // 404, never 403. A different status confirms the order exists — §16.3.
    if (!owned) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');
  }

  /**
   * Hand the client something to pay with.
   *
   * Safe to call twice: the second call returns the same live intent rather
   * than opening a second one. PAY-REC-03 — a customer tapping Pay twice on a
   * slow connection must produce one order, one intent and one charge.
   */
  @Post('orders/:orderId/payment-intent')
  @UseGuards(CustomerGuard)
  async intent(
    @Param('orderId') orderId: string,
    @Req() req: RequestWithCustomer,
  ): Promise<unknown> {
    await this.ownedOrder(orderId, req);
    const result = await this.payments.createIntent({
      orderId,
      correlationId: currentCorrelationId(),
    });
    return result;
  }

  /**
   * The provider's channel.
   *
   * `req.rawBody` rather than the parsed body, because the signature covers the
   * exact bytes that were sent. Re-serialising a parsed object changes key
   * order and whitespace and produces a different digest, so verification would
   * fail on perfectly valid events — or, worse, someone would "fix" it by
   * skipping verification.
   *
   * Always answers 200, including for events it decides to ignore. A provider
   * that keeps retrying because we returned 500 on something we already
   * decided about turns one problem into a queue of them. The only 4xx here is
   * a bad signature, which never reaches the decision at all.
   */
  @Post('webhooks/payments')
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<unknown> {
    // Not a customer. Anything this event causes — a ledger row, an audit row
    // — is attributable to the provider, which is the only channel §7.4 lets
    // move an order into a financially authoritative state.
    setActor('PROVIDER_WEBHOOK');

    const rawBody = req.rawBody;
    if (!rawBody) {
      // Means `rawBody: true` was lost from the bootstrap options. Loud,
      // because the alternative is verifying signatures against an empty
      // buffer, which fails closed but for a reason nobody would guess.
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'raw body unavailable');
    }

    const result = await this.payments.ingestWebhook(rawBody, headers);

    if (result.dispatchQueued) {
      // The worker picks this up on its next tick (≤5s) by sweeping for orders
      // in PAYMENT_CONFIRMED — it is not pushed from here. That indirection is
      // PAY-04: dispatch is a separate committed command, so a webhook
      // delivered twice still produces exactly one kitchen ticket.
      log().info(
        { event: 'dispatch_pending', orderId: result.orderId },
        'order confirmed; the dispatch worker will send it to the stall',
      );
    }

    return { received: true, outcome: result.outcome };
  }

  /**
   * The customer's browser came back. Ask the provider what actually happened.
   *
   * PRD §9 case B. This endpoint deliberately takes no argument describing the
   * outcome: there is nothing the client could tell us that we would believe,
   * so there is nothing for it to send.
   */
  @Get('orders/:orderId/payment')
  @UseGuards(CustomerGuard)
  async status(
    @Param('orderId') orderId: string,
    @Req() req: RequestWithCustomer,
  ): Promise<unknown> {
    await this.ownedOrder(orderId, req);
    const { paymentStatus } = await this.payments.refreshFromProvider(orderId);
    return { paymentStatus };
  }

  /**
   * DEVELOPMENT ONLY. Stands in for the customer completing payment.
   *
   * WHY THIS SHAPE AND NOT A SHORTCUT
   *
   * The obvious version sets the order to PAYMENT_CONFIRMED and moves on. That
   * would be a client request advancing an order into a financially
   * authoritative state — the one thing PRD §7.4 forbids — and having it exist
   * in development means the production path is never the path anyone
   * exercises. The first real webhook would be the first webhook ever handled.
   *
   * So this pretends to be the PROVIDER, not the customer. It signs a webhook
   * with the same secret, posts it through the same `ingestWebhook`, and gets
   * verified, deduplicated and decided exactly like a real one. Everything
   * downstream of the signature check is production code.
   *
   * Refused unless the provider is the stub. Against a real aggregator this
   * would be forging their signature, which is both wrong and, mercifully,
   * impossible without their secret.
   */
  @Post('dev/orders/:orderId/simulate-payment')
  async simulate(@Param('orderId') orderId: string): Promise<unknown> {
    if (config().NODE_ENV === 'production') throw new AppError('QR_INVALID', 'Not found');
    if (!(this.provider instanceof StubPaymentProvider)) {
      throw new AppError(
        'RECONCILIATION_REQUIRED',
        'Payment simulation only works against the stub provider.',
      );
    }

    const payment = await this.db
      .selectFrom('payment')
      .select(['id', 'provider_order_ref', 'amount_paise'])
      .where('order_id', '=', orderId)
      .where('status', 'in', ['CREATED', 'PENDING'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (!payment?.provider_order_ref) {
      throw new AppError('INVALID_TRANSITION', 'No payment is waiting on this order.');
    }

    // The provider's own state moves first, so a later getStatus() agrees with
    // the webhook we are about to send. A stub that contradicts itself teaches
    // the wrong lessons.
    //
    // The second argument re-adopts a reference the stub has forgotten across a
    // restart — the `payment` row is the durable record, its in-memory map is
    // not. Without it, everything downstream would still work and then disagree
    // with the provider at capture time.
    this.provider.markAuthorized(payment.provider_order_ref, {
      orderId,
      amountPaise: paise(payment.amount_paise),
    });

    const { rawBody, headers } = this.provider.signedWebhook({
      id: `evt_dev_${payment.id}`,
      // AUTHORIZED, not CAPTURED. Under ON_ACKNOWLEDGED the money is blocked
      // here and taken when the kitchen accepts.
      type: 'payment.authorized',
      orderId,
      paymentRef: payment.provider_order_ref,
      amountPaise: payment.amount_paise,
      timestamp: new Date().toISOString(),
    });

    const result = await this.payments.ingestWebhook(rawBody, headers);

    log().warn(
      { event: 'payment_simulated', orderId, outcome: result.outcome },
      'DEV ONLY — a webhook was forged locally and processed through the real path',
    );

    return { simulated: true, outcome: result.outcome, orderStatus: result.orderStatus };
  }
}
