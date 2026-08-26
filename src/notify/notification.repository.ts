/**
 * Sending a notification, exactly once per tier.
 *
 * PRD §10: "the same event does not notify twice on one channel", guaranteed by
 * `notification_dedupe_uq` on (order_id, event_key, event_version, tier) rather
 * than by a lookup — a lookup-then-insert races, and the race is two workers
 * reacting to the same state change.
 *
 * CLAIM, THEN SEND
 *
 * The row is inserted QUEUED first and updated after the attempt. The reverse
 * order sends and then records, so a crash in between produces a message the
 * table has never heard of, and the retry sends it again.
 *
 * That ordering has one failure of its own: a crash after the claim leaves a
 * QUEUED row that never went anywhere, and a naive dedupe would treat it as
 * already sent. So a stale QUEUED row is explicitly retryable. "At most once"
 * is the specification; "never" is not, and for the one message this product
 * genuinely owes a customer the difference matters.
 */

import type { Kysely } from 'kysely';

import { log } from '../platform/logger.js';
import type { Database, NotificationTier } from '../platform/schema.js';
import { CUSTOMER_TIERS, renderMessage, type Channel, type NotificationRequest } from './channel.js';

/** After this, a QUEUED row is assumed to be the debris of a crash. */
const STALE_QUEUED_SECONDS = 120;

export interface LadderResult {
  readonly delivered: boolean;
  readonly deliveredBy: NotificationTier | null;
  readonly attempted: readonly { tier: NotificationTier; status: string; reason?: string }[];
}

