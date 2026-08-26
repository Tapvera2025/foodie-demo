/**
 * Vendor and item availability.
 *
 * PRD CUS-VEN-03 and KDS-HB-02: availability is DERIVED at read time from
 * configured hours, temporary closure, dispatch block and heartbeat freshness.
 * It is never stored as a boolean, because a stored boolean goes stale exactly
 * when it matters — during a wi-fi drop at lunchtime.
 *
 * Mirrors the SQL in TDD §9.3. Kept as a pure function so it can be tested
 * without a database and reused by the KDS and manager surfaces.
 */

export type UnavailableReason =
  'OUTSIDE_HOURS' | 'TEMPORARILY_CLOSED' | 'DEVICE_OFFLINE' | 'DISPATCH_BLOCKED' | 'SUSPENDED';

export interface VendorAvailabilityInput {
  readonly status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  readonly tempClosedUntil?: Date | null;
  readonly dispatchBlockedAt?: Date | null;
  readonly kdsLastHeartbeatAt?: Date | null;
  /** Minutes since midnight, in the court's timezone, as [open, close) pairs. */
  readonly openWindows?: readonly (readonly [number, number])[];
}

export interface AvailabilityOptions {
  readonly now: Date;
  /** Config: DEVICE_OFFLINE_THRESHOLD_SECONDS, default 60. */
  readonly offlineThresholdSeconds: number;
  /** Minutes since midnight in court-local time. Caller converts. */
  readonly minutesSinceMidnight?: number;
}

export interface VendorAvailability {
  readonly orderable: boolean;
  readonly unavailableReason: UnavailableReason | null;
}

export function vendorAvailability(
  v: VendorAvailabilityInput,
  opts: AvailabilityOptions,
): VendorAvailability {
  const deny = (reason: UnavailableReason): VendorAvailability => ({
    orderable: false,
    unavailableReason: reason,
  });

  if (v.status !== 'ACTIVE') return deny('SUSPENDED');

  if (v.tempClosedUntil != null && v.tempClosedUntil.getTime() > opts.now.getTime()) {
    return deny('TEMPORARILY_CLOSED');
  }

  // Set by the escalation ladder at 90s. The vendor stops receiving NEW orders
  // until they acknowledge the one they are sitting on. PRD §11.4.
  if (v.dispatchBlockedAt != null) return deny('DISPATCH_BLOCKED');

  // The heartbeat check is what earns the right to auto-fulfil. Without it we
  // would route paid orders at a dead tablet. PRD KDS-HB-02.
  const cutoff = opts.now.getTime() - opts.offlineThresholdSeconds * 1000;
  if (v.kdsLastHeartbeatAt == null || v.kdsLastHeartbeatAt.getTime() <= cutoff) {
    return deny('DEVICE_OFFLINE');
  }

  if (v.openWindows !== undefined && opts.minutesSinceMidnight !== undefined) {
    const m = opts.minutesSinceMidnight;
    const open = v.openWindows.some(([from, to]) => m >= from && m < to);
    if (!open) return deny('OUTSIDE_HOURS');
  }

  return { orderable: true, unavailableReason: null };
}

/**
 * The customer never learns that a vendor's tablet is the problem.
 *
 * Screens & Copy: `vendor.unavailable.badge` reads "Not taking orders" for both
 * DEVICE_OFFLINE and DISPATCH_BLOCKED. Exposing device state would be an odd
 * thing to tell a customer and an unkind thing to tell them about a stall.
 */
export function customerFacingReason(reason: UnavailableReason | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'OUTSIDE_HOURS':
      return 'vendor.closed.badge';
    case 'TEMPORARILY_CLOSED':
    case 'DEVICE_OFFLINE':
    case 'DISPATCH_BLOCKED':
    case 'SUSPENDED':
      return 'vendor.unavailable.badge';
  }
}

/**
 * PRD §6 — three concepts, kept apart.
 *
 * `status` answers "does this exist on the menu", `availability` answers "can I
 * order it right now", and `remaining` answers "how many are left". They fail
 * for different reasons and a customer should be told the right one: an item
 * that has been discontinued should not appear at all, an item that sold out
 * should appear greyed with a reason, and an item with stock left should be
 * orderable. Collapsing them meant a vendor who ran out at 1pm had to delete
 * the item and remember to recreate it in the morning. Nobody remembers.
 */
export interface ItemAvailabilityInput {
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly availability: 'AVAILABLE' | 'SOLD_OUT' | 'TEMPORARILY_UNAVAILABLE';
  /** When availability reverts by itself. Null while available. */
  readonly availableFrom?: Date | null;
  readonly inventoryMode?: 'TRACKED' | 'UNTRACKED';
  /** Only consulted when inventoryMode is TRACKED. Computed, never stored. */
  readonly remaining?: number | null;
}

export type ItemUnavailableReason =
  | 'DISCONTINUED'
  | 'SOLD_OUT'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'OUT_OF_STOCK';

export interface ItemState {
  readonly orderable: boolean;
  readonly reason: ItemUnavailableReason | null;
  /** False means do not render it at all, rather than render it greyed. */
  readonly listed: boolean;
}

/**
 * PRD KDS-STK-03: a sold-out flag auto-clears at the start of the next service
 * day. Vendors forget to re-enable items, and the system should not punish
 * customers for that — but the clearing is derived at read time rather than
 * written by a job, so an item comes back on its own even if no job ran.
 */
export function itemState(item: ItemAvailabilityInput, now: Date): ItemState {
  // Discontinued is not a kind of unavailable. It is not on the menu.
  if (item.status !== 'ACTIVE') {
    return { orderable: false, reason: 'DISCONTINUED', listed: false };
  }

  // A block that has lapsed is not a block. Checked before the availability
  // value so a stale flag nobody cleared cannot outlive its own deadline.
  const blockLapsed = item.availableFrom != null && item.availableFrom.getTime() <= now.getTime();

  if (!blockLapsed && item.availability === 'SOLD_OUT') {
    return { orderable: false, reason: 'SOLD_OUT', listed: true };
  }
  if (!blockLapsed && item.availability === 'TEMPORARILY_UNAVAILABLE') {
    return { orderable: false, reason: 'TEMPORARILY_UNAVAILABLE', listed: true };
  }

  // Inventory is the last gate, and only where a count is actually kept.
  // An UNTRACKED item with `remaining` set is a bug in the caller, not a
  // reason to refuse the sale — so the mode decides, not the presence of data.
  if (item.inventoryMode === 'TRACKED' && (item.remaining ?? 0) <= 0) {
    return { orderable: false, reason: 'OUT_OF_STOCK', listed: true };
  }

  return { orderable: true, reason: null, listed: true };
}

/** Convenience for the many call sites that only need the boolean. */
export function itemAvailable(item: ItemAvailabilityInput, now: Date): boolean {
  return itemState(item, now).orderable;
}

/**
 * What the customer is told. SOLD_OUT and OUT_OF_STOCK are the same sentence
 * to them — one is a switch a cook flipped and the other is a count reaching
 * zero, and that distinction is the vendor's business, not the diner's.
 */
export function itemReasonCopyKey(reason: ItemUnavailableReason | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'DISCONTINUED':
      return null; // Not shown at all.
    case 'SOLD_OUT':
    case 'OUT_OF_STOCK':
      return 'item.soldout.badge';
    case 'TEMPORARILY_UNAVAILABLE':
      return 'item.unavailable.badge';
  }
}
