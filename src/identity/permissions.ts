/**
 * The RBAC permission matrix.
 *
 * This file IS the matrix from Technical Design Document §13, encoded so it can
 * be tested rather than admired. PRD RBAC-02 requires that every privileged
 * action maps to a named permission and that the matrix is a test fixture —
 * adding an endpoint without a permission entry fails CI.
 *
 * Default is DENY. A permission absent from a role's column is denied, not
 * inherited from anywhere.
 */

export const PERMISSIONS = [
  'session.create',
  'catalog.read',
  'cart.write',
  'order.create',
  'order.read.own',
  'order.read.vendor',
  'order.read.court',
  'order.acknowledge',
  'order.prepare',
  'order.ready',
  'order.collect',
  'order.reject',
  'order.cancel.self',
  'order.force_cancel',
  'refund.initiate',
  'refund.retry',
  // Take money on a card machine at the counter. POS deployments only.
  //
  // Deliberately NOT folded into `order.collect`, though the same person often
  // does both within a minute of each other. Handing over a bag of food and
  // debiting somebody's card are different acts with different consequences
  // when done wrongly, and one permission for both would mean every cook who
  // can close a ticket can also charge a stranger's card.
  'payment.collect',
  // Availability and inventory are different acts on different objects (PRD §6).
  // "We're out of rolls" is a state change anyone on the line can make; setting
  // tomorrow's count of 100 is a planning decision. One permission for both
  // would mean a cook who can mark an item sold out can also silently set the
  // day's stock to zero, which looks identical to the customer and completely
  // different in the stock history.
  'stock.toggle',
  'inventory.write',
  'vendor.ordering.toggle',
  'device.read',
  'menu.write',
  'vendor.write',
  'vendor.user.manage',
  'table.qr.manage',
  'feerule.read',
  'feerule.write',
  'ledger.read',
  'settlement.read',
  'reconciliation.resolve',
  'audit.read',
  'tenant.manage',
  // Manual "sync now" / status check for the offline-sync demo milestone —
  // ops-only, same tier as the other platform-operations permissions.
  'sync.trigger',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'CUSTOMER',
  'DEVICE',
  'VENDOR_OPERATOR',
  'VENDOR_OWNER',
  'MANAGER',
  'COURT_OPERATOR',
  'PLATFORM_OPS',
  'PLATFORM_FINANCE',
  'SUPER_ADMIN',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Conditions that qualify a grant. Each one is enforced at the call site, and
 * each maps to a footnote in TDD §13.
 */
export type GrantCondition =
  /** Y* — only while the escalation ladder has offered cancellation (ESC-03). */
  | 'CANCELLATION_OFFERED'
  /** Y† — own vendor profile fields only; never settlement mode or commission. */
  | 'OWN_VENDOR_PROFILE_ONLY'
  /** Y‡ — own commercial terms only; never another vendor's. */
  | 'OWN_COMMERCIAL_TERMS_ONLY';

export type Grant =
  | { readonly kind: 'ALLOW' }
  /** `own` — scoped to rows belonging to this principal. */
  | { readonly kind: 'OWN' }
  /** `agg` — aggregate figures only, never per-vendor commercial terms (RBAC-03). */
  | { readonly kind: 'AGGREGATE' }
  | { readonly kind: 'CONDITIONAL'; readonly condition: GrantCondition };

const ALLOW: Grant = { kind: 'ALLOW' };
const OWN: Grant = { kind: 'OWN' };
const AGG: Grant = { kind: 'AGGREGATE' };
const IF = (condition: GrantCondition): Grant => ({ kind: 'CONDITIONAL', condition });

/**
 * Absent role = denied. This mirrors TDD §13 row for row; when that table
 * changes, change it here and the tests will tell you what you broke.
 */
export const PERMISSION_MATRIX: Readonly<
  Record<Permission, Readonly<Partial<Record<Role, Grant>>>>
> = {
  'session.create': { CUSTOMER: ALLOW },

  'catalog.read': {
    CUSTOMER: ALLOW,
    DEVICE: ALLOW,
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    MANAGER: ALLOW,
    COURT_OPERATOR: ALLOW,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },

  'cart.write': { CUSTOMER: ALLOW },
  'order.create': { CUSTOMER: ALLOW },
  'order.read.own': { CUSTOMER: ALLOW },

  'order.read.vendor': {
    DEVICE: ALLOW,
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },

  'order.read.court': {
    MANAGER: ALLOW,
    COURT_OPERATOR: AGG,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },

  // Machine event, not a human approval. Only a paired device emits it.
  'order.acknowledge': { DEVICE: ALLOW },

  'order.prepare': { DEVICE: ALLOW, VENDOR_OPERATOR: ALLOW, VENDOR_OWNER: ALLOW },
  'order.ready': { DEVICE: ALLOW, VENDOR_OPERATOR: ALLOW, VENDOR_OWNER: ALLOW },
  // Handing food over is a counter action, so a manager standing at the stall
  // can close a ticket the cook forgot. PRD §7.1.
  'order.collect': {
    DEVICE: ALLOW,
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    MANAGER: ALLOW,
  },
  'order.reject': {
    DEVICE: ALLOW,
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    PLATFORM_OPS: ALLOW,
  },

  'order.cancel.self': { CUSTOMER: IF('CANCELLATION_OFFERED') },

  'order.force_cancel': { MANAGER: ALLOW, PLATFORM_OPS: ALLOW },
  'refund.initiate': { MANAGER: ALLOW, PLATFORM_OPS: ALLOW, PLATFORM_FINANCE: ALLOW },
  'refund.retry': { PLATFORM_OPS: ALLOW, PLATFORM_FINANCE: ALLOW },

  /*
   * NOT `DEVICE`, and that is the whole point of the row.
   *
   * A paired kitchen tablet is a machine bolted to a wall in a hot room, shared
   * by whoever is on shift and signed in to nothing. It emits `acknowledge`
   * because that is a machine event. Charging a card is not: somebody is
   * accountable for it, the audit row has to name a person, and a device token
   * names a tablet.
   *
   * Same argument as `inventory.write` one screen down, applied to money.
   */
  'payment.collect': {
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    MANAGER: ALLOW,
    COURT_OPERATOR: ALLOW,
    PLATFORM_OPS: ALLOW,
  },

  'stock.toggle': { DEVICE: ALLOW, VENDOR_OPERATOR: ALLOW, VENDOR_OWNER: ALLOW },

  // Not DEVICE. A tablet mounted on a wall in a busy kitchen is the wrong
  // place to change a number that decides how much can be sold all day.
  'inventory.write': { VENDOR_OPERATOR: ALLOW, VENDOR_OWNER: ALLOW, PLATFORM_OPS: ALLOW },
  'vendor.ordering.toggle': {
    DEVICE: ALLOW,
    VENDOR_OPERATOR: ALLOW,
    VENDOR_OWNER: ALLOW,
    MANAGER: ALLOW,
    PLATFORM_OPS: ALLOW,
  },

  'device.read': { VENDOR_OWNER: ALLOW, MANAGER: ALLOW, PLATFORM_OPS: ALLOW },
  'menu.write': { VENDOR_OWNER: ALLOW, PLATFORM_OPS: ALLOW },
  'vendor.write': { VENDOR_OWNER: IF('OWN_VENDOR_PROFILE_ONLY'), PLATFORM_OPS: ALLOW },
  'vendor.user.manage': { VENDOR_OWNER: ALLOW, PLATFORM_OPS: ALLOW },
  'table.qr.manage': { MANAGER: ALLOW, PLATFORM_OPS: ALLOW },

  'feerule.read': {
    VENDOR_OWNER: IF('OWN_COMMERCIAL_TERMS_ONLY'),
    COURT_OPERATOR: OWN,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },
  // Deliberately finance-only. Commercial terms are not an ops decision.
  'feerule.write': { PLATFORM_FINANCE: ALLOW },

  'ledger.read': {
    VENDOR_OWNER: OWN,
    COURT_OPERATOR: OWN,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },
  'settlement.read': {
    VENDOR_OWNER: OWN,
    COURT_OPERATOR: OWN,
    PLATFORM_OPS: ALLOW,
    PLATFORM_FINANCE: ALLOW,
  },
  'reconciliation.resolve': { PLATFORM_OPS: ALLOW, PLATFORM_FINANCE: ALLOW },
  'audit.read': { PLATFORM_OPS: ALLOW, PLATFORM_FINANCE: ALLOW },

  // Absent from every other column, on purpose.
  'tenant.manage': { SUPER_ADMIN: ALLOW },

  'sync.trigger': { PLATFORM_OPS: ALLOW },
};

export function grantFor(permission: Permission, role: Role): Grant | undefined {
  return PERMISSION_MATRIX[permission][role];
}
