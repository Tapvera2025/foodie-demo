/**
 * Gives every request a correlation id and puts it in async-local storage, so
 * every log line and every ledger row written while handling it can be tied
 * back to the one customer tap that caused them.
 *
 * Accepts an inbound `X-Correlation-Id` so a trace survives across services,
 * but never trusts its shape: an unbounded client-supplied string ends up in
 * log fields and error bodies, and that is a log-injection hole. Anything that
 * is not a plain short token is replaced rather than rejected — a malformed
 * header should not cost a customer their lunch order.
 *
 * A PLAIN EXPRESS HANDLER, not an `@Injectable()` NestMiddleware.
 *
 * It has no dependencies to inject, and registering it with `app.use()` avoids
 * `MiddlewareConsumer.forRoutes('*')`. Nest 11 ships Express 5, whose
 * path-to-regexp rejects a bare `'*'` with "Missing parameter name" — the
 * wildcard must now be named, as in `'*splat'`. That failure happens at
 * startup and takes the entire API down, which from a browser looks exactly
 * like a request that never returns.
 */

import type { NextFunction, Request, Response } from 'express';

import { newCorrelationId, runWithContext } from './correlation.js';

const SAFE = /^[A-Za-z0-9_-]{8,64}$/;

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-correlation-id');
  const correlationId = inbound && SAFE.test(inbound) ? inbound : newCorrelationId();

  // Echoed back so a customer reporting a problem can read it off a support
  // screen, and so the PWA can attach it to an error report.
  res.setHeader('X-Correlation-Id', correlationId);

  // Every controller mounted today is unauthenticated and customer-facing, so
  // CUSTOMER is the truthful default. When the auth guard lands it must REPLACE
  // this rather than sit alongside it — an audit row attributing a manager's
  // force-cancel to CUSTOMER is worse than no attribution.
  runWithContext({ correlationId, actorType: 'CUSTOMER' }, () => {
    next();
  });
}
