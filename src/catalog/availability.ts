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

export interface ItemAvailabilityInput {
  readonly isAvailable: boolean;
  readonly unavailableUntil?: Date | null;
}

/**
 * PRD KDS-STK-03: an out-of-stock flag auto-clears at the start of the next
 * service day. Vendors forget to re-enable items; the system should not punish
 * customers for that.
 */
export function itemAvailable(item: ItemAvailabilityInput, now: Date): boolean {
  if (item.unavailableUntil != null) {
    return item.unavailableUntil.getTime() <= now.getTime();
  }
  return item.isAvailable;
}
