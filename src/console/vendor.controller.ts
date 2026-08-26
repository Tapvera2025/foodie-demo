/**
 * One stall's onboarding, over HTTP.
 *
 * The court controller creates stalls and lists them; this one is everything
 * that happens to a stall afterwards — the eleven fields of §5.1, the live
 * checklist, and the activation that §5.2 gates.
 *
 * WHY `GET readiness` EXISTS SEPARATELY FROM `GET /vendors/:id`
 *
 * It does not, quite: the detail response embeds the same `readiness` object.
 * The separate endpoint is for the checklist to poll while somebody is filling
 * the form in another tab — importing a menu or creating a staff login both
 * change the verdict without touching the vendor row, so a checklist that only
 * refreshed on save would show a stall as blocked after the blocker was cleared.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * There is no `DELETE`. A stall goes INACTIVE and stays in the database, for
 * the same reason a court does: its orders, ledger entries and audit rows all
 * point at it, and every one of those is append-only or financially
 * authoritative. §14.6 — nothing is edited, corrections are new entries.
 */

import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { decide, type RoleAssignment } from '../identity/rbac.js';
import { StaffGuard, staffOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { generatePassword, KITCHEN_ROLES, StaffRepository } from './staff.repository.js';
import { VendorRepository } from './vendor.repository.js';

function toAssignment(r: {
  role: RoleAssignment['role'];
  fc?: string;
  vnd?: string;
}): RoleAssignment {
  return {
    role: r.role,
    ...(r.fc !== undefined ? { foodCourtId: r.fc } : {}),
    ...(r.vnd !== undefined ? { vendorId: r.vnd } : {}),
  };
}

/**
 * The onboarding patch.
 *
 * `.nullable()` throughout, and that is the schema doing real work: `null`
 * clears a field and *absent* leaves it alone. Onboarding happens over days —
 * an FSSAI number arrives on Tuesday, a bank account on Friday — so a save that
 * treated absent as null would wipe Tuesday every Friday.
 *
 * Shapes are checked loosely here and properly by the gate. A PAN typed in
 * lower case must reach the repository so it can normalise and store the upper
 * case form; rejecting it at the edge would mean the console refusing input the
 * system is perfectly able to accept.
 */
const UpdateVendor = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  cuisine: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  estimatedPrepMinutes: z.number().int().min(1).max(120).optional(),

  legalName: z.string().trim().max(200).nullable().optional(),
  settlementMode: z.enum(['PLATFORM_COLLECT', 'VENDOR_DIRECT']).nullable().optional(),
  pan: z.string().trim().max(10).nullable().optional(),
  gstin: z.string().trim().max(15).nullable().optional(),
  fssaiLicence: z.string().trim().max(20).nullable().optional(),
  bankAccountRef: z.string().trim().max(120).nullable().optional(),
  providerLinkedAccountId: z.string().trim().max(120).nullable().optional(),
  kycCompleted: z.boolean().optional(),

  /**
   * The PLATFORM's grant of a carousel slot. Not the artwork.
   *
   * The two halves live on different surfaces on purpose: the console decides
   * WHICH stalls may appear on the most prominent screen in the product, and
   * the stall's own board decides what appears there. A stall that could grant
   * itself the slot would take that space from every other stall in the court.
   */
  offerUploadsEnabled: z.boolean().optional(),

  /**
   * Opening hours, validated at the edge.
   *
   * A record of day -> windows. `parseHours` is tolerant on the READ path
   * because one bad row must not take down a court's menu; this is the WRITE
   * path, where being strict is free and silently discarding half of what
   * somebody typed is not.
   */
  operatingHours: z
    .record(
      z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
      z
        .array(
          z.object({
            open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          }),
        )
        .max(4),
    )
    .optional(),
});

const SetStatus = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']),
  reason: z.string().trim().min(10).max(500),
});

const CreateStaff = z.object({
  email: z.string().trim().email().max(200),
  displayName: z.string().trim().min(2).max(120),
  role: z.enum(KITCHEN_ROLES),
  /**
   * Optional. Omitted means the server generates one.
   *
   * Generated is the intended path — left to invent a password per stall,
   * whoever is onboarding will reuse one across the court. The field exists
   * because a vendor occasionally insists on choosing, and refusing that
   * outright means they choose `stall123` over the phone instead.
   */
  password: z.string().min(12).max(256).optional(),
});

const RevokeStaff = z.object({
  reason: z.string().trim().min(10).max(500),
});

@Controller('api/v1/console/vendors')
@UseGuards(StaffGuard)
export class ConsoleVendorController {
  private readonly vendors: VendorRepository;
  private readonly staff: StaffRepository;

  constructor(@Inject(DB) db: Kysely<Database>) {
    this.vendors = new VendorRepository(db);
    this.staff = new StaffRepository(db);
  }

  /**
   * Authorise against the vendor's OWN scope.
   *
   * `{ vendorId }` matters. `vendor.write` is `PLATFORM_OPS: ALLOW` but also
   * `VENDOR_OWNER: IF('OWN_VENDOR_PROFILE_ONLY')`, so passing the scope is what
   * keeps a vendor owner — who can legitimately hold a console token — from
   * editing the stall next door. Omitting it would widen every one of these
   * endpoints to every vendor in the system, silently.
   */
  private authorise(
    req: RequestWithStaff,
    vendorId: string,
    permission: Parameters<typeof decide>[1] = 'vendor.write',
  ): string {
    const staff = staffOf(req);
    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      permission,
      { vendorId },
    );

