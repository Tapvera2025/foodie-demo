/**
 * Food courts, from the platform console.
 *
 * WHAT A FOOD COURT IS, IN THIS SYSTEM
 *
 * The scannable identity of a venue. §2.1: the QR belongs to the venue, not the
 * table, so `food_court.qr_token` is the single credential that lets a customer
 * in. Everything else on the row — hours, timezone, config — is context the
 * ordering path reads later.
 *
 * WHY THIS IS `tenant.manage` AND NOT ITS OWN PERMISSION
 *
 * Creating a court is creating a tenant. It is the one thing `SUPER_ADMIN` is
 * for, and the one permission it holds. Adding a `court.write` permission would
 * look tidier and would mean the matrix had two names for one act — and the
 * second one would inevitably be granted to somebody the first was withheld
 * from.
 *
 * NO DELETE
 *
 * Courts go INACTIVE, they are not removed. Orders, ledger entries and audit
 * rows all point at the court, and every one of those is append-only or
 * financially authoritative. A deleted court is a settlement report that cannot
 * name where the money came from.
 */

import type { Kysely, Transaction } from 'kysely';

import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { AppError } from '../platform/errors.js';
import type { Database, EntityStatus, Json } from '../platform/schema.js';

export interface CourtSummary {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly address: string | null;
  readonly status: EntityStatus;
  /** Whether a scannable token exists. The token itself is not listed — see below. */
  readonly hasQr: boolean;
  readonly vendorCount: number;
  readonly activeVendorCount: number;
  /**
   * Orders with money taken and food not yet collected.
   *
   * The one number on the console worth refreshing. It deliberately EXCLUDES
   * `CREATED` and `PAYMENT_PENDING`: those are abandoned baskets, not live
   * orders, and counting them would report a busy court on a night when nobody
   * finished paying.
   */
  readonly liveOrderCount: number;
  readonly createdAt: Date;
}

/** Money taken, food not collected. See `liveOrderCount`. */
const LIVE_ORDER_STATUSES = [
  'PAYMENT_CONFIRMED',
  'DISPATCHED',
  'ACKNOWLEDGED',
  'PREPARING',
  'READY',
] as const;

export interface CourtDetail extends CourtSummary {
  readonly address: string | null;
  readonly timezone: string;
  readonly operatingHours: Json;
  readonly config: Json;
}

export interface CreateCourtInput {
  readonly name: string;
  readonly city: string;
  readonly address?: string | undefined;
  readonly timezone?: string | undefined;
}

export interface UpdateCourtInput {
  readonly name?: string | undefined;
  readonly city?: string | undefined;
  readonly address?: string | null | undefined;
  readonly timezone?: string | undefined;
}

/**
 * Court status transitions.
 *
 * Deliberately narrower than the vendor ladder in one way: there is no DRAFT.
 * A court exists because somebody signed a venue; there is no checklist to pass
 * before it can hold stalls, and a DRAFT state nobody can fail is a state that
 * only ever gets skipped.
 */
const ALLOWED: Readonly<Record<EntityStatus, readonly EntityStatus[]>> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['SUSPENDED', 'INACTIVE'],
  SUSPENDED: ['ACTIVE', 'INACTIVE'],
  INACTIVE: [],
};

export function canTransitionCourt(from: EntityStatus, to: EntityStatus): boolean {
  return ALLOWED[from].includes(to);
}

