/**
 * Authorisation decisions and tenant scoping.
 *
 * Two rules govern everything here:
 *
 *  1. PRD RBAC-01 — tenant isolation is applied at the data-access layer, and a
 *     resource belonging to another tenant returns 404, never 403. A 403 leaks
 *     the fact that the resource exists.
 *
 *  2. Interface Specs §2.1 — claims are a performance optimisation, not the
 *     authorisation decision. A claim can only ever NARROW access. Tenant scope
 *     is re-resolved server-side on every request, so a forged or stale claim
 *     gets a 404 and a log line rather than someone else's orders.
 */

import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { grantFor, type GrantCondition, type Permission, type Role } from './permissions.js';

/** A role assignment as stored in `user_role_assignment`, always tenant-scoped. */
export interface RoleAssignment {
  readonly role: Role;
  readonly foodCourtId?: string;
  readonly vendorId?: string;
}

export interface Principal {
  readonly subjectId: string;
  readonly assignments: readonly RoleAssignment[];
}

/** The tenant a request is trying to touch. */
export interface ResourceScope {
  readonly foodCourtId?: string;
  readonly vendorId?: string;
  /** Owning subject, for `own`-scoped grants. */
  readonly ownerSubjectId?: string;
}

export interface DecisionContext {
  /** Conditions the call site has established as true. */
  readonly satisfied?: readonly GrantCondition[];
}

export type Decision =
  | { readonly allowed: true; readonly via: Role; readonly aggregateOnly: boolean }
  | { readonly allowed: false; readonly reason: DenyReason };

export type DenyReason =
  'NO_ROLE_GRANTS_PERMISSION' | 'OUT_OF_TENANT_SCOPE' | 'CONDITION_NOT_SATISFIED' | 'NOT_OWNER';

/**
 * Does this assignment cover the resource being touched?
 *
 * A vendor-scoped assignment covers only that vendor. A court-scoped assignment
 * covers the court and any vendor within it — but only when the caller has told
 * us which court the vendor belongs to. We never infer it from a client-supplied
 * value.
 */
function assignmentCoversScope(a: RoleAssignment, scope: ResourceScope): boolean {
  if (a.vendorId !== undefined) {
    return scope.vendorId === a.vendorId;
  }
  if (a.foodCourtId !== undefined) {
    if (scope.foodCourtId === undefined) return false;
    return scope.foodCourtId === a.foodCourtId;
  }
  // Platform-wide assignment (ops, finance, super admin).
  return true;
}

export function decide(
  principal: Principal,
  permission: Permission,
  scope: ResourceScope = {},
  ctx: DecisionContext = {},
): Decision {
  let sawGrantButOutOfScope = false;
  let sawGrantButConditionUnmet = false;
  let sawGrantButNotOwner = false;

  for (const assignment of principal.assignments) {
    const grant = grantFor(permission, assignment.role);
    if (grant === undefined) continue;

    if (!assignmentCoversScope(assignment, scope)) {
      sawGrantButOutOfScope = true;
      continue;
    }

    switch (grant.kind) {
      case 'ALLOW':
        return { allowed: true, via: assignment.role, aggregateOnly: false };

      case 'AGGREGATE':
        return { allowed: true, via: assignment.role, aggregateOnly: true };

      case 'OWN': {
        const owner = scope.ownerSubjectId;
        const owns =
          (assignment.vendorId !== undefined && assignment.vendorId === scope.vendorId) ||
          (owner !== undefined && owner === principal.subjectId);
        if (owns) return { allowed: true, via: assignment.role, aggregateOnly: false };
        sawGrantButNotOwner = true;
        continue;
      }

      case 'CONDITIONAL': {
        if (ctx.satisfied?.includes(grant.condition)) {
          return { allowed: true, via: assignment.role, aggregateOnly: false };
        }
        sawGrantButConditionUnmet = true;
        continue;
      }
    }
  }

  if (sawGrantButOutOfScope) return { allowed: false, reason: 'OUT_OF_TENANT_SCOPE' };
  if (sawGrantButNotOwner) return { allowed: false, reason: 'NOT_OWNER' };
  if (sawGrantButConditionUnmet) return { allowed: false, reason: 'CONDITION_NOT_SATISFIED' };
  return { allowed: false, reason: 'NO_ROLE_GRANTS_PERMISSION' };
}

export function can(
  principal: Principal,
  permission: Permission,
  scope: ResourceScope = {},
  ctx: DecisionContext = {},
): boolean {
  return decide(principal, permission, scope, ctx).allowed;
}

/**
 * Throws if not permitted.
 *
 * Note the deliberate asymmetry in what we throw:
 *
 *   OUT_OF_TENANT_SCOPE  -> TENANT_SCOPE_VIOLATION, which is HTTP 404.
 *                           The caller must not learn the resource exists.
 *                           Always logged and alertable (PRD SEC-01).
 *
 *   everything else      -> also 404 at the edge for reads; the distinction is
 *                           preserved in the reason for logging and tests.
 */
export function requirePermission(
  principal: Principal,
  permission: Permission,
  scope: ResourceScope = {},
  ctx: DecisionContext = {},
): void {
  const decision = decide(principal, permission, scope, ctx);
  if (decision.allowed) return;

  if (decision.reason === 'OUT_OF_TENANT_SCOPE') {
    log().warn(
      {
        event: 'tenant_scope_violation',
        actorId: principal.subjectId,
        ...(scope.foodCourtId !== undefined ? { foodCourtId: scope.foodCourtId } : {}),
        ...(scope.vendorId !== undefined ? { vendorId: scope.vendorId } : {}),
        reason: permission,
      },
      'cross-tenant access attempt',
    );
  }

  throw new AppError('TENANT_SCOPE_VIOLATION', `${permission}: ${decision.reason}`);
}

/**
 * The set of tenants a principal may read, resolved from stored assignments.
 *
 * Every list query filters by this. It is never derived from a token claim or a
 * query parameter — that is the difference between RBAC-01 being true and being
 * aspirational.
 */
export interface TenantScope {
  readonly platformWide: boolean;
  readonly foodCourtIds: readonly string[];
  readonly vendorIds: readonly string[];
}

export function resolveTenantScope(principal: Principal): TenantScope {
  const courts = new Set<string>();
  const vendors = new Set<string>();
  let platformWide = false;

  for (const a of principal.assignments) {
    if (a.vendorId !== undefined) vendors.add(a.vendorId);
    else if (a.foodCourtId !== undefined) courts.add(a.foodCourtId);
    else platformWide = true;
  }

  return {
    platformWide,
    foodCourtIds: [...courts],
    vendorIds: [...vendors],
  };
}
