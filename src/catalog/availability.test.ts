import { describe, it, expect } from 'vitest';
import {
  vendorAvailability,
  customerFacingReason,
  itemAvailable,
  itemReasonCopyKey,
  itemState,
  type VendorAvailabilityInput,
} from './availability.js';

const NOW = new Date('2026-08-10T12:30:00Z');
const OPTS = { now: NOW, offlineThresholdSeconds: 60 };
const fresh = new Date(NOW.getTime() - 5_000);

function vendor(over: Partial<VendorAvailabilityInput> = {}): VendorAvailabilityInput {
  return { status: 'ACTIVE', kdsLastHeartbeatAt: fresh, ...over };
}

describe('vendor availability is derived, never stored (CUS-VEN-03)', () => {
  it('is orderable when active with a fresh heartbeat', () => {
    expect(vendorAvailability(vendor(), OPTS)).toEqual({
      orderable: true,
      unavailableReason: null,
    });
  });

  it('is unavailable when the KDS heartbeat is stale (KDS-HB-02)', () => {
    const stale = new Date(NOW.getTime() - 61_000);
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: stale }), OPTS)).toEqual({
      orderable: false,
      unavailableReason: 'DEVICE_OFFLINE',
    });
  });

  it('treats a never-seen device as offline, not as available', () => {
    // The dangerous default. An unknown heartbeat must not mean "fine".
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: null }), OPTS).orderable).toBe(false);
  });

  it('recovers automatically as soon as the heartbeat resumes (KDS-HB-03)', () => {
    const stale = new Date(NOW.getTime() - 120_000);
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: stale }), OPTS).orderable).toBe(false);
    // No manual re-enable step — a wi-fi blip must not need a phone call.
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: NOW }), OPTS).orderable).toBe(true);
  });

  it('is exactly at the threshold, not one second either side', () => {
    const exactly60 = new Date(NOW.getTime() - 60_000);
    const just59 = new Date(NOW.getTime() - 59_000);
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: exactly60 }), OPTS).orderable).toBe(
      false,
    );
    expect(vendorAvailability(vendor({ kdsLastHeartbeatAt: just59 }), OPTS).orderable).toBe(true);
  });

  it('is blocked while an unacknowledged order is past 90s', () => {
    // Escalation ladder step 3. The vendor stops receiving NEW orders.
    expect(vendorAvailability(vendor({ dispatchBlockedAt: NOW }), OPTS).unavailableReason).toBe(
      'DISPATCH_BLOCKED',
    );
  });

  it('respects a temporary closure and expires it', () => {
    const until = new Date(NOW.getTime() + 30 * 60_000);
    expect(vendorAvailability(vendor({ tempClosedUntil: until }), OPTS).unavailableReason).toBe(
      'TEMPORARILY_CLOSED',
    );
    const past = new Date(NOW.getTime() - 60_000);
    expect(vendorAvailability(vendor({ tempClosedUntil: past }), OPTS).orderable).toBe(true);
  });

  it('a suspended vendor is unavailable regardless of heartbeat', () => {
    expect(vendorAvailability(vendor({ status: 'SUSPENDED' }), OPTS).unavailableReason).toBe(
      'SUSPENDED',
    );
  });

  it('respects operating hours when supplied', () => {
    const withHours = vendor({ openWindows: [[660, 960]] }); // 11:00-16:00
    expect(vendorAvailability(withHours, { ...OPTS, minutesSinceMidnight: 750 }).orderable).toBe(
      true,
    );
    expect(
      vendorAvailability(withHours, { ...OPTS, minutesSinceMidnight: 1000 }).unavailableReason,
    ).toBe('OUTSIDE_HOURS');
  });

  it('prioritises suspension over every other reason', () => {
    const worst = vendor({
      status: 'SUSPENDED',
      dispatchBlockedAt: NOW,
      kdsLastHeartbeatAt: null,
    });
    expect(vendorAvailability(worst, OPTS).unavailableReason).toBe('SUSPENDED');
  });
});

