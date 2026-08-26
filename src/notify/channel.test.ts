import { describe, it, expect } from 'vitest';

import {
  buildCustomerLadder,
  buildOpsLadder,
  ConsoleChannel,
  CUSTOMER_TIERS,
  renderMessage,
  WebPushChannel,
  WebsocketChannel,
  type NotificationRequest,
} from './channel.js';

function req(over: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    event: 'order.ready',
    orderId: 'o1',
    orderNumber: 'A27',
    vendorName: 'Spice Garden',
    recipientPhone: '+919876543210',
    correlationId: 'c1',
    ...over,
  };
}

describe('the message', () => {
  it('leads with the order number, then where to walk', () => {
    // Read on a lock screen, standing up, in a noisy hall. The number and the
    // stall are the only two facts that survive a truncated preview.
    const m = renderMessage(req());
    expect(m.startsWith('Order A27')).toBe(true);
    expect(m).toContain('Spice Garden');
    expect(m.length).toBeLessThan(80);
  });

  it('never blames the stall when an order is refused', () => {
    // ESC-02. The customer's relationship is with the court, and a message
    // that points at a vendor turns a refund into a complaint about a person.
    const m = renderMessage(req({ event: 'order.rejected' }));
    expect(m).not.toContain('Spice Garden');
    expect(m).toContain('refund');
  });
});

describe('the ladder is honest about what it cannot do', () => {
  it('the socket tier reports unavailable rather than success', () => {
    // The dangerous version claims SENT, satisfies the ladder on rung one, and
    // stops every real channel from ever being tried. Delivery would read as
    // 100% and no customer would learn anything.
    expect(new WebsocketChannel().available()).toBe(false);
  });

  it('web push reports unavailable, and says why', async () => {
    const outcome = await new WebPushChannel().send();
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.status === 'SKIPPED' && outcome.reason).toMatch(/iOS|home-screen/i);
  });

  it('a channel with no recipient is unavailable, not silently successful', () => {
    // An order placed before customer OTP existed has nobody to tell. Recording
    // that is the difference between knowing and assuming.
    const c = new ConsoleChannel('SMS', 'development');
    expect(c.available(req({ recipientPhone: null }))).toBe(false);
    expect(c.available(req())).toBe(true);
  });

  it('refuses to construct in production', () => {
    // A console channel in production logs every message and delivers none —
    // a total outage that looks, from the server's side, like success.
    expect(() => new ConsoleChannel('SMS', 'production')).toThrow(/production/i);
    expect(() => buildCustomerLadder('production')).toThrow();
  });
});

describe('ladder composition', () => {
  it('tries cheap and fast before expensive and slow', () => {
    expect(CUSTOMER_TIERS).toEqual(['WEBSOCKET', 'WEB_PUSH', 'WHATSAPP', 'SMS']);
  });

  it('excludes vendor-side surfaces', () => {
    // A kitchen tablet lighting up is not the diner being told.
    expect(CUSTOMER_TIERS).not.toContain('WAKE_LOCK');
    expect(CUSTOMER_TIERS).not.toContain('DISPLAY_BOARD');
  });

  it('keeps the production shape in development', () => {
    // Two dead rungs then a live one, so the cascade exercised locally is the
    // cascade that will run. Only the last hop changes when DLT lands.
    const ladder = buildCustomerLadder('development');
    expect(ladder.map((c) => c.tier)).toEqual([...CUSTOMER_TIERS]);
    expect(ladder.filter((c) => c.available(req())).map((c) => c.tier)).toEqual([
      'WHATSAPP',
      'SMS',
    ]);
  });
});

/**
 * The alert that wakes somebody up.
 *
 * `escalation_state.manager_alerted_at` was written from the day the ladder
 * shipped and read by nothing. That was a gap when a floor manager might notice
 * a screen; it is a dead end now that the product is sold direct to vendors and
 * nobody from the platform is in the building. A stall stops answering, it gets
 * blocked at 90 seconds, the order fails at 180, and until this existed no
 * human learned either fact.
 */
describe('the on-call ladder', () => {
  const stuck: NotificationRequest = {
    event: 'ops.order_stuck',
    orderId: 'o-1',
    orderNumber: 'A-014',
    vendorName: 'Wok This Way',
    recipientPhone: '+919000000999',
    correlationId: 'c-1',
  };

  it('starts at the tiers that reach a phone nobody is looking at', () => {
    const tiers = buildOpsLadder('development').map((c) => c.tier);
    expect(tiers).toEqual(['WHATSAPP', 'SMS']);
  });

  it('has no websocket or web push, and that is the whole difference', () => {
    // Both assume somebody has the page open. The person this is for is
    // asleep — which is precisely why the alert has to exist.
    const tiers = buildOpsLadder('development').map((c) => c.tier);
    expect(tiers).not.toContain('WEBSOCKET');
    expect(tiers).not.toContain('WEB_PUSH');
  });

  it('refuses to run in production for the same reason the customer one does', () => {
    // A console tier in production logs the page and wakes nobody, while
    // reporting a clean delivery rate.
    expect(() => buildOpsLadder('production')).toThrow();
  });

  it('tells the reader what to do, not just what happened', () => {
    const msg = renderMessage(stuck);
    expect(msg).toContain('A-014');
    expect(msg).toContain('Wok This Way');
    // The verb. A page that only reports a state leaves the reader to work out
    // whether it is theirs to act on, at whatever hour it arrives.
    expect(msg).toMatch(/call the stall/i);
    // And the deadline, because there is one.
    expect(msg).toMatch(/90s/);
  });

  it('says the money is already handled when the order has failed', () => {
    const msg = renderMessage({ ...stuck, event: 'ops.dispatch_failed' });
    expect(msg).toMatch(/refund/i);
  });

  it('skips rather than pretends when no on-call number is configured', () => {
    const channel = new ConsoleChannel('SMS', 'development');
    expect(channel.available({ ...stuck, recipientPhone: null })).toBe(false);
  });
});
