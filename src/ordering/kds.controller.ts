/**
 * The kitchen queue. Everything a stall does to an order.
 *
 * TWO RULES THIS FILE ENFORCES
 *
 * 1. Every request is scoped to the caller's OWN vendor, taken from the token
 *    and never from the URL. A kitchen that can pass someone else's vendor id
 *    can reject a competitor's orders, and no amount of UI prevents that.
 *
 * 2. Every status change goes through `assertCommandAllowed` and writes an
 *    `order_status_history` row in the same transaction. Status is never
 *    assigned directly — PRD ORD-SM-04.
 */

import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { serviceDateFor } from '../catalog/service-date.js';
import { currentCorrelationId } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import type { Database, OrderStatus, RejectionReason } from '../platform/schema.js';
import { StaffGuard, staffOf, vendorScopeOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { ESCALATION, NOTIFICATIONS } from '../platform/workers.module.js';
import type { EscalationRepository } from '../dispatch/escalation.repository.js';
import type { NotificationRepository } from '../notify/notification.repository.js';
import { transitionOrder } from './transition.js';
import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';

const REASONS = [
  'ITEM_OUT_OF_STOCK',
  'KITCHEN_OVERLOADED',
  'EQUIPMENT_FAILURE',
  'VENDOR_CLOSING',
  'INGREDIENT_UNAVAILABLE',
  'PRICE_OR_MENU_ERROR',
  'CUSTOMER_REQUEST',
  'DUPLICATE_ORDER',
  'OTHER',
] as const;

const RejectBody = z.object({
  reason: z.enum(REASONS),
  note: z.string().max(280).optional(),
});

/** Orders still needing the kitchen's attention. Terminal states drop off. */
const LIVE: readonly OrderStatus[] = [
  'PAYMENT_CONFIRMED',
  'DISPATCHED',
  'ACKNOWLEDGED',
  'PREPARING',
  'READY',
];

/**
 * How few is "running low", when nobody has said.
 *
 * Three, because it is the smallest number a cook can still act on — enough
 * time to start another batch, few enough that saying it is not crying wolf.
 * Per-item overrides live in `menu_item.low_stock_threshold`: three portions is
 * nearly out for a thali cooked to order and comfortable for a packet of chips.
 */
const DEFAULT_LOW_STOCK_THRESHOLD = 3;

@Controller('api/v1/kds')
@UseGuards(StaffGuard)
export class KdsController {
  private readonly audit: AuditRepository;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(ESCALATION) private readonly escalation: EscalationRepository,
    @Inject(NOTIFICATIONS) private readonly notifications: NotificationRepository,
  ) {
    this.audit = new AuditRepository(db);
  }

  private vendorId(req: RequestWithStaff): string {
    const vendorId = vendorScopeOf(staffOf(req));
    if (!vendorId) {
      // A manager has a food court but no kitchen. Refusing here is deliberate:
      // "any vendor in your court" would let one bad id reach another stall.
      throw new AppError('TENANT_SCOPE_VIOLATION', 'This account is not attached to a stall.');
    }
    return vendorId;
  }

  @Get('orders')
  async board(@Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.vendorId(req);

    // The stall's own name, returned on every board fetch.
    //
    // It was not returned at all, and the board header just said "Orders". At
    // a court with three stalls that means a cook — or anyone testing — has no
    // way to tell whose queue they are looking at, and an order that is simply
    // at a different stall is indistinguishable from an order that vanished.
    //
    // On the board response rather than the login response, so it stays right
    // when a token is restored from localStorage without a fresh sign-in.
    const vendor = await this.db
      .selectFrom('vendor')
      .select(['id', 'name'])
      .where('id', '=', vendorId)
      .executeTakeFirst();

    const stall = { id: vendorId, name: vendor?.name ?? 'Unknown stall' };

    /**
     * The customer's first name travels with the ticket.
     *
     * Optional, and null for most orders — nobody is required to give one. It
     * exists for the handover: calling "Ramesh, A-011" across a hall resolves
     * the case where two people both thought the number sounded like theirs,
     * and a number alone cannot.
     *
     * Joined straight off `order.customer_id`, not through `app_session`. The
     * first version routed via the session, which is a longer path to the same
     * row and one that breaks the moment a session expires while its order is
     * still cooking — the ticket would lose its name mid-service.
     *
     * A LEFT join, not an inner one. An order does not always have a customer
     * attached, and an inner join would silently empty the board for exactly
     * the orders that matter most.
     *
     * Only the NAME is joined. The phone number is not on this response and
     * should not be: a kitchen tablet is a screen several people can see, and
     * the stall has no reason to hold a customer's number.
     */
    const orders = await this.db
      .selectFrom('order')
      .leftJoin('customer', 'customer.id', 'order.customer_id')
      .select([
        'order.id as id',
        'order.public_order_number as public_order_number',
        'order.status as status',
        'order.created_at as created_at',
        'order.dispatched_at as dispatched_at',
        'order.acknowledged_at as acknowledged_at',
        'order.preparing_at as preparing_at',
        'order.ready_at as ready_at',
        'order.total_payable_paise as total_payable_paise',
        'customer.display_name as customer_name',
      ])
      .where('order.vendor_id', '=', vendorId)
      .where('order.status', 'in', LIVE)
      .orderBy('order.created_at')
      .execute();

    if (orders.length === 0) return { vendor: stall, orders: [] };

    const items = await this.db
      .selectFrom('order_item')
      .select(['order_id', 'name_snapshot', 'quantity', 'instructions'])
      .where(
        'order_id',
        'in',
        orders.map((o) => o.id),
      )
      .execute();

    return {
      vendor: stall,
      orders: orders.map((o) => ({
        orderId: o.id,
        orderNumber: o.public_order_number,
        status: o.status,
        placedAt: o.created_at.toISOString(),
        // The board sorts and colours by age. Sending the timestamp rather
        // than a computed "8 minutes" keeps the clock on the tablet, so a
        // stale response never shows a frozen counter.
        acknowledgedAt: o.acknowledged_at?.toISOString() ?? null,
        readyAt: o.ready_at?.toISOString() ?? null,
        totalPayablePaise: o.total_payable_paise,
        // Null unless the customer chose to give one.
        customerName: o.customer_name,
        items: items
          .filter((i) => i.order_id === o.id)
          .map((i) => ({
            name: i.name_snapshot,
            quantity: i.quantity,
            instructions: i.instructions,
          })),
      })),
    };
  }

  /**
   * The tablet says it is alive.
   *
   * This is what earns the right to have removed the vendor's accept click.
   * Vendor availability is DERIVED from heartbeat freshness (PRD KDS-HB-02), so
   * a stall whose tablet went to sleep stops appearing orderable to customers
   * within `DEVICE_OFFLINE_THRESHOLD_SECONDS` — rather than continuing to take
   * money for food nobody can see a ticket for.
   *
   * Cheap on purpose: one indexed UPDATE, no transaction, no read. The KDS
   * calls it every 15 seconds per stall, forever.
   */
  @Post('heartbeat')
  async heartbeat(@Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.vendorId(req);
    const now = new Date();

    await this.db
      .updateTable('vendor')
      .set({ kds_last_heartbeat_at: now })
      .where('id', '=', vendorId)
      .execute();

    // Returned so the board can show the stall its own state. A kitchen that
    // has been blocked for not acknowledging needs to know that, and the
    // customer-facing copy deliberately never says it.
    const vendor = await this.db
      .selectFrom('vendor')
      .select(['dispatch_blocked_at', 'temp_closed_until'])
      .where('id', '=', vendorId)
      .executeTakeFirst();

    /*
     * ========================================================================
     * WHAT HAS RUN OUT, AND WHAT IS ABOUT TO
     * ========================================================================
     *
     * ON THE HEARTBEAT, NOT ON THE BOARD.
     *
     * The heartbeat fires every fifteen seconds whichever tab is open; the
     * board query only runs on the Orders tab. A kitchen alert that arrives
     * only when somebody is already looking at the right screen is an alert for
     * a problem they have already seen.
     *
     * SILENT WHEN A COOK MARKED IT THEMSELVES.
     *
     * `availability = 'SOLD_OUT'` is the manual toggle — somebody stood at this
     * tablet and pressed it. Telling them what they just did is noise, and
     * noise is how an alert stops being read. What is news is an item that hit
     * zero on its own, from orders, while nobody was watching the count.
     *
     * LOW COMES WITH A NUMBER, because "running low" without one cannot be
     * acted on. Three portions left is a decision; "low" is a feeling.
     */
    const stockAlerts = await this.stockAlerts(vendorId);

    return {
      at: now.toISOString(),
      acceptingOrders: !vendor?.dispatch_blocked_at,
      blockedReason: vendor?.dispatch_blocked_at
        ? 'An order has been waiting too long. Accept it to start receiving new orders.'
        : null,
      stockAlerts,
    };
  }

  /**
   * TRACKED items at or below their threshold, and the ones already at zero.
   *
   * The default threshold is a PLATFORM constant rather than a per-item NULL
   * meaning "no warning". A column whose absent value disables the feature
   * disables it for every existing row on the day it ships, and every row is
   * NULL on that day.
   */
  private async stockAlerts(
    vendorId: string,
  ): Promise<{ itemId: string; name: string; remaining: number; kind: 'OUT' | 'LOW' }[]> {
    const court = await this.db
      .selectFrom('vendor')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select('food_court.timezone as timezone')
      .where('vendor.id', '=', vendorId)
      .executeTakeFirst();

    if (!court) return [];

    const rows = await this.db
      .selectFrom('menu_item')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .leftJoin('v_menu_item_stock_remaining as stock', (join) =>
        join
          .onRef('stock.menu_item_id', '=', 'menu_item.id')
          .on('stock.service_date', '=', serviceDateFor(new Date(), court.timezone)),
      )
      .select([
        'menu_item.id as itemId',
        'menu_item.name as name',
        'menu_item.availability as availability',
        'menu_item.low_stock_threshold as threshold',
        'stock.remaining as remaining',
      ])
      .where('menu.vendor_id', '=', vendorId)
      .where('menu_item.status', '=', 'ACTIVE')
      .where('menu_item.inventory_mode', '=', 'TRACKED')
      .execute();

    const out: { itemId: string; name: string; remaining: number; kind: 'OUT' | 'LOW' }[] = [];

    for (const r of rows) {
      // A cook's own toggle. See the note above — not news to the person who
      // pressed it, and the only person reading this screen is that person.
      if (r.availability === 'SOLD_OUT') continue;

      const remaining = r.remaining ?? 0;
      const threshold = r.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;

      if (remaining <= 0) out.push({ itemId: r.itemId, name: r.name, remaining: 0, kind: 'OUT' });
      else if (remaining <= threshold) {
        out.push({ itemId: r.itemId, name: r.name, remaining, kind: 'LOW' });
      }
    }

    // Emptiest first: the thing that has already run out matters more than the
    // thing with three left, and a cook reads the top of a list.
    return out.sort((a, b) => a.remaining - b.remaining || a.name.localeCompare(b.name));
  }

  /**
   * ONE TAP: the stall has it and is cooking it.
   *
   * WHY THIS COLLAPSES TWO STATES AND WHY BOTH SURVIVE
   *
   * The board used to ask for "Accept" and then "Start cooking". In a kitchen
   * those are one event — a cook who has taken the ticket is already reaching
   * for a pan — so the second tap was the interface asking a human to
   * corroborate something they had just said.
   *
   * The STATES are not collapsed, only the gesture. Both transitions are
   * written, in one transaction, with both history rows. That matters because
   * ACKNOWLEDGED is load-bearing elsewhere and deleting it would be expensive:
   *
   *   - it stops the escalation ladder (PRD §11.4);
   *   - under PAYMENTS_SPLIT_TIMING=ON_ACKNOWLEDGED it is the moment the money
   *     is captured, so it is a financial event, not a UI step;
   *   - when a real device acknowledgement lands — a ticket rendering on the
   *     tablet auto-acknowledging — ACKNOWLEDGED goes back to being a machine
   *     event and PREPARING becomes the cook's first tap. The path to that is
   *     kept open by not throwing the state away today.
   *
   * `/preparing` stays as an endpoint for exactly that future. It is simply not
   * on the board any more.
   */
  @Post('orders/:orderId/accept')
  async accept(@Req() req: RequestWithStaff, @Param('orderId') id: string): Promise<unknown> {
    await this.transition(req, id, 'ACKNOWLEDGED');
    return this.transition(req, id, 'PREPARING');
  }

  @Post('orders/:orderId/acknowledge')
  ack(@Req() req: RequestWithStaff, @Param('orderId') id: string): Promise<unknown> {
    return this.transition(req, id, 'ACKNOWLEDGED');
  }

  @Post('orders/:orderId/preparing')
  preparing(@Req() req: RequestWithStaff, @Param('orderId') id: string): Promise<unknown> {
    return this.transition(req, id, 'PREPARING');
  }

  @Post('orders/:orderId/ready')
  ready(@Req() req: RequestWithStaff, @Param('orderId') id: string): Promise<unknown> {
    return this.transition(req, id, 'READY');
  }

  /**
   * `/collect`, not `/complete`.
   *
   * The old path is gone rather than aliased. An alias would let a client keep
   * calling the word the PRD retired, and the vocabulary would survive in the
   * wire contract long after it left the database — which is how a rename ends
   * up half done for a year.
   */
  @Post('orders/:orderId/collect')
  collect(@Req() req: RequestWithStaff, @Param('orderId') id: string): Promise<unknown> {
    return this.transition(req, id, 'COLLECTED');
  }

  @Post('orders/:orderId/reject')
  async reject(
    @Req() req: RequestWithStaff,
    @Param('orderId') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const { reason, note } = RejectBody.parse(body);
    // A reason is mandatory in the schema too (order_rejection_reason_required).
    // Without one, "why did this stall reject 40 orders" has no answer, and
    // that question is the whole point of tracking rejections.
    return this.transition(req, id, 'REJECTED', reason, note ?? null);
  }

  /**
   * One guarded transition, through the shared primitive.
   *
   * This used to be forty lines of lock-check-write-append, duplicated from
   * nowhere and about to be duplicated into the payment engine. It now delegates
   * to `transitionOrder`, which owns the row lock, the allow-list check and the
   * history append. The vendor scope travels as `requireVendorId` so the 404
   * for another stall's order still comes from inside the lock.
   */
  private async transition(
    req: RequestWithStaff,
    orderId: string,
    to: OrderStatus,
    rejectionReason: RejectionReason | null = null,
    rejectionNote: string | null = null,
  ): Promise<unknown> {
    const vendorId = this.vendorId(req);
    const actorId = staffOf(req).userId;
    const correlationId = currentCorrelationId();

    const result = await this.db.transaction().execute(async (trx) => {
      const r = await transitionOrder(trx, {
        orderId,
        to,
        actorType: 'VENDOR_USER',
        actorId,
        correlationId,
        requireVendorId: vendorId,
        rejectionReason,
        rejectionNote,
      });

      /**
       * A rejection is a privileged act and now leaves a record.
       *
       * `AUDITED_ACTIONS` has listed `order.rejected` since the first week and
       * nothing wrote it, so §12.1's "why did this stall reject forty orders
       * must have an answer" had none — the reason was on the order row, but
       * who did it, when, and from what state were not.
       *
       * In the transaction, so a rejection that rolls back does not leave an
       * audit row saying it happened.
       */
      if (to === 'REJECTED' && r.changed) {
        await this.audit.write(
          buildAuditEntry({
            action: 'order.rejected',
            entity: 'order',
            entityId: orderId,
            vendorId,
            beforeValue: { status: r.from },
            afterValue: { status: r.status, reason: rejectionReason, note: rejectionNote },
          }),
          trx,
        );
      }

      return r;
    });

    // Stop the ladder the moment the kitchen has it, rather than waiting for
    // the next sweep to notice. The sweep's own status check still covers this
    // if the call below never happens — two paths, and the slower one is the
    // one that cannot be forgotten.
    if (to === 'ACKNOWLEDGED' && result.changed) {
      await this.escalation.cancelForAcknowledgement(orderId, vendorId);
    }

    // The cook gets told the food was refused and the money is going back, so
    // "did that refund actually start" is answerable at the counter.
    if (to === 'REJECTED' && result.changed) {
      const req2 = await this.notifications.requestFor(orderId, 'order.rejected', correlationId);
      if (req2) await this.notifications.notify(req2);
    }

    return {
      orderId,
      orderNumber: result.orderNumber,
      status: result.status,
      changed: result.changed,
    };
  }
}
