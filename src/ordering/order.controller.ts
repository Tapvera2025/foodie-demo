/**
 * Checkout and tracking.
 *
 * `contracts/openapi.yaml` — /checkout/validate, /orders, /orders/{id}.
 */

import { Body, Controller, Get, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { CustomerGuard, customerOf, type RequestWithCustomer } from '../identity/customer.guard.js';
import { SessionGuard, sessionOf, type RequestWithSession } from '../identity/session.guard.js';
import { currentCorrelationId } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { OrderRepository } from './order.repository.js';
import { transitionOrder } from './transition.js';

type CustomerRequest = RequestWithCustomer & RequestWithSession;

/**
 * Note what is NOT here: any price field, and no `sessionId`.
 *
 * The client sends what the customer chose, never what it costs. Accepting a
 * `totalPaise` and trusting it is the single most common way a checkout
 * endpoint gets robbed, and no amount of client-side validation fixes it,
 * because the attacker is not using the client.
 *
 * `sessionId` was here until this release, and it was the only thing saying
 * which session an order belonged to. A session id in a request body is a
 * bearer credential the caller chooses, which means it is one an attacker
 * chooses. It now comes from the signed session token on the request, so an
 * order can only be placed against a session this client was actually issued.
 */
const PlaceOrderBody = z.object({
  vendorId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
        instructions: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(40),
});

@Controller('api/v1')
export class OrderController {
  private readonly orders: OrderRepository;

  constructor(@Inject(DB) private readonly db: Kysely<Database>) {
    this.orders = new OrderRepository(db);
  }

  /**
   * Price a basket without committing to it, so the customer sees the fee and
   * the tax before they are asked to pay. PRD CUS-PRICE-02: no charge may
   * appear for the first time on the payment screen.
   *
   * Runs the same code path as placement and throws it away, which is the
   * point — a preview computed by a different function is a preview that will
   * eventually disagree with the invoice.
   */
  @Post('checkout/validate')
  @UseGuards(SessionGuard, CustomerGuard)
  async validate(@Body() body: unknown, @Req() req: CustomerRequest): Promise<unknown> {
    const input = PlaceOrderBody.parse(body);
    const { sessionId } = await this.sessionForCustomer(req);
    const result = await this.orders.priceOnly({
      sessionId,
      vendorId: input.vendorId,
      lines: input.lines,
    });
    return result;
  }

  /**
   * The session this request is acting on, having proved it is the customer's.
   *
   * Two credentials, two questions. The session token says which browse session
   * this client owns; the customer token says who they are. Neither implies the
   * other, and checking that they agree is what stops a stolen session token
   * from being usable by anyone but the customer it was verified against.
   *
   * A session with no customer attached is accepted here only when the token
   * holder is the one who is about to be attached to it — which is the ordinary
   * case of verifying an OTP and immediately ordering, where the update and
   * this read can race across two requests.
   */
  private async sessionForCustomer(req: CustomerRequest): Promise<{ sessionId: string }> {
    const { sessionId } = sessionOf(req);
    const { customerId } = customerOf(req);

    const session = await this.db
      .selectFrom('app_session')
      .select(['id', 'customer_id', 'expires_at'])
      .where('id', '=', sessionId)
      .executeTakeFirst();

    if (!session || session.expires_at.getTime() <= Date.now()) {
      throw new AppError('SESSION_EXPIRED', 'This session has expired. Rescan the QR code.');
    }

    if (session.customer_id !== null && session.customer_id !== customerId) {
      // 404-shaped, not 403. Confirming that a session exists and belongs to
      // somebody else is the same leak as confirming a resource exists across
      // tenants — PRD §16.3.
      throw new AppError('SESSION_EXPIRED', 'This session has expired. Rescan the QR code.');
    }

    if (session.customer_id === null) {
      await this.db
        .updateTable('app_session')
        .set({ customer_id: customerId })
        .where('id', '=', sessionId)
        .where('customer_id', 'is', null)
        .execute();
    }

    return { sessionId };
  }

  @Post('orders')
  @UseGuards(SessionGuard, CustomerGuard)
  async place(
    @Body() body: unknown,
    @Req() req: CustomerRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    // The header is mandatory and there is no server-generated fallback. A
    // key the server invents is different on every retry, which means it is
    // not an idempotency key at all — it just looks like one in the logs.
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header: a UUID your client keeps across retries',
      );
    }

    const input = PlaceOrderBody.parse(body);
    const { sessionId } = await this.sessionForCustomer(req);

    const placed = await this.orders.placeOrder({
      sessionId,
      vendorId: input.vendorId,
      lines: input.lines,
      idempotencyKey,
      correlationId: currentCorrelationId(),
    });

    return {
      orderId: placed.id,
      orderNumber: placed.publicOrderNumber,
      status: placed.status,
      totalPayablePaise: placed.totalPayablePaise,
      // Lets the client tell "your order was placed" from "your order was
      // already placed" without guessing from a status code.
      replayed: placed.replayed,
    };
  }

  /**
   * Every order in this session, newest first.
   *
   * WHY THIS HAD TO EXIST
   *
   * There was only `GET /orders/:id`, so the tracking screen was a dead end: a
   * customer who navigated away could never get back to an order they had
   * paid for. Worse, it made the product's own premise unreachable — a food
   * court exists so you can buy a curry from one stall and a drink from
   * another, and there was no way to start a second order without losing
   * sight of the first.
   *
   * ONE CART PER VENDOR, MANY ORDERS PER SESSION
   *
   * Those are different rules and only the first is a constraint. A cart holds
   * one stall's items because an order goes to one kitchen (PRD §11.3). Nothing
   * stops a customer having three orders cooking at three stalls at once, and
   * `placeOrder` has never checked for one — the gap was only ever that the
   * client could not SEE them.
   *
   * SCOPED BY BOTH, NOW.
   *
   * This used to be scoped by the session id in the path and nothing else,
   * which was reasonable only while a session id was believed to be private.
   * It was not — one session was shared across the whole court — so the listing
   * showed every customer in the hall each other's baskets and totals.
   *
   * The path parameter must now match the session this client holds a token
   * for, AND the rows are filtered to the authenticated customer. Either check
   * alone would be enough today; both, because this is the endpoint whose
   * failure mode is showing a stranger what you had for lunch.
   */
  @Get('sessions/:sessionId/orders')
  @UseGuards(SessionGuard, CustomerGuard)
  async sessionOrders(
    @Param('sessionId') sessionId: string,
    @Req() req: CustomerRequest,
  ): Promise<unknown> {
    const { customerId } = customerOf(req);

    // The path parameter is not a credential. It must agree with the session
    // this client actually holds, or the request is asking about somebody
    // else's session and gets the answer it would get for one that never
    // existed.
    if (sessionOf(req).sessionId !== sessionId) {
      return { orders: [] };
    }

    const rows = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      // Ownership, not just session scope. Two customers can no longer share a
      // session, but an order list is exactly the wrong place to rely on that
      // being true somewhere else.
      .where('order.customer_id', '=', customerId)
      .select([
        'order.id as orderId',
        'order.public_order_number as orderNumber',
        'order.status as status',
        'order.total_payable_paise as totalPayablePaise',
        'order.created_at as placedAt',
        'vendor.id as vendorId',
        'vendor.name as vendorName',
        'vendor.estimated_prep_minutes as estimatedPrepMinutes',
      ])
      .where('order.app_session_id', '=', sessionId)
      .orderBy('order.created_at', 'desc')
      .limit(20)
      .execute();

    return {
      orders: rows.map((r) => ({
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        status: r.status,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        estimatedPrepMinutes: r.estimatedPrepMinutes,
        totalPayablePaise: r.totalPayablePaise,
        placedAt: r.placedAt.toISOString(),
      })),
    };
  }

  /**
   * One order, for the customer who placed it.
   *
   * This used to return the full order — items, quantities, every monetary
   * line, vendor and status — to anyone holding the UUID, with no credential of
   * any kind. A UUID is unguessable, which made it hard to exploit and did not
   * make it an access control: the ids travel in URLs, logs, and until this
   * release in a session that half the food court shared.
   */
  /**
   * The customer changes their mind, or accepts the offer the ladder made.
   *
   * WHY THIS ENDPOINT DID NOT EXIST AND HAD TO
   *
   * The escalation ladder's fourth rung sets
   * `escalation_state.customer_offered_cancel_at` at 180 seconds and the
   * tracking screen tells the customer they can have their money back. Nothing
   * behind it could give it to them. A paid order with no stall and no way out
   * is the worst state this system can produce, and it was reachable in three
   * minutes.
   *
   * WHAT THIS DOES NOT DO
   *
   * It does not refund. It moves the order to CANCELLED and stops. The refund
   * is opened by the worker sweeping for orders that owe one, which keeps
   * `ordering` from importing `payments`, makes the refund survive a crash
   * between the two, and means the kitchen-rejection path and this one produce
   * a refund by exactly the same mechanism rather than two that can drift.
   *
   * The allowed states are §7.3's: only before the kitchen has committed.
   * Once a stall has ACKNOWLEDGED, food is being cooked and a customer
   * cancelling unilaterally is a stall paying for ingredients out of its own
   * pocket. That case goes through rejection, with a reason.
   */
  @Post('orders/:orderId/cancel')
  @UseGuards(CustomerGuard)
  async cancel(@Param('orderId') orderId: string, @Req() req: CustomerRequest): Promise<unknown> {
    const { customerId } = customerOf(req);

    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('order')
        .select(['id', 'status', 'public_order_number'])
        .where('id', '=', orderId)
        .where('customer_id', '=', customerId)
        .executeTakeFirst();

      // 404 for somebody else's order, never 403 — §16.3.
      if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');

      const CANCELLABLE = ['CREATED', 'PAYMENT_PENDING', 'DISPATCHED', 'DISPATCH_FAILED'];
      if (!CANCELLABLE.includes(order.status)) {
        throw new AppError(
          'INVALID_TRANSITION',
          order.status === 'CANCELLED' || order.status === 'REFUND_PENDING'
            ? 'This order is already being cancelled.'
            : `This order is ${order.status.toLowerCase().replace(/_/g, ' ')} and can no longer be cancelled here.`,
        );
      }

      const result = await transitionOrder(trx, {
        orderId: order.id,
        to: 'CANCELLED',
        actorType: 'CUSTOMER',
        actorId: customerId,
        correlationId: currentCorrelationId(),
      });

      return {
        orderId: order.id,
        orderNumber: order.public_order_number,
        status: result.status,
        changed: result.changed,
        // Said plainly rather than implied by a status. A customer who has just
        // been told their food is not coming should not have to infer whether
        // their money is.
        refundStarting: order.status === 'DISPATCHED' || order.status === 'DISPATCH_FAILED',
      };
    });
  }

  @Get('orders/:orderId')
  @UseGuards(CustomerGuard)
  async track(@Param('orderId') orderId: string, @Req() req: CustomerRequest): Promise<unknown> {
    const { customerId } = customerOf(req);

    const order = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      // Scoped in the query rather than checked after it. A read that fetches
      // the row and then decides is one refactor away from returning it.
      .where('order.customer_id', '=', customerId)
      .select([
        'order.id',
        'order.public_order_number',
        'order.status',
        'order.subtotal_paise',
        'order.food_tax_paise',
        'order.customer_fee_paise',
        'order.customer_fee_tax_paise',
        'order.total_payable_paise',
        'order.created_at',
        'order.ready_at',
        'order.rejection_reason',
        'vendor.id as vendorId',
        'vendor.name as vendorName',
        'vendor.cover_image_url as vendorImageUrl',
        'vendor.estimated_prep_minutes',
      ])
      .where('order.id', '=', orderId)
      .executeTakeFirst();

    if (!order) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');

    /*
     * ========================================================================
     * THE PRICE IS SNAPSHOTTED. THE PHOTO IS LOOKED UP LIVE. ON PURPOSE.
     * ========================================================================
     *
     * `order_item` deliberately snapshots `name_snapshot` and
     * `unit_price_paise_snapshot` and deliberately does NOT snapshot an image:
     * a vendor editing a dish must not be able to change what a past order
     * says it cost. That rule is about the RECEIPT, and it is right.
     *
     * It was being read as a rule about the thumbnail too, so this query
     * returned no image and the pay screen drew a gradient placeholder. The
     * customer picked a dish from a photo, saw that photo in the basket
     * (Checkout renders `l.imageUrl`), and then watched it turn into a
     * coloured square on the one screen that asks them to part with money —
     * which is the screen where recognising your own order matters most.
     *
     * A photo is not a term of the sale. Nobody disputes a bill over a
     * thumbnail, and if a vendor replaces a dish photo the honest thing is to
     * show the current one. So it joins live.
     *
     * LEFT join, and `menu_item_id` is nullable in the first place — an
     * external item never had one, and a deleted dish leaves a past order's
     * line intact by design. Both arrive here as `null`, and `FoodTile` falls
     * back to the gradient it already draws today. No order can fail to
     * render because a picture went missing.
     */
    const items = await this.db
      .selectFrom('order_item')
      .leftJoin('menu_item', 'menu_item.id', 'order_item.menu_item_id')
      .select([
        'order_item.name_snapshot',
        'order_item.quantity',
        'order_item.line_total_paise',
        'menu_item.image_url as imageUrl',
      ])
      .where('order_item.order_id', '=', orderId)
      .execute();

    /*
     * ========================================================================
     * THE REFUND, BECAUSE "YOUR REFUND HAS STARTED" IS NOT AN ANSWER
     * ========================================================================
     *
     * A rejected order used to tell the customer only that a refund was
     * automatic. True, and it leaves them watching a screen that never changes
     * while money they can see leaving their account has not come back.
     *
     * The refund row already carries the whole lifecycle — REQUESTED, PENDING,
     * SUCCEEDED, FAILED — so the tracking screen can say which stage it is at
     * rather than asserting a happy ending it has not checked.
     *
     * The MOST RECENT one. A retried refund writes a new row, and the customer
     * cares about the live attempt, not the one that failed an hour ago.
     */
    /*
     * ========================================================================
     * THE PAYMENT'S OWN STATUS, WHICH THE ORDER'S STATUS DOES NOT IMPLY
     * ========================================================================
     *
     * The tracking screen decided "has this been paid for?" from the ORDER
     * status alone — `CREATED` or `PAYMENT_PENDING` meant not paid.
     *
     * Those are different facts and they are routinely out of step. Only a
     * signed provider webhook may move an order into a financially
     * authoritative state (§7.4, PAY-04); the status poll deliberately updates
     * the PAYMENT row and leaves the order alone. So between the money being
     * captured and the webhook arriving, the payment is CAPTURED and the order
     * is still PAYMENT_PENDING — and the customer was told "Payment not
     * completed" about money that had already left their account.
     *
     * Sending both lets the screen say the true thing: paid, waiting on
     * confirmation.
     */
    const payment = await this.db
      .selectFrom('payment')
      .select(['status', 'captured_at', 'authorized_at'])
      .where('order_id', '=', order.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    const refund = await this.db
      .selectFrom('refund')
      .select(['status', 'amount_paise', 'created_at', 'confirmed_at'])
      .where('order_id', '=', order.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    return {
      orderId: order.id,
      orderNumber: order.public_order_number,
      status: order.status,
      /** The money's own state, independent of the order's. */
      paymentStatus: payment?.status ?? null,
      paymentSecured: Boolean(payment?.captured_at ?? payment?.authorized_at),
      refund: refund
        ? {
            status: refund.status,
            amountPaise: refund.amount_paise,
            startedAt: refund.created_at.toISOString(),
            // : the provider told us the money actually landed.
            settledAt: refund.confirmed_at?.toISOString() ?? null,
          }
        : null,
      vendorId: order.vendorId,
      vendorName: order.vendorName,
      /** Nullable: a stall that has never uploaded a cover. The client keeps
          its icon disc for that case rather than showing a broken frame. */
      vendorImageUrl: order.vendorImageUrl,
      estimatedPrepMinutes: order.estimated_prep_minutes,
      placedAt: order.created_at.toISOString(),
      readyAt: order.ready_at?.toISOString() ?? null,
      rejectionReason: order.rejection_reason,
      items: items.map((i) => ({
        name: i.name_snapshot,
        quantity: i.quantity,
        lineTotalPaise: i.line_total_paise,
        // Live, from the join above — not part of the priced snapshot.
        imageUrl: i.imageUrl,
      })),
      totals: {
        subtotalPaise: order.subtotal_paise,
        foodTaxPaise: order.food_tax_paise,
        customerFeePaise: order.customer_fee_paise,
        customerFeeTaxPaise: order.customer_fee_tax_paise,
        totalPayablePaise: order.total_payable_paise,
      },
    };
  }
}
