/**
 * Notification channels, and the ladder that walks them.
 *
 * PRD §11.4 and the NOTIF requirements. This is the pure half — which tiers
 * exist, in what order, and what each one can actually do today.
 *
 * THE POINT OF A LADDER RATHER THAN ONE CHANNEL
 *
 * "Your food is ready" is the only message this product genuinely owes a
 * customer, and every individual way of delivering it fails routinely. A
 * websocket dies when the phone sleeps. Web Push on iOS needs a home-screen
 * install nobody performs. WhatsApp needs a BSP. SMS needs DLT registration.
 * So the message is attempted down a list, and the first tier that reports
 * success stops the cascade.
 *
 * WHY UNAVAILABLE TIERS ARE RECORDED RATHER THAN SKIPPED SILENTLY
 *
 * A tier that is not built writes a `SKIPPED` row with a reason. It would be
 * less code to omit it — and then "the customer was never told" would be an
 * absence in the table, indistinguishable from an event that never happened.
 * PRD §2.2: a check whose failure mode is silence. The row is the difference
 * between knowing the ladder ran out and assuming it did not need to run.
 */

import { log } from '../platform/logger.js';
import type { NotificationTier } from '../platform/schema.js';

/** What the customer is being told. Keys, not sentences — copy lives elsewhere. */
export type NotificationEvent =
  /** The one that matters. Everything else is courtesy. */
  | 'order.ready'
  | 'order.confirmed'
  | 'order.rejected'
  | 'order.collected'
  | 'refund.initiated'
  /**
   * ALERTS FOR THE PLATFORM, NOT THE CUSTOMER.
   *
   * The escalation ladder has set `escalation_state.manager_alerted_at` at its
   * third rung since it was written, and nothing has ever read that column. It
   * was a gap when there was a floor manager who might notice a screen. It is a
   * dead end now that the product is sold direct to vendors and nobody from the
   * platform is in the building at all: the stall gets blocked at 90 seconds,
   * the order fails at 180, the customer is offered a refund, and no human is
   * told at any point in that sequence.
   *
   * Same table, same ladder mechanism, different recipient and different copy.
   * A message to somebody on call has to say what to DO, which is not a thing
   * any of the customer messages above needs to say.
   */
  | 'ops.order_stuck'
  | 'ops.dispatch_failed';

export interface NotificationRequest {
  readonly event: NotificationEvent;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly vendorName: string;
  /** E.164, or null when the order predates customer authentication. */
  readonly recipientPhone: string | null;
  readonly correlationId: string;
}

export type DeliveryOutcome =
  | { readonly status: 'SENT'; readonly providerMessageId?: string; readonly costPaise?: number }
  | { readonly status: 'FAILED'; readonly reason: string }
  /** The tier cannot run here. Recorded, not hidden. */
  | { readonly status: 'SKIPPED'; readonly reason: string };

export interface Channel {
  readonly tier: NotificationTier;
  /** False means every attempt records SKIPPED without a network call. */
  available(req: NotificationRequest): boolean;
  send(req: NotificationRequest): Promise<DeliveryOutcome>;
}

/**
 * Customer-facing tiers, cheapest and fastest first.
 *
 * WAKE_LOCK and DISPLAY_BOARD are deliberately absent: they are vendor-side
 * surfaces, and mixing them into the customer ladder would mean a kitchen
 * tablet lighting up counted as having told the diner.
 */
export const CUSTOMER_TIERS: readonly NotificationTier[] = [
  'WEBSOCKET',
  'WEB_PUSH',
  'WHATSAPP',
  'SMS',
];

// =============================================================================
// The copy
// =============================================================================

/**
 * Deliberately short, and it leads with the order number.
 *
 * Someone reads this on a lock screen, standing up, in a noisy hall. The number
 * is what they need in the first two words; the stall name is what tells them
 * which way to walk. Everything else is decoration that pushes those two out of
 * the preview.
 */
export function renderMessage(req: NotificationRequest): string {
  switch (req.event) {
    case 'order.ready':
      return `Order ${req.orderNumber} is ready. Collect from ${req.vendorName}.`;
    case 'order.confirmed':
      return `Order ${req.orderNumber} confirmed. ${req.vendorName} is preparing it.`;
    case 'order.rejected':
      // Never blames the stall and never leaves the money unexplained. ESC-02.
      return `Order ${req.orderNumber} could not be made. Your refund is on its way.`;
    case 'order.collected':
      return `Order ${req.orderNumber} collected. Thank you.`;
    case 'refund.initiated':
      return `A refund for order ${req.orderNumber} has been started.`;

    // Written for a phone on a bedside table, so the first clause is the verb.
    case 'ops.order_stuck':
      return (
        `STALL NOT RESPONDING: ${req.vendorName} has not accepted order ` +
        `${req.orderNumber} in 90s. They are now blocked from new orders. ` +
        `Call the stall — the customer is refunded automatically in 90s more.`
      );
    case 'ops.dispatch_failed':
      return (
        `ORDER FAILED: ${req.vendorName} never accepted ${req.orderNumber}. ` +
        `The customer has been offered a refund. The stall is still blocked.`
      );
  }
}