export class CourtRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  /**
   * Every court, with its stall counts.
   *
   * The counts are correlated subqueries rather than a `GROUP BY` join, because
   * a court with no vendors must still appear — and the first version of this,
   * written as an inner join, silently hid exactly the courts somebody had just
   * created and was looking for.
   */
  async list(): Promise<CourtSummary[]> {
    const rows = await this.db
      .selectFrom('food_court as fc')
      .select((eb) => [
        'fc.id',
        'fc.name',
        'fc.city',
        'fc.status',
        'fc.qr_token',
        'fc.created_at',
        eb
          .selectFrom('vendor')
          .whereRef('vendor.food_court_id', '=', 'fc.id')
          .select((e) => e.fn.countAll<string>().as('n'))
          .as('vendor_count'),
        'fc.address',
        eb
          .selectFrom('vendor')
          .whereRef('vendor.food_court_id', '=', 'fc.id')
          .where('vendor.status', '=', 'ACTIVE')
          .select((e) => e.fn.countAll<string>().as('n'))
          .as('active_vendor_count'),
        eb
          .selectFrom('order')
          .whereRef('order.food_court_id', '=', 'fc.id')
          .where('order.status', 'in', LIVE_ORDER_STATUSES)
          .select((e) => e.fn.countAll<string>().as('n'))
          .as('live_order_count'),
      ])
      // INACTIVE courts sort last but are never hidden. A console that quietly
      // omits rows is a console you cannot trust to answer "is it gone".
      .orderBy('fc.status', 'asc')
      .orderBy('fc.name', 'asc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      address: r.address,
      status: r.status,
      hasQr: r.qr_token !== null,
      vendorCount: Number(r.vendor_count ?? 0),
      activeVendorCount: Number(r.active_vendor_count ?? 0),
      liveOrderCount: Number(r.live_order_count ?? 0),
      createdAt: r.created_at,
    }));
  }

  async get(id: string): Promise<CourtDetail> {
    const row = await this.db
      .selectFrom('food_court')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) throw new AppError('QR_INVALID', 'No such food court.');

    const counts = await this.db
      .selectFrom('vendor')
      .select((eb) => [
        eb.fn.countAll<string>().as('total'),
        eb.fn
          .sum<string>(eb.case().when('status', '=', 'ACTIVE').then(1).else(0).end())
          .as('active'),
      ])
      .where('food_court_id', '=', id)
      .executeTakeFirstOrThrow();

    const live = await this.db
      .selectFrom('order')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('food_court_id', '=', id)
      .where('status', 'in', LIVE_ORDER_STATUSES)
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      name: row.name,
      city: row.city,
      status: row.status,
      hasQr: row.qr_token !== null,
      vendorCount: Number(counts.total ?? 0),
      activeVendorCount: Number(counts.active ?? 0),
      liveOrderCount: Number(live.n ?? 0),
      createdAt: row.created_at,
      address: row.address,
      timezone: row.timezone,
      operatingHours: row.operating_hours,
      config: row.config,
    };
  }

  /**
   * A new court starts ACTIVE and with NO QR token.
   *
   * Those two together are the interesting part. ACTIVE because there is nothing
   * to check — but a court with no token cannot be scanned, so "active" here
   * means "the platform recognises this venue", not "customers can order". The
   * console has to show that difference, because a court that looks live and
   * cannot be entered is the most confusing state this object has.
   *
   * Issuing the token is a separate, audited act (§13.1) for the reason that
   * section gives: a token is a credential, and a credential created as a side
   * effect of creating something else is one nobody remembers issuing.
   */
  async create(input: CreateCourtInput): Promise<CourtDetail> {
    const name = input.name.trim();
    const city = input.city.trim();

    // `food_court.name` has no unique constraint — two malls can share a name in
    // different cities. The pair is what must not repeat, and checking it here
    // gives a usable message rather than a constraint violation that does not
    // exist yet anyway.
    const clash = await this.db
      .selectFrom('food_court')
      .select('id')
      .where('name', '=', name)
      .where('city', '=', city)
      .where('status', '!=', 'INACTIVE')
      .executeTakeFirst();

    if (clash) {
      throw new AppError(
        'CROSS_VENDOR_CART',
        `A court called "${name}" already exists in ${city}. Use a name that tells them apart.`,
      );
    }

    const created = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('food_court')
        .values({
          name,
          city,
          status: 'ACTIVE',
          ...(input.address?.trim() ? { address: input.address.trim() } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.write(
        buildAuditEntry({
          action: 'court.created',
          entity: 'food_court',
          entityId: row.id,
          foodCourtId: row.id,
          afterValue: { name, city },
        }),
        trx,
      );

      return row;
    });

    return {
      id: created.id,
      name: created.name,
      city: created.city,
      status: created.status,
      hasQr: created.qr_token !== null,
      vendorCount: 0,
      activeVendorCount: 0,
      // A court created a moment ago has no orders. Stated rather than counted.
      liveOrderCount: 0,
      createdAt: created.created_at,
      address: created.address,
      timezone: created.timezone,
      operatingHours: created.operating_hours,
      config: created.config,
    };
  }

  async update(id: string, input: UpdateCourtInput): Promise<CourtDetail> {
    const before = await this.get(id);

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name.trim();
    if (input.city !== undefined) patch['city'] = input.city.trim();
    if (input.timezone !== undefined) patch['timezone'] = input.timezone;
    if (input.address !== undefined) {
      // An empty string means "clear it", which is different from not sending
      // the field at all. Collapsing the two would make it impossible to remove
      // an address once typed.
      patch['address'] = input.address === null || input.address.trim() === ''
        ? null
        : input.address.trim();
    }

    if (Object.keys(patch).length === 0) return before;

    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('food_court').set(patch).where('id', '=', id).execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'court.updated',
          entity: 'food_court',
          entityId: id,
          foodCourtId: id,
          beforeValue: { name: before.name, city: before.city, address: before.address },
          afterValue: patch,
        }),
        trx,
      );
    });

    return this.get(id);
  }

  /**
   * Move a court's status.
   *
   * SUSPENDING A COURT DOES NOT TOUCH ITS STALLS.
   *
   * It could cascade, and deliberately does not. A suspended court already
   * stops customers entering — the QR resolve path checks court status — so
   * cascading would change nothing a customer can see while destroying the
   * information needed to bring the court back: which stalls were live before.
   * Reactivating would then need somebody to remember, and they will not.
   */
  async setStatus(id: string, to: EntityStatus, reason: string): Promise<CourtDetail> {
    const before = await this.get(id);

    if (before.status === to) return before;

    if (!canTransitionCourt(before.status, to)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `A ${before.status.toLowerCase()} court cannot become ${to.toLowerCase()}.`,
      );
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('food_court').set({ status: to }).where('id', '=', id).execute();
      await this.writeStatusAudit(trx, id, before.status, to, reason);
    });

    return this.get(id);
  }

  /**
   * One action name per destination, not a generic `status_changed`.
   *
   * `audit_log.action` is TEXT in the database, so this union is a TypeScript
   * contract rather than a constraint — which makes it easier, not harder, to
   * let a vague name in. Naming the destination is what lets somebody query
   * "every stall that left this year" without parsing `after_value`.
   */
  private async writeStatusAudit(
    trx: Transaction<Database>,
    id: string,
    from: EntityStatus,
    to: EntityStatus,
    reason: string,
  ): Promise<void> {
    const action =
      to === 'ACTIVE'
        ? 'court.activated'
        : to === 'SUSPENDED'
          ? 'court.suspended'
          : 'court.deactivated';

    await this.audit.write(
      buildAuditEntry({
        action,
        entity: 'food_court',
        entityId: id,
        foodCourtId: id,
        beforeValue: { status: from },
        // The reason is required by the controller, not defaulted here. A
        // status change with an empty reason is the row you find six months
        // later and cannot explain.
        afterValue: { status: to, reason },
      }),
      trx,
    );
  }
}
