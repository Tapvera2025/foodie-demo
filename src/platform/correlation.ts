/**
 * Request context, propagated with AsyncLocalStorage.
 *
 * PRD OBS-01: one correlation id spans API -> payment -> order -> dispatch ->
 * notification, so any order is traceable end to end from its public number.
 *
 * TDD §3.2.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ActorType =
  | 'CUSTOMER'
  | 'VENDOR_USER'
  | 'DEVICE'
  | 'MANAGER'
  | 'PLATFORM_OPS'
  | 'PLATFORM_FINANCE'
  | 'SUPER_ADMIN'
  | 'SYSTEM'
  | 'PROVIDER_WEBHOOK'
  | 'POS_WEBHOOK';

export interface RequestContext {
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly foodCourtId?: string;
  readonly vendorId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns undefined outside a request — callers must handle that. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Correlation id for logging. Falls back to a fresh id rather than throwing,
 * because a missing context must never be the reason a log line is lost.
 */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}

export function systemContext(correlationId = newCorrelationId()): RequestContext {
  return { correlationId, actorType: 'SYSTEM' };
}
