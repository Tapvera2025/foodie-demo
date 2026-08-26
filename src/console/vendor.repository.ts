/**
 * Stalls, from the platform console — creation through to activation.
 *
 * THE GATE IS THE POINT OF THIS FILE.
 *
 * `assessVendorReadiness` (tenancy/vendor-onboarding.ts) has been pure, tested
 * and unreachable since the day it was written: §18 lists it as "library only,
 * no endpoints". Everything here exists to connect it to a database on one side
 * and a screen on the other, without weakening it in the middle.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 * 1. THE GATE IS EVALUATED SERVER-SIDE AT THE MOMENT OF ACTIVATION, inside the
 *    same transaction that flips the status. Showing the checklist in the UI is
 *    a convenience; it is not the check. A console that only checks in the
 *    browser is one where activation is a POST away for anyone with curl.
 *
 * 2. THE SNAPSHOT IS READ, NOT PASSED IN. The caller cannot hand us a snapshot
 *    claiming the menu has items. Every field comes from the row or a count
 *    against it.
 *
 * WHY A DRAFT STALL IS CREATED IN ONE STEP AND FILLED IN AFTER
 *
 * Onboarding gathers eleven things across KYC, settlement and menu, and it
 * gathers them over days — an FSSAI number arrives by WhatsApp on Tuesday and
 * the bank account on Friday. A single create-everything form would mean losing
 * Tuesday's work waiting for Friday's. So: create the stall as DRAFT with a
 * name, then PATCH fields as they arrive, then activate when the gate passes.
 */

import type { Kysely } from 'kysely';

import { isOpenAt, parseHours } from '../catalog/opening-hours.js';
import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { AppError } from '../platform/errors.js';
import type { Database, SettlementMode } from '../platform/schema.js';
import {
  assessVendorReadiness,
  canTransitionVendor,
  type Readiness,
  type VendorSnapshot,
  type VendorStatus,
} from '../tenancy/vendor-onboarding.js';

export interface VendorSummary {
  readonly id: string;
  readonly foodCourtId: string;
  readonly name: string;
  readonly cuisine: readonly string[];
  readonly status: VendorStatus;
  readonly estimatedPrepMinutes: number;
  /** How far off activation this stall is. 0 means the gate would pass. */
  readonly blockerCount: number;
}

export interface VendorDetail extends VendorSummary {
  readonly legalName: string | null;
  readonly settlementMode: SettlementMode | null;
  readonly pan: string | null;
  readonly gstin: string | null;
  readonly fssaiLicence: string | null;
  readonly bankAccountRef: string | null;
  readonly kycCompletedAt: Date | null;
  readonly providerLinkedAccountId: string | null;
  readonly availableMenuItemCount: number;
  readonly activeStaffCount: number;
  /** Day -> windows. `{}` means no schedule, which reads as always open. */
  readonly operatingHours: Record<string, { open: string; close: string }[]>;
  readonly offerUploadsEnabled: boolean;
  readonly offerImageUrl: string | null;
  readonly offerHeadline: string | null;
  readonly readiness: Readiness;
}

/** One row of the console's offer queue. */
export interface OfferSlotRow {
  readonly id: string;
  readonly name: string;
  readonly status: VendorStatus;
  readonly foodCourtId: string;
  readonly foodCourtName: string;
  readonly enabled: boolean;
  readonly filled: boolean;
  readonly headline: string | null;
  readonly requestedAt: string | null;
  readonly decidedAt: string | null;  /** On a customer's screen right now — all four conditions, not two. */
  showingNow: boolean;
  /** Why not, when the configuration is complete and it still is not showing. */
  notShowingReason: string | null;
}

export interface CreateVendorInput {
  readonly name: string;
  readonly cuisine?: readonly string[] | undefined;
  readonly estimatedPrepMinutes?: number | undefined;
}

/**
 * Every field onboarding can set after creation.
 *
 * `undefined` means "not sent, leave alone". `null` means "clear this". The two
 * are distinguished throughout, because a partial form that silently wiped the
 * fields it did not include would destroy Tuesday's work every time somebody
 * saved Friday's.
 */