// =============================================================================
// Channels
// =============================================================================

/**
 * The socket tier.
 *
 * Reports SKIPPED rather than SENT, because there is no socket layer yet — the
 * PWA polls every four seconds instead. Claiming SENT here would satisfy the
 * ladder on the first rung and stop every real channel from ever being tried,
 * which is the worst available bug: the logs would show 100% delivery and no
 * customer would learn anything.
 */
export class WebsocketChannel implements Channel {
  readonly tier = 'WEBSOCKET' as const;

  available(): boolean {
    return false;
  }

  async send(): Promise<DeliveryOutcome> {
    return {
      status: 'SKIPPED',
      reason: 'no socket layer; the client polls authoritative state every 4s',
    };
  }
}

export class WebPushChannel implements Channel {
  readonly tier = 'WEB_PUSH' as const;

  available(): boolean {
    return false;
  }

  async send(): Promise<DeliveryOutcome> {
    return {
      status: 'SKIPPED',
      // Worth stating precisely: this is not merely unbuilt, it is unbuilt for
      // a reason that will not go away. Web Push on iOS requires the customer
      // to add the page to their home screen first, which nobody does for one
      // plate of noodles. WhatsApp is the answer for the pilot.
      reason: 'no VAPID keys; and iOS requires a home-screen install first',
    };
  }
}

/**
 * Development delivery: the message goes to the log.
 *
 * Sits at the END of the ladder as a catch-all so a local run shows what a
 * customer would have received. Refuses production for the same reason
 * `ConsoleOtpChannel` does — logging a message is not sending it, and a
 * production ladder that "succeeds" this way tells nobody anything while
 * reporting a clean delivery rate.
 */
export class ConsoleChannel implements Channel {
  readonly tier: NotificationTier;

  constructor(tier: NotificationTier, nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error(
        'ConsoleChannel constructed in production. Messages would be written to the log ' +
          'and never delivered. Complete DLT registration (PRD §19 decision 1) or WhatsApp ' +
          'BSP onboarding before deploying.',
      );
    }
    this.tier = tier;
  }

  available(req: NotificationRequest): boolean {
    // Still requires a recipient. An order placed before customer OTP existed
    // has nobody to tell, and pretending otherwise would hide exactly the
    // orders where the ladder cannot help.
    return req.recipientPhone !== null;
  }

  async send(req: NotificationRequest): Promise<DeliveryOutcome> {
    log().warn(
      {
        event: 'notification_console_delivery',
        tier: this.tier,
        orderNumber: req.orderNumber,
        to: req.recipientPhone,
      },
      `DEV ONLY — would send to ${req.recipientPhone}: ${renderMessage(req)}`,
    );
    return { status: 'SENT', providerMessageId: `console_${req.orderId}_${req.event}` };
  }
}

/**
 * Builds the customer ladder for the current environment.
 *
 * In development the real tiers are unavailable and the console tier stands in
 * at the WhatsApp and SMS positions, so the shape of the cascade — try, skip,
 * try, succeed — is the shape that will run in production. Only the last hop
 * changes when DLT and the BSP land.
 */
/**
 * The ladder for whoever is on call.
 *
 * No websocket and no web push, and that is the whole difference. Those two
 * tiers assume somebody has the page open; the person this is for is not
 * looking at anything, which is precisely why the alert has to exist. So it
 * starts at the tiers that reach a phone that is face-down in a pocket.
 *
 * Both are console stubs today for the same reason the customer ones are — no
 * BSP, no DLT — and they report SKIPPED with that reason rather than pretending.
 * When those land, this ladder becomes real on the same day the customer one
 * does, without a second integration.
 */
export function buildOpsLadder(nodeEnv: string): readonly Channel[] {
  return [new ConsoleChannel('WHATSAPP', nodeEnv), new ConsoleChannel('SMS', nodeEnv)];
}

export function buildCustomerLadder(nodeEnv: string): readonly Channel[] {
  return [
    new WebsocketChannel(),
    new WebPushChannel(),
    new ConsoleChannel('WHATSAPP', nodeEnv),
    new ConsoleChannel('SMS', nodeEnv),
  ];
}
