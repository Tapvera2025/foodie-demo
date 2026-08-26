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

/**
 * Name the principal, once it is known.
 *
 * `correlationMiddleware` seeds the context with CUSTOMER because that is the
 * truthful default before any credential has been checked, and its own comment
 * has said since the first week that the auth guard must REPLACE it rather than
 * sit alongside it. The guards landed and nothing did — which stayed invisible
 * for exactly as long as nothing wrote an audit row, and was caught by the
 * first one: a kitchen rejecting an order was recorded as the act of a
 * CUSTOMER.
 *
 * Mutates the stored object rather than re-entering the storage, because the
 * guard runs inside the same async context as the handler and a new store
 * would not be visible to it. The fields are `readonly` to everyone else on
 * purpose — this is the one place allowed to answer "who is this".
 */
export function setActor(actorType: ActorType, actorId?: string): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  const mutable = ctx as { -readonly [K in keyof RequestContext]: RequestContext[K] };
  mutable.actorType = actorType;
  if (actorId !== undefined) mutable.actorId = actorId;
}

export function systemContext(correlationId = newCorrelationId()): RequestContext {
  return { correlationId, actorType: 'SYSTEM' };
}