describe('the customer never learns it was a device problem', () => {
  it('maps device and dispatch states to a neutral badge', () => {
    // Telling a customer a stall's tablet is offline is odd, and unkind to the
    // stall. Screens & Copy: `vendor.unavailable.badge`.
    expect(customerFacingReason('DEVICE_OFFLINE')).toBe('vendor.unavailable.badge');
    expect(customerFacingReason('DISPATCH_BLOCKED')).toBe('vendor.unavailable.badge');
    expect(customerFacingReason('SUSPENDED')).toBe('vendor.unavailable.badge');
  });

  it('says "closed" only when it really is closed', () => {
    expect(customerFacingReason('OUTSIDE_HOURS')).toBe('vendor.closed.badge');
  });

  it('says nothing when available', () => {
    expect(customerFacingReason(null)).toBeNull();
  });
});

describe('product, availability and inventory are three questions (PRD §6)', () => {
  const ACTIVE = { status: 'ACTIVE', availability: 'AVAILABLE' } as const;

  it('an available item on an active product is orderable', () => {
    expect(itemState(ACTIVE, NOW)).toEqual({ orderable: true, reason: null, listed: true });
  });

  it('discontinued is not a kind of sold out — it is not on the menu', () => {
    // The distinction that motivated the whole split. Under one boolean these
    // were the same edit, so a vendor who ran out at 1pm deleted the item.
    const gone = itemState({ status: 'INACTIVE', availability: 'AVAILABLE' }, NOW);
    expect(gone.orderable).toBe(false);
    expect(gone.reason).toBe('DISCONTINUED');
    expect(gone.listed, 'a discontinued item must not be rendered at all').toBe(false);
  });

  it('sold out stays listed, so the customer sees it was a real choice', () => {
    const out = itemState({ status: 'ACTIVE', availability: 'SOLD_OUT' }, NOW);
    expect(out.orderable).toBe(false);
    expect(out.listed).toBe(true);
  });

  it('auto-clears at the next service day (KDS-STK-03)', () => {
    // Vendors forget to re-enable items; customers should not pay for that.
    // Derived at read time, so the item returns even if no sweeper ran.
    const item = {
      status: 'ACTIVE',
      availability: 'SOLD_OUT',
      availableFrom: new Date('2026-08-11T04:00:00Z'),
    } as const;
    expect(itemAvailable(item, NOW)).toBe(false);
    expect(itemAvailable(item, new Date('2026-08-11T05:00:00Z'))).toBe(true);
  });

  it('a lapsed block beats a stale flag nobody cleared', () => {
    const item = {
      status: 'ACTIVE',
      availability: 'TEMPORARILY_UNAVAILABLE',
      availableFrom: new Date('2026-08-10T00:00:00Z'),
    } as const;
    expect(itemAvailable(item, NOW)).toBe(true);
  });
});

describe('inventory only gates items that keep a count', () => {
  it('an UNTRACKED item is orderable whatever remaining says', () => {
    // `remaining` on an UNTRACKED item is a caller bug, not a reason to refuse
    // the sale. The mode decides, never the presence of data.
    const item = {
      status: 'ACTIVE',
      availability: 'AVAILABLE',
      inventoryMode: 'UNTRACKED',
      remaining: 0,
    } as const;
    expect(itemAvailable(item, NOW)).toBe(true);
  });

  it('a TRACKED item at zero is out of stock', () => {
    const s = itemState(
      { status: 'ACTIVE', availability: 'AVAILABLE', inventoryMode: 'TRACKED', remaining: 0 },
      NOW,
    );
    expect(s.orderable).toBe(false);
    expect(s.reason).toBe('OUT_OF_STOCK');
  });

  it('a TRACKED item with stock left is orderable', () => {
    const s = itemState(
      { status: 'ACTIVE', availability: 'AVAILABLE', inventoryMode: 'TRACKED', remaining: 1 },
      NOW,
    );
    expect(s.orderable).toBe(true);
  });

  it('a TRACKED item already oversold stays refused rather than going negative twice', () => {
    const s = itemState(
      { status: 'ACTIVE', availability: 'AVAILABLE', inventoryMode: 'TRACKED', remaining: -2 },
      NOW,
    );
    expect(s.orderable).toBe(false);
  });

  it('tells the customer the same thing for sold out and out of stock', () => {
    // One is a switch a cook flipped, the other is a count reaching zero. That
    // difference is the vendor's business and not the diner's.
    expect(itemReasonCopyKey('SOLD_OUT')).toBe(itemReasonCopyKey('OUT_OF_STOCK'));
  });
});
