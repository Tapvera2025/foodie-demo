/**
 * Food courts and their stalls, over HTTP.
 *
 * AUTHORISATION IS NOT THE GUARD'S JOB, AND THAT SPLIT IS LOAD-BEARING.
 *
 * `StaffGuard` proves who is calling. `decide` decides what they may do. Every
 * handler below calls both, exactly as `console.controller.ts` and
 * `staff.guard.ts` argue: a guard that also authorises comes to mean "signed
 * in", and then everyone signed in gets everything. The whole reason this
 * console is safe to give one person is that the permission check is per-act.
 *
 * WHICH PERMISSION, AND WHY THEY DIFFER
 *
 *   courts   `tenant.manage`  — held ONLY by SUPER_ADMIN. Creating a court is
 *                               creating a tenant.
 *   stalls   `vendor.write`   — held by PLATFORM_OPS (and by VENDOR_OWNER for
 *                               their own profile only).
 *
 * One person holds both roles and sees one console. The separation costs them
 * nothing and buys the audit log the ability to say which hat an action was
 * taken under — which is the whole argument for the multi-role model over
 * collapsing everything into SUPER_ADMIN.
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
import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { CourtRepository } from './court.repository.js';
import { ConsoleOrderRepository } from './order.repository.js';
import { QrRepository } from './qr.repository.js';
import { VendorRepository } from './vendor.repository.js';

/**
 * Where a scanned code lands.
 *
 * This used to read `process.env` directly, because the value is "a property
 * of the DEPLOYMENT, not of the API". So is `DATABASE_URL` — that argument
 * describes every entry in the config schema and excuses none of them from it.
 * What it actually bought was the one value that gets printed onto physical
 * signage skipping the only validation this codebase performs at boot.
 *
 * It is now `PWA_BASE_URL` in `ConfigSchema`, which rejects a malformed URL
 * at boot and a loopback host in production. `seed-dev.ts` shares the default
 * through `DEFAULT_PWA_BASE_URL`, so a token issued by the seed and one issued
 * here still produce identical URLs — now by construction rather than by two
 * string literals that happened to match.
 */
function pwaBaseUrl(): string {
  return config().PWA_BASE_URL;
}

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
 * IANA zone, loosely shaped.
 *
 * Not validated against the full tz database: Node has `Intl.supportedValuesOf`
 * but the list differs by build, and rejecting a zone this runtime happens not
 * to know is worse than storing one Postgres will. The `AT TIME ZONE` casts
 * downstream are where a genuinely bad zone surfaces.
 */
const TIMEZONE = /^[A-Za-z]+\/[A-Za-z_+-]+$/;

const CreateCourt = z.object({
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  address: z.string().trim().max(400).optional(),
  timezone: z.string().regex(TIMEZONE).optional(),
});

const UpdateCourt = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  city: z.string().trim().min(2).max(80).optional(),
  address: z.string().trim().max(400).nullable().optional(),
  timezone: z.string().regex(TIMEZONE).optional(),
});

/**
 * A status change carries a reason, and the schema requires it.
 *
 * Ten characters is not a serious bar and is not meant to be. It is enough to
 * stop "x" and force a sentence, which is the difference between an audit row
 * you can act on and one you can only date.
 */
const SetStatus = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']),
  reason: z.string().trim().min(10).max(500),
});

const IssueQr = z.object({
  /** Required to overwrite an existing token. See `QrRepository.issue`. */
  replace: z.boolean().default(false),
  reason: z.string().trim().min(10).max(500),
});

const RevokeQr = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * A cancellation reason, at the same ten-character floor every other
 * consequential act in this console uses.
 *
 * `COMMAND_SPECS.forceCancel.requiresReason` is `true`, and this is where that
 * becomes something a person actually has to satisfy.
 */
const ForceCancel = z.object({
  reason: z.string().trim().min(10).max(500),
});

/** Grant, decline or withdraw. Which of the three depends on the state. */
const OfferSlot = z.object({
  enabled: z.boolean(),
});

const CreateVendor = z.object({
  name: z.string().trim().min(2).max(120),
  cuisine: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  estimatedPrepMinutes: z.number().int().min(1).max(120).optional(),
});

