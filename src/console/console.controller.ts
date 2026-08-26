/**
 * The platform console. Not the §13 admin portal.
 *
 * §13 specified thirteen modules for a world with a court operator taking a
 * revenue share and a floor manager acting on stuck orders. The product is now
 * sold direct to vendors, so neither exists: there is no application queue
 * because vendors do not apply, no court-scoped analytics because there is no
 * operator to read them, and no manager because nobody from the platform is in
 * the building.
 *
 * What is left is the work somebody at the platform actually does: put a
 * vendor's menu into the system. That is the onboarding cost §19.2 calls the
 * most underestimated task in the plan, and selling direct means paying it once
 * per vendor, forever — which makes it the first thing worth automating and the
 * reason this controller exists before any of the others.
 *
 * WHY `PLATFORM_OPS` AND NOT `SUPER_ADMIN`
 *
 * `SUPER_ADMIN` holds exactly one of the thirty-one permissions in the matrix:
 * `tenant.manage`. That looks like an oversight and is not — a super admin can
 * create tenants and cannot silently reprice a menu or move money, and those
 * being different people is worth keeping even at three of them. Whoever runs
 * this holds several roles at once; `user_role_assignment` and the `rol` claim
 * are both plural precisely so they can.
 */

import { Body, Controller, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { CsvMenuSource } from '../catalog/csv-source.js';
import { applyMenu, DryRun, type ImportPlan } from '../catalog/menu-ingest.js';
import { MenuParseError } from '../catalog/menu-source.js';
import { StaffGuard, staffOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { decide, type RoleAssignment } from '../identity/rbac.js';
import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';

/** The token's role claim, in the shape `decide` reads. */
function toAssignment(r: { role: RoleAssignment['role']; fc?: string; vnd?: string }): RoleAssignment {
  return {
    role: r.role,
    ...(r.fc !== undefined ? { foodCourtId: r.fc } : {}),
    ...(r.vnd !== undefined ? { vendorId: r.vnd } : {}),
  };
}

const ImportBody = z.object({
  /** The file, as text. A spreadsheet is small; multipart buys nothing here. */
  csv: z.string().min(1).max(2_000_000),
});

@Controller('api/v1/console')
@UseGuards(StaffGuard)
export class ConsoleController {
  private readonly audit: AuditRepository;

  constructor(@Inject(DB) private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  /**
   * Replace a vendor's menu from a spreadsheet.
   *
   * `?dryRun=true` reports exactly what would change and writes nothing —
   * which is what you want in front of a vendor's own menu, because the
   * interesting line in the response is usually the price changes.
   */
  @Post('vendors/:vendorId/menu/import')
  async importMenu(
    @Param('vendorId') vendorId: string,
    @Body() body: unknown,
    @Query('dryRun') dryRunRaw: string | undefined,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const staff = staffOf(req);

    /**
     * The guard proved who this is. `decide` decides what they may do — the two
     * are separate on purpose, and `staff.guard.ts` says why: a guard that also
     * authorises comes to mean "signed in", and everyone signed in gets
     * everything.
     */
    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'menu.write',
      { vendorId },
    );
    if (!decision.allowed) {
      throw new AppError('TOKEN_INVALID', `This account cannot write menus (${decision.reason}).`);
    }

    const { csv } = ImportBody.parse(body);
    const dryRun = dryRunRaw === 'true' || dryRunRaw === '1';

    // Parsed OUTSIDE the transaction. A spreadsheet with eleven typos should
    // come back with eleven line numbers and never open a transaction at all.
    let menu;
    try {
      menu = new CsvMenuSource().parse(csv);
    } catch (e) {
      if (e instanceof MenuParseError) throw e;
      throw new AppError('MENU_IMPORT_INVALID', (e as Error).message);
    }

    let plan: ImportPlan;
    try {
      plan = await this.db.transaction().execute(async (trx) => {
        const result = await applyMenu(trx, vendorId, menu, {
          dryRun,
          source: 'PLATFORM',
          sourceVersion: `csv:${new Date().toISOString().slice(0, 10)}`,
        });

        await this.audit.write(
          buildAuditEntry({
            action: 'menu.imported',
            entity: 'vendor',
            entityId: vendorId,
            vendorId,
            afterValue: {
              created: result.itemsCreated.length,
              updated: result.itemsUpdated.length,
              discontinued: result.itemsDiscontinued.length,
              priceChanges: result.priceChanges.length,
            },
          }),
          trx,
        );

        return result;
      });
    } catch (e) {
      // A dry run reaches here by design — the rollback is how it stays dry.
      if (e instanceof DryRun) {
        return { dryRun: true, applied: false, ...e.plan };
      }
      throw e;
    }

    log().info(
      {
        event: 'menu_imported',
        vendorId,
        actorId: staff.userId,
        created: plan.itemsCreated.length,
        updated: plan.itemsUpdated.length,
        discontinued: plan.itemsDiscontinued.length,
      },
      'a vendor menu was imported',
    );

    return { dryRun: false, applied: true, ...plan };
  }
}
