import { describe, it, expect } from 'vitest';
import { PERMISSIONS, PERMISSION_MATRIX, ROLES, type Permission } from './permissions.js';
import { can, decide, requirePermission, resolveTenantScope, type Principal } from './rbac.js';
import { AppError } from '../platform/errors.js';

const COURT_A = 'court-a';
const COURT_B = 'court-b';
const VENDOR_A1 = 'vendor-a1';
const VENDOR_A2 = 'vendor-a2';

const customer: Principal = { subjectId: 'cus-1', assignments: [{ role: 'CUSTOMER' }] };
const deviceA1: Principal = {
  subjectId: 'dev-1',
  assignments: [{ role: 'DEVICE', vendorId: VENDOR_A1, foodCourtId: COURT_A }],
};
const ownerA1: Principal = {
  subjectId: 'usr-owner',
  assignments: [{ role: 'VENDOR_OWNER', vendorId: VENDOR_A1 }],
};
const managerA: Principal = {
  subjectId: 'usr-mgr',
  assignments: [{ role: 'MANAGER', foodCourtId: COURT_A }],
};
const operatorA: Principal = {
  subjectId: 'usr-op',
  assignments: [{ role: 'COURT_OPERATOR', foodCourtId: COURT_A }],
};
const finance: Principal = { subjectId: 'usr-fin', assignments: [{ role: 'PLATFORM_FINANCE' }] };
const ops: Principal = { subjectId: 'usr-ops', assignments: [{ role: 'PLATFORM_OPS' }] };
const superAdmin: Principal = { subjectId: 'usr-sa', assignments: [{ role: 'SUPER_ADMIN' }] };

describe('permission matrix is complete and well-formed (RBAC-02)', () => {
  it('every declared permission has a matrix row', () => {
    for (const p of PERMISSIONS) {
      expect(PERMISSION_MATRIX[p], `missing matrix row for ${p}`).toBeDefined();
    }
  });

  it('the matrix declares no permission that is not in the enum', () => {
    const declared = Object.keys(PERMISSION_MATRIX) as Permission[];
    expect(new Set(declared)).toEqual(new Set(PERMISSIONS));
  });

  it('the matrix grants nothing to an unknown role', () => {
    const known = new Set<string>(ROLES);
    for (const [permission, row] of Object.entries(PERMISSION_MATRIX)) {
      for (const role of Object.keys(row)) {
        expect(known.has(role), `${permission} grants unknown role ${role}`).toBe(true);
      }
    }
  });

  it('every permission is reachable by at least one role', () => {
    // A permission nobody can hold is dead code protecting nothing.
    for (const p of PERMISSIONS) {
      expect(Object.keys(PERMISSION_MATRIX[p]).length, `${p} is unreachable`).toBeGreaterThan(0);
    }
  });

  it('tenant.manage is super admin only', () => {
    expect(Object.keys(PERMISSION_MATRIX['tenant.manage'])).toEqual(['SUPER_ADMIN']);
  });

  it('feerule.write is finance only — commercial terms are not an ops decision', () => {
    expect(Object.keys(PERMISSION_MATRIX['feerule.write'])).toEqual(['PLATFORM_FINANCE']);
  });

  it('acknowledge is a machine event — devices only', () => {
    // PRD §9: acknowledgement is not a human approval. No human role holds it.
    expect(Object.keys(PERMISSION_MATRIX['order.acknowledge'])).toEqual(['DEVICE']);
  });
});

