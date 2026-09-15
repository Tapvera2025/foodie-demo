/**
 * Manual "Sync Now" + status, for the offline-sync demo milestone.
 *
 * The edge worker also runs this automatically on a timer (see
 * src/workers/index.ts), but a live demo needs to control exactly when the
 * connectivity window "opens" rather than waiting for the next tick.
 */

import { Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { StaffGuard, staffOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { decide, type RoleAssignment } from '../identity/rbac.js';
import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { createAblyTransport } from './ably-transport.js';
import { SyncOrchestrator } from './sync.orchestrator.js';
import { WatermarkRepository } from './watermark.repository.js';

function toAssignment(r: { role: RoleAssignment['role']; fc?: string; vnd?: string }): RoleAssignment {
  return {
    role: r.role,
    ...(r.fc !== undefined ? { foodCourtId: r.fc } : {}),
    ...(r.vnd !== undefined ? { vendorId: r.vnd } : {}),
  };
}

@Controller('api/v1/console/sync')
@UseGuards(StaffGuard)
export class SyncController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  private authorize(req: RequestWithStaff): void {
    const staff = staffOf(req);
    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'sync.trigger',
    );
    if (!decision.allowed) {
      throw new AppError('TOKEN_INVALID', `This account cannot trigger sync (${decision.reason}).`);
    }
  }

  /**
   * Runs one edge sync cycle immediately, instead of waiting for the
   * worker's next probe tick. Only meaningful when SYNC_MODE=edge; on a
   * cloud or off instance this reports that there's nothing to run rather
   * than silently doing nothing.
   */
  @Post('run')
  async run(@Req() req: RequestWithStaff): Promise<{ ran: boolean; reason?: string }> {
    this.authorize(req);
    const cfg = config();

    if (cfg.SYNC_MODE !== 'edge') {
      return { ran: false, reason: `SYNC_MODE is "${cfg.SYNC_MODE}", not "edge" — nothing to trigger here` };
    }

    const transport = createAblyTransport({
      apiKey: cfg.ABLY_API_KEY as string,
      forceOffline: cfg.SYNC_FORCE_OFFLINE ?? false,
    });
    try {
      const orchestrator = new SyncOrchestrator(this.db, transport);
      await orchestrator.runEdgeCycleIfIdle(cfg.SYNC_DEVICE_ID as string);
    } finally {
      transport.close();
    }

    return { ran: true };
  }

  @Get('status')
  async status(
    @Req() req: RequestWithStaff,
  ): Promise<{ mode: string; deviceId: string | null; watermarks: unknown[] }> {
    this.authorize(req);
    const cfg = config();
    const deviceId = cfg.SYNC_MODE === 'edge' ? (cfg.SYNC_DEVICE_ID ?? null) : null;

    const watermarks = deviceId ? await new WatermarkRepository(this.db).status(deviceId) : [];

    return { mode: cfg.SYNC_MODE, deviceId, watermarks };
  }
}