export interface UpdateVendorInput {
  readonly name?: string | undefined;
  readonly cuisine?: readonly string[] | undefined;
  readonly estimatedPrepMinutes?: number | undefined;
  readonly legalName?: string | null | undefined;
  readonly settlementMode?: SettlementMode | null | undefined;
  readonly pan?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly fssaiLicence?: string | null | undefined;
  readonly bankAccountRef?: string | null | undefined;
  readonly providerLinkedAccountId?: string | null | undefined;
  /**
   * KYC confirmation, as a boolean rather than a timestamp the caller picks.
   *
   * The server stamps `now()`. Letting a console post an arbitrary date would
   * let somebody backdate the moment the payment provider cleared a vendor,
   * which is exactly the field an auditor would care about.
   */
  readonly kycCompleted?: boolean | undefined;
  /**
   * Day -> windows. Replaces the whole schedule, never merges.
   *
   * Merging would make "we no longer open on Sundays" unexpressible: there is
   * no way to send an absence in a partial patch, so Sunday would survive
   * every attempt to remove it.
   */
  readonly operatingHours?: Record<string, { open: string; close: string }[]> | undefined;
  /** The platform's grant of a carousel slot. The artwork is the stall's. */
  readonly offerUploadsEnabled?: boolean | undefined;
}

/** Roles that count as "somebody can see this kitchen's orders". */
const KITCHEN_ROLES = ['VENDOR_OPERATOR', 'VENDOR_OWNER'] as const;

/**
 * Trim, uppercase, or null.
 *
 * PAN and GSTIN are matched case-sensitively by the gate's regexes against
 * upper case, and people type them in lower case constantly. Normalising on the
 * way IN means the stored value is the one the aggregator will be sent, rather
 * than one that passes validation and fails at settlement.
 */
function upperOrNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim().toUpperCase();
  return t === '' ? null : t;
}

function trimOrNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export class VendorRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  /**
   * Read everything the gate needs, in one round trip.
   *
   * The two counts are correlated subqueries for the same reason the court list
   * uses them: a stall with no menu and no staff — which is every stall on its
   * first day — must still come back, and joins drop exactly those rows.
   */
  private async snapshot(vendorId: string): Promise<{
    row: {
      id: string;
      food_court_id: string;
      name: string;
      cuisine: string[];
      status: VendorStatus;
      estimated_prep_minutes: number;
      legal_name: string | null;
      settlement_mode: SettlementMode | null;
      pan: string | null;
      gstin: string | null;
      fssai_licence: string | null;
      bank_account_ref: string | null;
      kyc_completed_at: Date | null;
      provider_linked_account_id: string | null;
      operating_hours: unknown;
      offer_uploads_enabled: boolean;
      offer_image_url: string | null;
      offer_headline: string | null;
    };
    menuItems: number;
    staff: number;
  }> {
    const row = await this.db
      .selectFrom('vendor')
      .select([
        'id',
        'food_court_id',
        'name',
        'cuisine',
        'status',
        'estimated_prep_minutes',
        'legal_name',
        'settlement_mode',
        'pan',
        'gstin',
        'fssai_licence',
        'bank_account_ref',
        'kyc_completed_at',
        'provider_linked_account_id',
        'operating_hours',
        'offer_uploads_enabled',
        'offer_image_url',
        'offer_headline',
      ])
      .where('id', '=', vendorId)
      .executeTakeFirst();

    if (!row) throw new AppError('QR_INVALID', 'No such stall.');

    /**
     * "Available" means all three of PRD §6's concepts agree.
     *
     * `status = ACTIVE` (the product exists and is sold), `availability =
     * AVAILABLE` (not sold out or paused). Counting rows without those filters
     * would let a stall activate on a menu of discontinued items — the gate
     * would pass and the stall would show as open selling nothing, which is the
     * exact failure `MENU_EMPTY` is written to prevent.
     */
    const menu = await this.db
      .selectFrom('menu_item as mi')
      .innerJoin('menu as m', 'm.id', 'mi.menu_id')
      .where('m.vendor_id', '=', vendorId)
      .where('mi.status', '=', 'ACTIVE')
      .where('mi.availability', '=', 'AVAILABLE')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();

    const staff = await this.db
      .selectFrom('user_role_assignment as ura')
      .innerJoin('platform_user as pu', 'pu.id', 'ura.user_id')
      .where('ura.vendor_id', '=', vendorId)
      .where('ura.role', 'in', KITCHEN_ROLES)
      .where('ura.status', '=', 'ACTIVE')
      // The ASSIGNMENT being active is not enough — a suspended person with a
      // live assignment cannot sign in, so the kitchen still cannot see orders.
      .where('pu.status', '=', 'ACTIVE')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();

    return { row, menuItems: Number(menu.n ?? 0), staff: Number(staff.n ?? 0) };
  }

  private toSnapshot(s: Awaited<ReturnType<VendorRepository['snapshot']>>): VendorSnapshot {
    return {
      status: s.row.status,
      name: s.row.name,
      legalName: s.row.legal_name,
      settlementMode: s.row.settlement_mode,
      pan: s.row.pan,
      gstin: s.row.gstin,
      fssaiLicence: s.row.fssai_licence,
      bankAccountRef: s.row.bank_account_ref,
      kycCompletedAt: s.row.kyc_completed_at,
      providerLinkedAccountId: s.row.provider_linked_account_id,
      availableMenuItemCount: s.menuItems,
      activeStaffCount: s.staff,
    };
  }

  /** Every stall in one court, each with how far off activation it is. */
  async listByCourt(foodCourtId: string): Promise<VendorSummary[]> {
    const rows = await this.db
      .selectFrom('vendor')
      .select([
        'id',
        'food_court_id',
        'name',
        'cuisine',
        'status',
        'estimated_prep_minutes',
        'legal_name',
        'settlement_mode',
        'pan',
        'gstin',
        'fssai_licence',
        'bank_account_ref',
        'kyc_completed_at',
        'provider_linked_account_id',
      ])
      .where('food_court_id', '=', foodCourtId)
      .orderBy('status', 'asc')
      .orderBy('name', 'asc')
      .execute();

    if (rows.length === 0) return [];

    /**
     * The counts for every stall in the court, in two queries rather than 2N.
     *
     * A court has single-digit stalls today, so N+1 would be invisible — which
     * is exactly why it is worth not writing: this list is the console's home
     * screen, and the version that is fine at five stalls is the version still
     * running at fifty.
     */
    const ids = rows.map((r) => r.id);

    const menuCounts = await this.db
      .selectFrom('menu_item as mi')
      .innerJoin('menu as m', 'm.id', 'mi.menu_id')
      .where('m.vendor_id', 'in', ids)
      .where('mi.status', '=', 'ACTIVE')
      .where('mi.availability', '=', 'AVAILABLE')
      .groupBy('m.vendor_id')
      .select((eb) => ['m.vendor_id as vendor_id', eb.fn.countAll<string>().as('n')])
      .execute();

    const staffCounts = await this.db
      .selectFrom('user_role_assignment as ura')
      .innerJoin('platform_user as pu', 'pu.id', 'ura.user_id')
      .where('ura.vendor_id', 'in', ids)
      .where('ura.role', 'in', KITCHEN_ROLES)
      .where('ura.status', '=', 'ACTIVE')
      .where('pu.status', '=', 'ACTIVE')
      .groupBy('ura.vendor_id')
      .select((eb) => ['ura.vendor_id as vendor_id', eb.fn.countAll<string>().as('n')])
      .execute();

    const menuBy = new Map(menuCounts.map((c) => [c.vendor_id, Number(c.n)]));
    const staffBy = new Map(
      staffCounts.map((c) => [c.vendor_id as string, Number(c.n)]),
    );

    return rows.map((r) => {
      const readiness = assessVendorReadiness({
        status: r.status,
        name: r.name,
        legalName: r.legal_name,
        settlementMode: r.settlement_mode,
        pan: r.pan,
        gstin: r.gstin,
        fssaiLicence: r.fssai_licence,
        bankAccountRef: r.bank_account_ref,
        kycCompletedAt: r.kyc_completed_at,
        providerLinkedAccountId: r.provider_linked_account_id,
        availableMenuItemCount: menuBy.get(r.id) ?? 0,
        activeStaffCount: staffBy.get(r.id) ?? 0,
      });

      return {
        id: r.id,
        foodCourtId: r.food_court_id,
        name: r.name,
        cuisine: r.cuisine,
        status: r.status,
        estimatedPrepMinutes: r.estimated_prep_minutes,
        blockerCount: readiness.blockers.length,
      };
    });
  }

  async get(vendorId: string): Promise<VendorDetail> {
    const s = await this.snapshot(vendorId);
    const snap = this.toSnapshot(s);
    const readiness = assessVendorReadiness(snap);

    return {
      id: s.row.id,
      foodCourtId: s.row.food_court_id,
      name: s.row.name,
      cuisine: s.row.cuisine,
      status: s.row.status,
      estimatedPrepMinutes: s.row.estimated_prep_minutes,
      // Through `parseHours` rather than raw, so the console edits the same
      // shape the customer app derives from — a malformed window that the read
      // path silently ignores must not reappear in the editor as if it counted.
      operatingHours: parseHours(s.row.operating_hours) as Record<
        string,
        { open: string; close: string }[]
      >,
      offerUploadsEnabled: s.row.offer_uploads_enabled,
      offerImageUrl: s.row.offer_image_url,
      offerHeadline: s.row.offer_headline,
      legalName: s.row.legal_name,
      settlementMode: s.row.settlement_mode,
      pan: s.row.pan,
      gstin: s.row.gstin,
      fssaiLicence: s.row.fssai_licence,
      bankAccountRef: s.row.bank_account_ref,
      kycCompletedAt: s.row.kyc_completed_at,
      providerLinkedAccountId: s.row.provider_linked_account_id,
      availableMenuItemCount: s.menuItems,
      activeStaffCount: s.staff,
      blockerCount: readiness.blockers.length,
      readiness,
    };
  }

  /**
   * Create a stall as DRAFT.
   *
   * DRAFT and not ACTIVE, always, with no option to override. §5.2 exists
   * because activating a stall is the moment the platform starts accepting
   * money on its behalf, and a `status` parameter here would be a way to skip
   * the gate that looked like a convenience.
   *
   * An empty menu is also created alongside. Without it the first menu import
   * has to create one, which means `menu.vendor_id` is unique-ish by convention
   * rather than by construction, and two concurrent imports can produce two
   * menus for one stall.
   */
  async create(foodCourtId: string, input: CreateVendorInput): Promise<VendorDetail> {
    const court = await this.db
      .selectFrom('food_court')
      .select(['id', 'status'])
      .where('id', '=', foodCourtId)
      .executeTakeFirst();

    if (!court) throw new AppError('QR_INVALID', 'No such food court.');
    if (court.status === 'INACTIVE') {
      throw new AppError('INVALID_TRANSITION', 'That court is closed. Stalls cannot be added to it.');
    }

    const name = input.name.trim();
    if (name === '') throw new AppError('OPTION_RULE_VIOLATION', 'A stall needs a name.');

    const clash = await this.db
      .selectFrom('vendor')
      .select('id')
      .where('food_court_id', '=', foodCourtId)
      .where('name', '=', name)
      .where('status', '!=', 'INACTIVE')
      .executeTakeFirst();

    if (clash) {
      throw new AppError(
        'CROSS_VENDOR_CART',
        `This court already has a stall called "${name}".`,
      );
    }

    const id = await this.db.transaction().execute(async (trx) => {
      const vendor = await trx
        .insertInto('vendor')
        .values({
          food_court_id: foodCourtId,
          name,
          status: 'DRAFT',
          ...(input.cuisine ? { cuisine: [...input.cuisine] } : {}),
          ...(input.estimatedPrepMinutes !== undefined
            ? { estimated_prep_minutes: input.estimatedPrepMinutes }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx.insertInto('menu').values({ vendor_id: vendor.id }).execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'vendor.created',
          entity: 'vendor',
          entityId: vendor.id,
          foodCourtId,
          vendorId: vendor.id,
          afterValue: { name, status: 'DRAFT' },
        }),
        trx,
      );

      return vendor.id;
    });

    return this.get(id);
  }

  /**
   * Patch onboarding fields.
   *
   * The before/after audit entry is the reason this reads the row first. §13.3's
   * whole argument about refunds — that moving an act out of a UI removes the
   * record, not the act — applies just as well to a bank account: somebody
   * changing where a stall's money goes must leave a trail saying what it was
   * before.
   */
  async update(vendorId: string, input: UpdateVendorInput): Promise<VendorDetail> {
    const before = await this.get(vendorId);

    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) {
      const n = input.name.trim();
      if (n === '') throw new AppError('OPTION_RULE_VIOLATION', 'A stall needs a name.');
      patch['name'] = n;
    }
    if (input.cuisine !== undefined) patch['cuisine'] = [...input.cuisine];
    if (input.estimatedPrepMinutes !== undefined) {
      patch['estimated_prep_minutes'] = input.estimatedPrepMinutes;
    }

    const legalName = trimOrNull(input.legalName);
    if (legalName !== undefined) patch['legal_name'] = legalName;

    if (input.settlementMode !== undefined) patch['settlement_mode'] = input.settlementMode;

    const pan = upperOrNull(input.pan);
    if (pan !== undefined) patch['pan'] = pan;

    const gstin = upperOrNull(input.gstin);
    if (gstin !== undefined) patch['gstin'] = gstin;

    const fssai = trimOrNull(input.fssaiLicence);
    if (fssai !== undefined) patch['fssai_licence'] = fssai;

    const bank = trimOrNull(input.bankAccountRef);
    if (bank !== undefined) patch['bank_account_ref'] = bank;

    const linked = trimOrNull(input.providerLinkedAccountId);
    if (linked !== undefined) patch['provider_linked_account_id'] = linked;

    if (input.offerUploadsEnabled !== undefined) {
      patch['offer_uploads_enabled'] = input.offerUploadsEnabled;
      /*
       * Withdrawing the grant does NOT delete the artwork.
       *
       * The stall keeps what it uploaded and simply stops appearing — so
       * re-granting the slot next month does not mean chasing them for the
       * image again. The customer endpoint checks the flag, not the image.
       */
    }

    if (input.operatingHours !== undefined) {
      patch['operating_hours'] = JSON.stringify(input.operatingHours);
    }

    if (input.kycCompleted !== undefined) {
      // Set once, cleared explicitly. Re-confirming an already-confirmed KYC
      // must not move the timestamp — that date is evidence of when the
      // provider cleared this vendor, not of the last time somebody saved.
      patch['kyc_completed_at'] = input.kycCompleted
        ? (before.kycCompletedAt ?? new Date())
        : null;
    }

    if (Object.keys(patch).length === 0) return before;

    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('vendor').set(patch).where('id', '=', vendorId).execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'vendor.updated',
          entity: 'vendor',
          entityId: vendorId,
          foodCourtId: before.foodCourtId,
          vendorId,
          beforeValue: {
            legalName: before.legalName,
            settlementMode: before.settlementMode,
            pan: before.pan,
            gstin: before.gstin,
            fssaiLicence: before.fssaiLicence,
            bankAccountRef: before.bankAccountRef,
            providerLinkedAccountId: before.providerLinkedAccountId,
            kycCompletedAt: before.kycCompletedAt,
          },
          afterValue: patch,
        }),
        trx,
      );
    });

    return this.get(vendorId);
  }

  /**
   * Move a stall's status, with the §5.2 gate on the way in to ACTIVE.
   *
   * THE GATE RUNS INSIDE THE TRANSACTION, AGAINST A LOCKED ROW.
   *
   * Reading the snapshot, deciding, and then updating in three separate
   * statements leaves a window: two console tabs, both shown a passing
   * checklist, both activating — harmless here, since the result is the same
   * status. The window that matters is the other direction. Between "the menu
   * has one available item" and the UPDATE, that item can be marked sold out by
   * the stall's own tablet, and the stall goes live with an empty menu having
   * passed a check that was true when it was asked.
   *
   * `FOR UPDATE` on the vendor row closes it: the availability write and this
   * one serialise, and whichever loses re-reads.
   */
  // =========================================================================
  // Offer slots — the platform's grant, and the stall's request for it
  // =========================================================================

  /**
   * Every stall's carousel slot, across every court.
   *
   * NOT SCOPED TO A COURT, deliberately. The point of the screen this feeds is
   * that somebody answering requests should not have to guess which venue a
   * waiting stall is in, open that court, then open that stall. A queue you
   * have to go looking for is a queue nobody works through.
   */
  async listOfferSlots(): Promise<OfferSlotRow[]> {
    const rows = await this.db
      .selectFrom('vendor')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'vendor.id as id',
        'vendor.name as name',
        'vendor.status as status',
        'vendor.offer_uploads_enabled as enabled',
        'vendor.offer_image_url as imageUrl',
        'vendor.offer_headline as headline',
        'vendor.offer_slot_requested_at as requestedAt',
        'vendor.offer_slot_decided_at as decidedAt',
        // The fourth condition. See `showingNow` below.
        'vendor.operating_hours as operatingHours',
        'vendor.temp_closed_until as tempClosedUntil',
        'vendor.dispatch_blocked_at as dispatchBlockedAt',
        'food_court.id as foodCourtId',
        'food_court.name as foodCourtName',
        'food_court.timezone as timezone',
      ])
      // A closed stall is not a candidate for promotion and only pads the list.
      .where('vendor.status', '!=', 'INACTIVE')
      .orderBy('vendor.offer_slot_requested_at', 'asc')
      .orderBy('vendor.name', 'asc')
      .execute();

    const now = new Date();

    return rows.map((v) => {
      /*
       * ======================================================================
       * GRANTED AND FILLED IS NOT THE SAME AS ON SCREEN
       * ======================================================================
       *
       * This screen used to say "Live" the moment a slot was granted and the
       * kitchen had uploaded artwork. That is a claim about the CUSTOMER'S
       * screen, and it was wrong whenever the stall was shut — the carousel
       * only carries stalls accepting orders right now, deliberately, because
       * leading the whole app with a closed stall's offer is an advertisement
       * for a disappointment.
       *
       * So an operator would grant a slot, watch the kitchen upload a banner,
       * read the word "Live", look at the customer app, and find nothing —
       * with no way to tell a configuration problem from a stall that simply
       * closes at four. The reason is computed here rather than left for
       * somebody to work out from three other screens.
       *
       * The rule is COPIED from the discovery endpoint rather than shared, and
       * that is a real cost: two implementations of one condition. Extracting
       * it would mean the console importing from `tenancy/`, which is the
       * boundary this codebase keeps hardest. `tests/conformance` asserts the
       * two agree.
       */
      const paused = (v.tempClosedUntil?.getTime() ?? 0) > now.getTime();
      const withinHours = isOpenAt(parseHours(v.operatingHours), now, v.timezone);
      const accepting =
        v.status === 'ACTIVE' && !v.dispatchBlockedAt && !paused && withinHours;

      const filled = v.imageUrl !== null;

      return {
        id: v.id,
        name: v.name,
        status: v.status,
        foodCourtId: v.foodCourtId,
        foodCourtName: v.foodCourtName,
        enabled: v.enabled,
        /** A granted slot with no artwork is a slot doing nothing. */
        filled,
        headline: v.headline,
        requestedAt: v.requestedAt?.toISOString() ?? null,
        decidedAt: v.decidedAt?.toISOString() ?? null,
        /** On a customer's screen RIGHT NOW. All four conditions, not two. */
        showingNow: v.enabled && filled && accepting,
        /**
         * Why not, when everything is configured and it still is not showing.
         *
         * Null when it IS showing, and null when the configuration is the
         * problem — the screen already says "no artwork" or "no slot" for
         * those, and repeating it here would be two answers to one question.
         */
        notShowingReason:
          !v.enabled || !filled || accepting
            ? null
            : v.status !== 'ACTIVE'
              ? `the stall is ${String(v.status).toLowerCase()}`
              : v.dispatchBlockedAt
                ? 'the stall is blocked for not accepting orders'
                : paused
                  ? 'the kitchen has paused the stall'
                  : 'the stall is outside its opening hours',
      };
    });
  }

  /**
   * Grant, withdraw, or decline — three answers, one call.
   *
   *   enabled true                    grants, and clears any pending request
   *   enabled false, request pending  DECLINES it
   *   enabled false, none pending     WITHDRAWS a slot already granted
   *
   * `offer_slot_decided_at` is stamped on all three, and that is the
   * load-bearing part. Clearing a request without recording that somebody
   * answered leaves the stall looking at the same "you have no slot" screen it
   * started on — it concludes the request was lost and asks again next week,
   * which is the product quietly training vendors to nag.
   *
   * THE ARTWORK SURVIVES A WITHDRAWAL. Re-granting next month should not mean
   * chasing the stall for its image again; the customer endpoint checks the
   * flag, not the image.
   */
  async setOfferSlot(
    vendorId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; declined: boolean }> {
    const before = await this.db
      .selectFrom('vendor')
      .select('offer_slot_requested_at')
      .where('id', '=', vendorId)
      .executeTakeFirst();

    if (!before) throw new AppError('QR_INVALID', 'No such stall.');

    const declined = !enabled && before.offer_slot_requested_at !== null;

    await this.db
      .updateTable('vendor')
      .set({
        offer_uploads_enabled: enabled,
        // Always cleared: a CHECK refuses a pending request on a granted slot,
        // and an answered request is no longer pending either way.
        offer_slot_requested_at: null,
        offer_slot_decided_at: new Date(),
      })
      .where('id', '=', vendorId)
      .execute();

    return { enabled, declined };
  }

  async setStatus(vendorId: string, to: VendorStatus, reason: string): Promise<VendorDetail> {
    const current = await this.get(vendorId);

    if (current.status === to) return current;

    if (!canTransitionVendor(current.status, to)) {
      throw new AppError(
        'INVALID_TRANSITION',
        current.status === 'INACTIVE'
          ? 'This stall has left the court. Re-onboard it as a new stall — its licence, bank details and menu all need checking again.'
          : `A ${current.status.toLowerCase()} stall cannot become ${to.toLowerCase()}.`,
      );
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('vendor')
        .select('id')
        .where('id', '=', vendorId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (to === 'ACTIVE') {
        const fresh = await this.snapshot(vendorId);
        const readiness = assessVendorReadiness(this.toSnapshot(fresh));

        if (!readiness.canActivate) {
          throw new AppError(
            'VENDOR_CLOSED',
            `This stall is not ready to take orders. ${readiness.blockers.length} thing${
              readiness.blockers.length === 1 ? '' : 's'
            } still needed: ${readiness.blockers.map((b) => b.message).join(' ')}`,
          );
        }
      }

      await trx.updateTable('vendor').set({ status: to }).where('id', '=', vendorId).execute();

      // One action per destination. `vendor.deactivated` is deliberately not
      // `vendor.suspended`: suspension is reversible, INACTIVE is terminal, and
      // an audit log that cannot tell them apart cannot answer "did this stall
      // leave, or is it coming back".
      const action =
        to === 'ACTIVE'
          ? 'vendor.activated'
          : to === 'SUSPENDED'
            ? 'vendor.suspended'
            : 'vendor.deactivated';

      await this.audit.write(
        buildAuditEntry({
          action,
          entity: 'vendor',
          entityId: vendorId,
          foodCourtId: current.foodCourtId,
          vendorId,
          beforeValue: { status: current.status },
          afterValue: { status: to, reason },
        }),
        trx,
      );
    });

    return this.get(vendorId);
  }
}