describe('tenant isolation (RBAC-01)', () => {
  it('a vendor owner cannot read another vendor in the same court', () => {
    expect(can(ownerA1, 'order.read.vendor', { vendorId: VENDOR_A1 })).toBe(true);
    expect(can(ownerA1, 'order.read.vendor', { vendorId: VENDOR_A2 })).toBe(false);
  });

  it('a cross-tenant attempt throws TENANT_SCOPE_VIOLATION, which is 404 not 403', () => {
    // 403 would confirm the resource exists. The gate for week 2 is that a
    // deliberate cross-tenant read returns 404 and is logged.
    try {
      requirePermission(ownerA1, 'order.read.vendor', { vendorId: VENDOR_A2 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('TENANT_SCOPE_VIOLATION');
      expect((e as AppError).httpStatus).toBe(404);
    }
  });

  it('a manager cannot see another court', () => {
    expect(can(managerA, 'order.read.court', { foodCourtId: COURT_A })).toBe(true);
    expect(can(managerA, 'order.read.court', { foodCourtId: COURT_B })).toBe(false);
  });

  it('a court-scoped assignment does not match when no court is supplied', () => {
    // We never infer the court from a client-supplied vendor id.
    expect(can(managerA, 'order.read.court', {})).toBe(false);
  });

  it('a device token is scoped to exactly one vendor (AUTH-04)', () => {
    expect(can(deviceA1, 'order.acknowledge', { vendorId: VENDOR_A1 })).toBe(true);
    expect(can(deviceA1, 'order.acknowledge', { vendorId: VENDOR_A2 })).toBe(false);
  });

  it('platform roles are not tenant-limited', () => {
    expect(can(ops, 'order.read.court', { foodCourtId: COURT_B })).toBe(true);
    expect(can(finance, 'ledger.read', { vendorId: VENDOR_A2 })).toBe(true);
  });
});

describe('grant kinds', () => {
  it('AGGREGATE tells the caller to withhold per-vendor commercial terms (RBAC-03)', () => {
    const d = decide(operatorA, 'order.read.court', { foodCourtId: COURT_A });
    expect(d.allowed).toBe(true);
    expect(d.allowed && d.aggregateOnly).toBe(true);
  });

  it('a normal allow is not aggregate-only', () => {
    const d = decide(managerA, 'order.read.court', { foodCourtId: COURT_A });
    expect(d.allowed && d.aggregateOnly).toBe(false);
  });

  it('OWN scopes a vendor owner to their own ledger', () => {
    expect(can(ownerA1, 'ledger.read', { vendorId: VENDOR_A1 })).toBe(true);
    expect(can(ownerA1, 'ledger.read', { vendorId: VENDOR_A2 })).toBe(false);
  });

  it('CONDITIONAL denies until the condition is established', () => {
    // ESC-03: customer cancellation only once the ladder has offered it at 180s.
    expect(can(customer, 'order.cancel.self')).toBe(false);
    expect(decide(customer, 'order.cancel.self').allowed).toBe(false);
    expect(can(customer, 'order.cancel.self', {}, { satisfied: ['CANCELLATION_OFFERED'] })).toBe(
      true,
    );
  });

  it('a vendor owner editing their profile is conditional, not blanket', () => {
    // Y† — profile fields yes, settlement mode and commission never.
    expect(can(ownerA1, 'vendor.write', { vendorId: VENDOR_A1 })).toBe(false);
    expect(
      can(
        ownerA1,
        'vendor.write',
        { vendorId: VENDOR_A1 },
        { satisfied: ['OWN_VENDOR_PROFILE_ONLY'] },
      ),
    ).toBe(true);
  });
});

describe('denial reasons are distinguishable for logging', () => {
  it('reports NO_ROLE_GRANTS_PERMISSION when the role simply lacks it', () => {
    const d = decide(customer, 'ledger.read');
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('NO_ROLE_GRANTS_PERMISSION');
  });

  it('reports OUT_OF_TENANT_SCOPE when the role has it elsewhere', () => {
    const d = decide(ownerA1, 'ledger.read', { vendorId: VENDOR_A2 });
    expect(!d.allowed && d.reason).toBe('OUT_OF_TENANT_SCOPE');
  });

  it('reports CONDITION_NOT_SATISFIED when only a condition is missing', () => {
    const d = decide(customer, 'order.cancel.self');
    expect(!d.allowed && d.reason).toBe('CONDITION_NOT_SATISFIED');
  });
});

describe('resolveTenantScope()', () => {
  it('derives scope from stored assignments, never from a claim', () => {
    expect(resolveTenantScope(ownerA1)).toEqual({
      platformWide: false,
      foodCourtIds: [],
      vendorIds: [VENDOR_A1],
    });
    expect(resolveTenantScope(managerA)).toEqual({
      platformWide: false,
      foodCourtIds: [COURT_A],
      vendorIds: [],
    });
    expect(resolveTenantScope(superAdmin).platformWide).toBe(true);
  });

  it('handles a user holding several assignments', () => {
    const multi: Principal = {
      subjectId: 'usr-multi',
      assignments: [
        { role: 'VENDOR_OWNER', vendorId: VENDOR_A1 },
        { role: 'VENDOR_OWNER', vendorId: VENDOR_A2 },
        { role: 'MANAGER', foodCourtId: COURT_B },
      ],
    };
    const scope = resolveTenantScope(multi);
    expect([...scope.vendorIds].sort()).toEqual([VENDOR_A1, VENDOR_A2]);
    expect(scope.foodCourtIds).toEqual([COURT_B]);
    expect(scope.platformWide).toBe(false);
  });
});
