import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { collectDefaultMetrics } from 'prom-client';

import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './platform/config.js';
import { rootLogger } from './platform/logger.js';

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

  const app = await NestFactory.create(AppModule, { bufferLogs: false, logger: false });
  app.enableShutdownHooks();

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
    await app.close();
    rootLogger.info({ event: 'shutdown_complete' }, 'closed cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
