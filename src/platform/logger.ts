/**
 * Structured logging.
 *
 * PRD SEC-08: PII redaction is an ALLOW-LIST, not a block-list. The logger
 * serialises only fields explicitly marked loggable; everything else is
 * dropped. A newly added field is invisible in logs until someone opts it in,
 * which is the safe default.
 *
 * TDD §3.2. PRD OBS-06.
 */

import pino, { type Logger } from 'pino';
import { currentContext } from './correlation.js';

/**
 * The complete set of fields that may appear in a log line.
 * Adding to this list is a deliberate act and should be reviewed.
 *
 * Notably absent, and intentionally so: phone, customer name, payer reference,
 * device secret, any token, any provider credential, full request bodies.
 */
const LOGGABLE_FIELDS = new Set([
  'correlationId',
  'actorType',
  'actorId',
  'foodCourtId',
  'vendorId',
  'orderId',
  'orderNumber',
  'paymentId',
  'refundId',
  'deviceId',
  'tableId',
  'sessionId',
  'provider',
  'providerEventId',
  'event',
  'tier',
  'status',
  'fromStatus',
  'toStatus',
  'code',
  'httpStatus',
  'method',
  'path',
  'durationMs',
  'attempt',
  'queue',
  'jobId',
  'amountPaise',
  'reason',
  'err',
  'msg',
]);

export function redact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (LOGGABLE_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: null, // drop pid/hostname noise; null, not undefined, per pino's types
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Use this rather than the pino instance directly. It attaches the correlation
 * id from AsyncLocalStorage and applies the allow-list.
 */
export function log(): Logger {
  const ctx = currentContext();
  if (!ctx) return base;
  return base.child(
    redact({
      correlationId: ctx.correlationId,
      actorType: ctx.actorType,
      ...(ctx.actorId !== undefined ? { actorId: ctx.actorId } : {}),
      ...(ctx.foodCourtId !== undefined ? { foodCourtId: ctx.foodCourtId } : {}),
      ...(ctx.vendorId !== undefined ? { vendorId: ctx.vendorId } : {}),
    }),
  );
}

export const rootLogger = base;