export class NotificationRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ladder: readonly Channel[],
  ) {}

  /**
   * Walk the ladder until something reports success.
   *
   * Returns `delivered: false` when every tier skipped or failed. The caller
   * should treat that as a real event — it means a customer is sitting at a
   * table waiting for food that is on the counter, and nobody has told them.
   */
  async notify(req: NotificationRequest): Promise<LadderResult> {
    const attempted: { tier: NotificationTier; status: string; reason?: string }[] = [];

    /**
     * IF ANY TIER ALREADY DELIVERED THIS EVENT, THE LADDER IS OVER.
     *
     * The dedupe index is `(order_id, event_key, event_version, tier)` — per
     * tier, exactly as §10 specifies — and `ALREADY_HANDLED` below therefore
     * `continue`s to the next rung. That is right for two workers racing on the
     * same tick. It is wrong for the same event arriving on a later tick, and
     * `notifyReady` re-queries every READY order every 1.5 seconds by design.
     *
     * So the observed behaviour was: tick 1 delivered on WhatsApp and stopped;
     * tick 2 walked past the three claimed rungs and delivered on SMS. One
     * "your food is ready" per tick, one rung lower each time, until the ladder
     * ran out. Invisible today because every tier is a console stub. With a
     * real BSP and real DLT it is two paid messages to a confused customer.
     *
     * The per-tier index is still the concurrency guarantee. This is the
     * per-event one, and it belongs before the walk rather than inside it.
     */
    const alreadySent = await this.db
      .selectFrom('notification')
      .select('tier')
      .where('order_id', '=', req.orderId)
      .where('event_key', '=', req.event)
      .where('status', 'in', ['SENT', 'DELIVERED'])
      .executeTakeFirst();

    if (alreadySent) {
      return {
        delivered: true,
        deliveredBy: alreadySent.tier,
        attempted: [{ tier: alreadySent.tier, status: 'ALREADY_DELIVERED' }],
      };
    }

    for (const channel of this.ladder) {
      const claim = await this.claim(req, channel.tier);
      if (claim === 'ALREADY_HANDLED') {
        // Some other worker got here first, or this event was already sent on
        // this tier. Either way it is not ours to send.
        attempted.push({ tier: channel.tier, status: 'DEDUPED' });
        continue;
      }

      const outcome = channel.available(req)
        ? await channel.send(req)
        : ({
            status: 'SKIPPED',
            // Two different nothings. "This tier does not exist yet" is a
            // build state; "there is nobody to send to" is a configuration
            // problem somebody can fix this afternoon, and reading a table full
            // of `channel unavailable` would never tell them which they had.
            reason:
              req.recipientPhone === null
                ? 'no recipient: nothing to send to'
                : 'channel unavailable',
          } as const);

      await this.record(req, channel.tier, outcome);
      attempted.push({
        tier: channel.tier,
        status: outcome.status,
        ...(outcome.status !== 'SENT' ? { reason: outcome.reason } : {}),
      });

      if (outcome.status === 'SENT') {
        return { delivered: true, deliveredBy: channel.tier, attempted };
      }
    }

    // Loud, and at error level. The alternative is a quiet false in a return
    // value that three callers ignore.
    log().error(
      {
        event: 'notification_ladder_exhausted',
        orderId: req.orderId,
        orderNumber: req.orderNumber,
        notificationEvent: req.event,
        attempted,
      },
      `nobody was told: ${renderMessage(req)}`,
    );

    return { delivered: false, deliveredBy: null, attempted };
  }

  /**
   * Take the slot for (order, event, tier), or discover somebody already has.
   *
   * `ON CONFLICT DO NOTHING` returns no row when the slot is taken, which is
   * how the unique index becomes the concurrency control rather than a
   * post-hoc integrity check.
   */
  private async claim(
    req: NotificationRequest,
    tier: NotificationTier,
  ): Promise<'CLAIMED' | 'ALREADY_HANDLED'> {
    const inserted = await this.db
      .insertInto('notification')
      .values({
        order_id: req.orderId,
        event_key: req.event,
        recipient: req.recipientPhone,
        tier,
        status: 'QUEUED',
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();

    if (inserted) return 'CLAIMED';

    // The slot exists. Retry only if it is QUEUED debris from a crash — a SENT,
    // FAILED or SKIPPED row is a decision that has already been made.
    const existing = await this.db
      .selectFrom('notification')
      .select(['id', 'status', 'created_at'])
      .where('order_id', '=', req.orderId)
      .where('event_key', '=', req.event)
      .where('tier', '=', tier)
      .executeTakeFirst();

    if (!existing) return 'ALREADY_HANDLED';

    const stale =
      existing.status === 'QUEUED' &&
      Date.now() - existing.created_at.getTime() > STALE_QUEUED_SECONDS * 1000;

    if (stale) {
      log().warn(
        { event: 'notification_retrying_stale', orderId: req.orderId, tier },
        'a queued notification never sent; retrying it',
      );
      return 'CLAIMED';
    }

    return 'ALREADY_HANDLED';
  }

  private async record(
    req: NotificationRequest,
    tier: NotificationTier,
    outcome: { status: string; reason?: string; providerMessageId?: string; costPaise?: number },
  ): Promise<void> {
    await this.db
      .updateTable('notification')
      .set({
        status: outcome.status as 'SENT' | 'FAILED' | 'SKIPPED',
        attempts: 1,
        ...(outcome.providerMessageId !== undefined
          ? { provider_message_id: outcome.providerMessageId }
          : {}),
        ...(outcome.reason !== undefined ? { provider_response: outcome.reason } : {}),
        ...(outcome.costPaise !== undefined ? { cost_paise: outcome.costPaise } : {}),
        ...(outcome.status === 'SENT' ? { sent_at: new Date() } : {}),
      })
      .where('order_id', '=', req.orderId)
      .where('event_key', '=', req.event)
      .where('tier', '=', tier)
      .execute();
  }

  /**
   * Everything the ladder needs, from an order id.
   *
   * The phone comes from `customer`, not from `order.customer_phone_snapshot`.
   * The snapshot is what the customer typed at the time and exists for the
   * invoice; the customer row is the number that was actually verified, and it
   * is the one a message should go to.
   */
  async requestFor(
    orderId: string,
    event: NotificationRequest['event'],
    correlationId: string,
  ): Promise<NotificationRequest | null> {
    const row = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      .leftJoin('customer', 'customer.id', 'order.customer_id')
      .select([
        'order.id as id',
        'order.public_order_number as orderNumber',
        'vendor.name as vendorName',
        'customer.phone as phone',
      ])
      .where('order.id', '=', orderId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      event,
      orderId: row.id,
      orderNumber: row.orderNumber,
      vendorName: row.vendorName,
      recipientPhone: row.phone,
      correlationId,
    };
  }

  /**
   * The same request, addressed to whoever is on call.
   *
   * Deliberately a separate method rather than an optional argument on
   * `requestFor`. The two differ in who is being told and what they are being
   * told to do, and a boolean flag deciding which is one refactor away from
   * sending an operational alert to a customer.
   *
   * A null recipient is not an error here — `OPS_ONCALL_PHONE` may simply not
   * be set. The ladder then records SKIPPED against every tier with that as the
   * reason, which is the difference between knowing nobody was called and
   * assuming somebody was.
   */
  async opsRequestFor(
    orderId: string,
    event: NotificationRequest['event'],
    onCallPhone: string | null,
    correlationId: string,
  ): Promise<NotificationRequest | null> {
    const row = await this.db
      .selectFrom('order')
      .innerJoin('vendor', 'vendor.id', 'order.vendor_id')
      .select([
        'order.id as id',
        'order.public_order_number as orderNumber',
        'vendor.name as vendorName',
      ])
      .where('order.id', '=', orderId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      event,
      orderId: row.id,
      orderNumber: row.orderNumber,
      vendorName: row.vendorName,
      recipientPhone: onCallPhone,
      correlationId,
    };
  }
}

export { CUSTOMER_TIERS };
