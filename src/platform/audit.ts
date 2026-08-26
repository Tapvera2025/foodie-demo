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
  /*
   * Deactivation is its own action, not a flavour of suspension.
   *
   * They look similar and are not: suspension is reversible and covers a
   * temporary problem, INACTIVE is terminal and means the stall has left the
   * court. `canTransitionVendor` has no INACTIVE -> ACTIVE edge precisely
   * because coming back requires re-onboarding — stale bank details are how
   * money reaches the wrong account.
   *
   * Logging both under `vendor.suspended` would make the audit log unable to
   * answer "did this stall leave, or is it coming back", which is the question
   * somebody reading it six months later is actually asking.
   */
  'vendor.deactivated',
  'user.invited',
  'user.deactivated',
  /**
   * A new password issued for an existing login.
   *
   * Its own action rather than `user.invited`, because the two answer different
   * questions and the difference matters in exactly the situation an audit log
   * gets read. "This account was created on the 3rd" and "this account's
   * password was changed on the 19th" are the same row under one name, and the
   * second is the one somebody is looking for after a stall reports orders it
   * did not accept.
   */
  'user.password_reset',
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
  /** Un-suspending. Distinct from `court.created` — the venue already existed. */
  'court.activated',
  'court.deactivated',
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

/**
 * Port. Implemented by `audit.repository.ts` over `audit_log`, which is
 * append-only by TRIGGER — grants were the original claim and errata E-002 is
 * why that wording changed.
 *
 * The transaction argument is optional and load-bearing where it is used: an
 * audit row describing a change must commit with it or not at all.
 */
export interface AuditWriter {
  write(entry: AuditEntry, trx?: unknown): Promise<void>;
}