    if (!decision.allowed) {
      throw new AppError('TOKEN_INVALID', `This account cannot edit this stall (${decision.reason}).`);
    }

    return staff.userId;
  }

  @Get(':vendorId')
  async get(@Param('vendorId') vendorId: string, @Req() req: RequestWithStaff): Promise<unknown> {
    this.authorise(req, vendorId);
    return this.vendors.get(vendorId);
  }

  /** Just the verdict. Cheap enough to poll while a form is open elsewhere. */
  @Get(':vendorId/readiness')
  async readiness(
    @Param('vendorId') vendorId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, vendorId);
    const v = await this.vendors.get(vendorId);
    return {
      status: v.status,
      canActivate: v.readiness.canActivate,
      blockers: v.readiness.blockers,
      warnings: v.readiness.warnings,
      availableMenuItemCount: v.availableMenuItemCount,
      activeStaffCount: v.activeStaffCount,
    };
  }

  @Patch(':vendorId')
  async update(
    @Param('vendorId') vendorId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, vendorId);
    const input = UpdateVendor.parse(body);

    const vendor = await this.vendors.update(vendorId, input);

    // Which FIELDS changed, never their values. A PAN and a bank account
    // reference in the application log are two of the things `redact` exists to
    // keep out of it, and the audit row already holds the before/after pair
    // under access control.
    log().info(
      { event: 'vendor_updated', vendorId, actorId, fields: Object.keys(input) },
      'a stall was updated from the console',
    );

    return vendor;
  }

  /**
   * Activate, suspend, or close a stall.
   *
   * The §5.2 gate is enforced in the repository, inside the transaction, against
   * a locked row — not here. This endpoint's only job is to prove who is asking
   * and pass the reason through. Putting the check here would make it something
   * a second caller of the repository could skip.
   */
  @Post(':vendorId/status')
  async setStatus(
    @Param('vendorId') vendorId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, vendorId);
    const { status, reason } = SetStatus.parse(body);

    const vendor = await this.vendors.setStatus(vendorId, status, reason);

    log().warn(
      { event: 'vendor_status_changed', vendorId, status, actorId },
      'a stall changed status',
    );

    return vendor;
  }

  // ------------------------------------------------------------ kitchen logins

  /**
   * `vendor.user.manage`, not `vendor.write`.
   *
   * They are held by the same two roles today, so this changes nothing about
   * who can call it — and everything about what the audit trail means. Issuing
   * a credential to a system that moves money is a different act from editing a
   * PAN, and the matrix already says so. Reusing `vendor.write` here would
   * quietly merge them and make the distinction unrecoverable later.
   */
  @Get(':vendorId/staff')
  async listStaff(
    @Param('vendorId') vendorId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, vendorId, 'vendor.user.manage');
    return { staff: await this.staff.list(vendorId) };
  }

  /**
   * Issue a kitchen login.
   *
   * The plaintext password is in the RESPONSE and nowhere else — not in the
   * log, not in the audit row, and not recoverable afterwards. `platform_user`
   * stores a scrypt hash and there is no reset flow yet, so the console shows
   * it once and says so. Returning it is the only way this is usable; logging
   * it would put every kitchen credential in a file that gets shipped to a log
   * aggregator.
   */
  @Post(':vendorId/staff')
  async createStaff(
    @Param('vendorId') vendorId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, vendorId, 'vendor.user.manage');
    const input = CreateStaff.parse(body);

    const password = input.password ?? generatePassword();

    const result = await this.staff.create(vendorId, {
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      password,
    });

    log().warn(
      {
        event: 'staff_account_created',
        vendorId,
        userId: result.account.userId,
        role: input.role,
        actorId,
        // Deliberately no password field, and no email either — the audit row
        // holds the email under access control, which the application log is not.
      },
      'a kitchen login was issued from the console',
    );

    return {
      account: result.account,
      password: result.password,
      generated: input.password === undefined,
    };
  }

  /**
   * Issue a new password for an existing login.
   *
   * The password is always GENERATED, unlike `createStaff` which accepts one.
   * A reset happens under pressure — a cook is standing at a tablet and a queue
   * is forming — and that is exactly when somebody types `kitchen123` to get
   * the shift moving. Creation is a planned act with time to choose; this is
   * not, so the choice is removed.
   */
  @Post(':vendorId/staff/:userId/reset-password')
  async resetStaffPassword(
    @Param('vendorId') vendorId: string,
    @Param('userId') userId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, vendorId, 'vendor.user.manage');

    const result = await this.staff.resetPassword(vendorId, userId, generatePassword());

    log().warn(
      {
        event: 'staff_password_reset',
        vendorId,
        userId,
        actorId,
        // No password, and no email. Same rule as creation: the log records
        // that it happened, the audit row records who, and neither holds the
        // secret.
      },
      'a kitchen login password was reset from the console',
    );

    return { account: result.account, password: result.password };
  }

  @Post(':vendorId/staff/:userId/revoke')
  async revokeStaff(
    @Param('vendorId') vendorId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, vendorId, 'vendor.user.manage');
    const { reason } = RevokeStaff.parse(body);

    const staff = await this.staff.revoke(vendorId, userId, reason);

    log().warn(
      { event: 'staff_account_revoked', vendorId, userId, actorId },
      'a kitchen login was revoked',
    );

    return { staff };
  }
}
