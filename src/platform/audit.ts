/**
 * Audit log.
 *
 * PRD SEC-09: audit entries exist for refunds, force cancellations, commercial
 * rule changes, user changes and configuration changes — each recording actor,
 * before value, after value and correlation id.
 *
 * The writer is a port. The database implementation lands with the tenancy
 * module; keeping it an interface means the domain modules depend on the shape,
 * not on Kysely.
 */

import { currentContext, type ActorType } from './correlation.js';
import { redact } from './logger.js';

/**
 * Actions that MUST be audited. Adding a privileged action means adding it
 * here — the type makes it a compile error to audit something unnamed, and a
 * review prompt to name it.
 */
export const AUDITED_ACTIONS = [
  'refund.initiated',
  'refund.retried',
  'order.force_cancelled',
  'order.rejected',
  'feerule.created',
  'feerule.updated',
  'vendor.created',
  'vendor.updated',
  'vendor.activated',
  'vendor.settlement_mode_changed',
  'vendor.suspended',
  'user.invited',
  'user.deactivated',
  'role.assigned',
  'role.revoked',
  'device.paired',
  'device.revoked',
  'table.qr.generated',
  'table.qr.deactivated',
  'table.qr.reassigned',
  'court.created',
  'court.updated',
  'court.suspended',
  'config.changed',
  'reconciliation.resolved',
  'menu.imported',
] as const;

export type AuditAction = (typeof AUDITED_ACTIONS)[number];

export interface AuditEntry {
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId?: string;
  readonly foodCourtId?: string;
  readonly vendorId?: string;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId: string;
}

export interface AuditInput {
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId?: string;
  readonly foodCourtId?: string;
  readonly vendorId?: string;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Builds the entry from the ambient request context so no call site can forget
 * to name the actor. An audit row that says "system" when a human did it is
 * worse than no audit row.
 */
export function buildAuditEntry(input: AuditInput): AuditEntry {
  const ctx = currentContext();
  return {
    actorType: ctx?.actorType ?? 'SYSTEM',
    ...(ctx?.actorId !== undefined ? { actorId: ctx.actorId } : {}),
    action: input.action,
    entity: input.entity,
    ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    ...(input.foodCourtId !== undefined ? { foodCourtId: input.foodCourtId } : {}),
    ...(input.vendorId !== undefined ? { vendorId: input.vendorId } : {}),
    ...(input.beforeValue !== undefined ? { beforeValue: input.beforeValue } : {}),
    ...(input.afterValue !== undefined ? { afterValue: input.afterValue } : {}),
    ...(input.metadata !== undefined ? { metadata: redact(input.metadata) } : {}),
    correlationId: ctx?.correlationId ?? 'no-context',
  };
}

/** Port. Implemented over `audit_log`, which is INSERT-only by grant. */
export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}
