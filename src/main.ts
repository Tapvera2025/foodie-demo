import 'reflect-metadata';

import type { Server as HttpServer } from 'node:http';

import { NestFactory } from '@nestjs/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { collectDefaultMetrics } from 'prom-client';

import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './platform/config.js';
import { correlationMiddleware } from './platform/correlation.middleware.js';
import { DB } from './platform/database.module.js';
import { rootLogger } from './platform/logger.js';
import type { Database } from './platform/schema.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

/**
 * API entrypoint. The worker uses the same image with a different CMD
 * (`dist/workers/index.js`) so the two can never drift to different code
 * versions — see Dockerfile and docs/tech/infrastructure.md.
 */
async function bootstrap(): Promise<void> {
  // Config is validated BEFORE anything else starts. In particular, a missing
  // TAX_SECTION_9_5_APPLIES must stop the process here rather than surface as a
  // wrong vendor payout three weeks into a pilot. TDD §14.
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      rootLogger.fatal({ event: 'config_invalid' }, e.message);
      if (e.issues.some((i) => i.startsWith('TAX_SECTION_9_5_APPLIES'))) {
        rootLogger.fatal(
          'TAX_SECTION_9_5_APPLIES has no default by design. See PRD v5.2 §4.7 — ' +
            'if s.9(5) applies the platform must retain food GST rather than settle ' +
            'it to the vendor. Set the value explicitly; do not add a default.',
        );
      }
      process.exit(78); // EX_CONFIG
    }
    throw e;
  }

  collectDefaultMetrics();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    logger: false,
    // Keeps the exact bytes of the request body available as `req.rawBody`.
    //
    // Payment webhook signatures cover what was SENT. Re-serialising a parsed
    // object changes key order and whitespace, produces a different digest, and
    // makes verification fail on perfectly valid events — which is the kind of
    // failure somebody eventually "fixes" by skipping the check.
    rawBody: true,
  });
  app.enableShutdownHooks();

  // Before anything else, so health checks and 404s are correlated too.
  // Registered here rather than via MiddlewareConsumer.forRoutes('*') — see
  // the note on AppModule for why that pattern is fatal under Express 5.
  app.use(correlationMiddleware);

  // CORS in development only. The PWA dev server runs on :5173 and the browser
  // will block it otherwise. In production the PWA is served from the same
  // origin as the API, so there is no cross-origin request to allow — and an
  // origin allowlist that is empty in production is the correct allowlist.
  if (cfg.NODE_ENV !== 'production') {
    app.enableCors({
      origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
      exposedHeaders: ['X-Correlation-Id'],
    });
  }

  /*
   * ==========================================================================
   * REALTIME, ATTACHED BEFORE `listen` SO NO CONNECTION ARRIVES UNHANDLED
   * ==========================================================================
   *
   * `getHttpServer()` is the same Node server Express is mounted on, so the
   * socket path shares the port. One port means no second listener to expose,
   * no extra firewall rule, and — the reason that actually matters — the same
   * origin as the API, so the browser needs no additional CORS grant in
   * production.
   *
   * A DEDICATED CLIENT FOR LISTEN, not one from the pool. `bus.ts` explains
   * why at length: a pooled client is returned after a query, and a LISTEN
   * registered on it silently stops delivering. The factory is passed rather
   * than a connected client so the subscriber can build a fresh one on every
   * reconnect.
   */
  const realtime = new RealtimeGateway(
    app.get<Kysely<Database>>(DB),
    () => new pg.Client({ connectionString: cfg.DATABASE_URL }),
  );
  realtime.attach(app.getHttpServer() as HttpServer);

  await app.listen(cfg.PORT, '0.0.0.0');

  rootLogger.info(
    {
      event: 'started',
      port: cfg.PORT,
      env: cfg.NODE_ENV,
      taxSection9_5Applies: cfg.TAX_SECTION_9_5_APPLIES,
      paymentsProvider: cfg.PAYMENTS_PROVIDER,
      splitTiming: cfg.PAYMENTS_SPLIT_TIMING,
    },
    'api listening',
  );

  // Graceful shutdown. dumb-init forwards SIGTERM; the API drains in-flight
  // requests for up to 20s. A BullMQ worker killed mid-refund is precisely the
  // failure this system must not have. Infra & Ops INF-03.
  const shutdown = async (signal: string): Promise<void> => {
    rootLogger.info({ event: 'shutdown_started', reason: signal }, 'draining');
    const timer = setTimeout(() => {
      rootLogger.error({ event: 'shutdown_forced' }, 'drain timeout, exiting');
      process.exit(1);
    }, 20_000);
    timer.unref();
    // Before `app.close()`: open sockets hold the HTTP server open, so closing
    // Nest first waits on connections that are never going to end by
    // themselves and burns the whole 20s drain window every deploy.
    await realtime.close();
    await app.close();
    rootLogger.info({ event: 'shutdown_complete' }, 'closed cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
