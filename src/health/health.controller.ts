/**
 * Liveness and readiness are SEPARATE endpoints, deliberately.
 *
 * Infra & Ops INF-02 / §3: wiring a database check into liveness means a brief
 * Postgres blip restarts every container simultaneously, turning a two-second
 * degradation into an outage.
 *
 *   /healthz  liveness  — is the event loop responsive? Nothing else.
 *   /readyz   readiness — can we actually serve traffic?
 *   /metrics  Prometheus exposition. Private network only.
 */

import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { register } from 'prom-client';
import { config } from '../platform/config.js';
import { PG_POOL } from '../platform/database.module.js';
import { pingDatabase } from '../platform/db.js';
import { log } from '../platform/logger.js';
import type pg from 'pg';

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export class HealthService {
  constructor(private readonly pool?: pg.Pool) {}

  async readiness(): Promise<{ ready: boolean; checks: ReadinessCheck[] }> {
    const checks: ReadinessCheck[] = [];

    // The tax determination is a readiness condition, not just a boot check.
    // A container that somehow started without it must never receive traffic.
    // TDD §14, PRD §4.7.
    try {
      const c = config();
      checks.push({
        name: 'tax_determination',
        ok: true,
        detail: `section9_5Applies=${c.TAX_SECTION_9_5_APPLIES}`,
      });
    } catch (e) {
      checks.push({
        name: 'tax_determination',
        ok: false,
        detail: e instanceof Error ? e.message : 'unset',
      });
    }

    if (this.pool) {
      try {
        await pingDatabase(this.pool);
        checks.push({ name: 'postgres', ok: true });
      } catch (e) {
        checks.push({
          name: 'postgres',
          ok: false,
          detail: e instanceof Error ? e.message : 'unreachable',
        });
      }
    } else {
      checks.push({ name: 'postgres', ok: false, detail: 'pool not configured' });
    }

    return { ready: checks.every((c) => c.ok), checks };
  }
}

@Controller()
export class HealthController {
  private readonly service: HealthService;

  /**
   * The pool used to be hard-coded `undefined` here, with a comment saying it
   * would be wired later. That made `/readyz` return 503 in every environment
   * forever, which is worse than no probe at all: an orchestrator cannot
   * distinguish a permanent false negative from a real outage, so the signal
   * gets ignored, and then it is ignored on the day it matters.
   */
  constructor(@Inject(PG_POOL) pool: pg.Pool) {
    this.service = new HealthService(pool);
  }

  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.service.readiness();
    if (!result.ready) {
      log().warn(
        {
          event: 'readiness_failed',
          reason: result.checks
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join(','),
        },
        'not ready',
      );
    }
    res.status(result.ready ? 200 : 503).json(result);
  }

  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  }
}