@Controller('api/v1/console')
@UseGuards(StaffGuard)
export class CourtController {
  private readonly courts: CourtRepository;
  private readonly vendors: VendorRepository;
  private readonly qr: QrRepository;
  private readonly orders: ConsoleOrderRepository;

  constructor(@Inject(DB) db: Kysely<Database>) {
    this.courts = new CourtRepository(db);
    this.vendors = new VendorRepository(db);
    this.qr = new QrRepository(db);
    this.orders = new ConsoleOrderRepository(db);
  }

  /** Throws unless this caller holds the permission. Returns their id for logs. */
  private authorise(
    req: RequestWithStaff,
    permission: Parameters<typeof decide>[1],
    scope: Parameters<typeof decide>[2] = {},
  ): string {
    const staff = staffOf(req);
    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      permission,
      scope,
    );

    if (!decision.allowed) {
      throw new AppError(
        'TOKEN_INVALID',
        `This account cannot ${permission.replace('.', ' ')} (${decision.reason}).`,
      );
    }

    return staff.userId;
  }

  // ------------------------------------------------------------------ courts

  @Get('food-courts')
  async listCourts(@Req() req: RequestWithStaff): Promise<unknown> {
    this.authorise(req, 'tenant.manage');
    return { courts: await this.courts.list() };
  }

  @Post('food-courts')
  async createCourt(@Body() body: unknown, @Req() req: RequestWithStaff): Promise<unknown> {
    const actorId = this.authorise(req, 'tenant.manage');
    const input = CreateCourt.parse(body);

    const court = await this.courts.create(input);

    log().info(
      { event: 'court_created', courtId: court.id, actorId },
      'a food court was created from the console',
    );

    return court;
  }

  @Get('food-courts/:courtId')
  async getCourt(
    @Param('courtId') courtId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    return this.courts.get(courtId);
  }

  @Patch('food-courts/:courtId')
  async updateCourt(
    @Param('courtId') courtId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    return this.courts.update(courtId, UpdateCourt.parse(body));
  }

  @Post('food-courts/:courtId/status')
  async setCourtStatus(
    @Param('courtId') courtId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    const { status, reason } = SetStatus.parse(body);

    const court = await this.courts.setStatus(courtId, status, reason);

    log().warn(
      { event: 'court_status_changed', courtId, status, actorId },
      'a food court changed status',
    );

    return court;
  }

  // --------------------------------------------------------------------- QR

  /**
   * The venue credential.
   *
   * `tenant.manage`, the same permission as creating the court — this token is
   * what makes a tenant reachable, and the two acts belong to the same person.
   */
  @Get('food-courts/:courtId/qr')
  async getQr(@Param('courtId') courtId: string, @Req() req: RequestWithStaff): Promise<unknown> {
    this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    return this.qr.get(courtId, pwaBaseUrl());
  }

  /**
   * Issue, or rotate.
   *
   * `replace` is a separate flag from the reason on purpose. Rotating a token
   * kills every printed poster in the venue at once, so the caller has to both
   * mean it and say why — the first stops a double-click, the second is what
   * makes the audit row worth reading.
   */
  @Post('food-courts/:courtId/qr')
  async issueQr(
    @Param('courtId') courtId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    const { replace, reason } = IssueQr.parse(body);

    const state = await this.qr.issue(courtId, pwaBaseUrl(), { replace, reason });

    log().warn(
      { event: 'court_qr_issued', courtId, replaced: replace, actorId },
      replace
        ? 'a court QR was rotated — every printed poster now needs reprinting'
        : 'a court QR was issued',
    );

    return state;
  }

  @Post('food-courts/:courtId/qr/revoke')
  async revokeQr(
    @Param('courtId') courtId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'tenant.manage', { foodCourtId: courtId });
    const { reason } = RevokeQr.parse(body);

    const state = await this.qr.revoke(courtId, reason);

    log().warn(
      { event: 'court_qr_revoked', courtId, actorId },
      'a court QR was revoked — nothing can scan into this court',
    );

    return state;
  }

  // ------------------------------------------------------------------ stalls

  /**
   * The stalls in a court.
   *
   * `vendor.write` rather than `catalog.read`: this response carries each
   * stall's blocker count, which is onboarding state rather than menu data, and
   * the read that shows how far a business is from being paid should need the
   * same permission as the write that gets it there.
   */
  // ------------------------------------------------------- offer slots

  /**
   * Every stall's carousel slot, across every court, in one list.
   *
   * NOT SCOPED TO A COURT, deliberately. The whole point is that somebody
   * answering requests should not have to guess which venue a waiting stall is
   * in and open that court, then that stall. A queue you have to go looking for
   * is a queue nobody works through.
   *
   * `vendor.write`, the same permission that grants the slot — there is no
   * value in letting somebody read this list who could do nothing about it.
   */
  @Get('offer-slots')
  async offerSlots(@Req() req: RequestWithStaff): Promise<unknown> {
    this.authorise(req, 'vendor.write');
    return { stalls: await this.vendors.listOfferSlots() };
  }

  /**
   * Grant, withdraw, or decline — the three answers, on one route.
   *
   * `enabled: true`  grants and clears the request
   * `enabled: false` with a pending request DECLINES it
   * `enabled: false` with none WITHDRAWS a slot already granted
   *
   * All three stamp `offer_slot_decided_at`. See the repository for why a
   * decline has to leave a mark rather than just clearing the request.
   */
  @Post('vendors/:vendorId/offer-slot')
  async setOfferSlot(
    @Param('vendorId') vendorId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'vendor.write', { vendorId });
    const { enabled } = OfferSlot.parse(body);

    const result = await this.vendors.setOfferSlot(vendorId, enabled);

    log().info(
      { event: 'offer_slot_decided', vendorId, ...result, actorId },
      enabled ? 'a stall was granted a carousel slot' : 'a stall was refused or lost its slot',
    );

    return result;
  }

  // ---------------------------------------------------------- live orders

  /**
   * Every order in this court that has money against it and no food collected.
   *
   * `order.read.court`, not `tenant.manage`. Watching orders is the job of
   * whoever is on call for a venue, and that is a narrower thing than being
   * able to create courts — `PLATFORM_OPS`, `PLATFORM_FINANCE` and `MANAGER`
   * hold it, `SUPER_ADMIN` does not.
   *
   * Scoped to the court in BOTH places: the permission check receives the
   * court, and the query filters on it. A court-scoped assignment is a real
   * thing in this matrix (`COURT_OPERATOR: AGG`), so an operator for one venue
   * asking about another must get nothing rather than everything.
   */
  @Get('food-courts/:courtId/orders')
  async liveOrders(
    @Param('courtId') courtId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, 'order.read.court', { foodCourtId: courtId });
    return { orders: await this.orders.liveOrders(courtId) };
  }

  /**
   * Stop an order and start its refund.
   *
   * The one intervention this console can make on an order, and the only
   * command in `COMMAND_SPECS` that requires a reason AND moves money.
   *
   * The reason is mandatory here for the same purpose it is mandatory on the
   * state machine: a cancelled order is a customer who did not get lunch and a
   * stall that may dispute it, and "cancelled by ops" six weeks later answers
   * nothing. It lands in the audit log, which is append-only by trigger.
   */
  @Post('food-courts/:courtId/orders/:orderId/cancel')
  async forceCancelOrder(
    @Param('courtId') courtId: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'order.force_cancel', { foodCourtId: courtId });
    const { reason } = ForceCancel.parse(body);

    const result = await this.orders.forceCancel({
      foodCourtId: courtId,
      orderId,
      reason,
      actorId,
    });

    log().warn(
      {
        event: 'order_force_cancelled',
        orderId,
        orderNumber: result.orderNumber,
        foodCourtId: courtId,
        actorId,
        refundStarted: result.refundStarted,
      },
      'an order was cancelled from the console',
    );

    return result;
  }

  @Get('food-courts/:courtId/vendors')
  async listVendors(
    @Param('courtId') courtId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    this.authorise(req, 'vendor.write', { foodCourtId: courtId });
    return { vendors: await this.vendors.listByCourt(courtId) };
  }

  @Post('food-courts/:courtId/vendors')
  async createVendor(
    @Param('courtId') courtId: string,
    @Body() body: unknown,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const actorId = this.authorise(req, 'vendor.write', { foodCourtId: courtId });
    const input = CreateVendor.parse(body);

    const vendor = await this.vendors.create(courtId, input);

    log().info(
      { event: 'vendor_created', vendorId: vendor.id, courtId, actorId },
      'a stall was created as DRAFT',
    );

    return vendor;
  }
}
