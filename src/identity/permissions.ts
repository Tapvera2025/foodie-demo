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
  'order.complete',
  'order.reject',
  'order.cancel.self',
  'order.force_cancel',
  'refund.initiate',
  'refund.retry',
  'stock.toggle',
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
  'order.complete': {
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

  'stock.toggle': { DEVICE: ALLOW, VENDOR_OPERATOR: ALLOW, VENDOR_OWNER: ALLOW },
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
};

export function grantFor(permission: Permission, role: Role): Grant | undefined {
  return PERMISSION_MATRIX[permission][role];
}
