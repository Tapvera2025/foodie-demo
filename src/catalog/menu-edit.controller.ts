/**
 * One dish at a time — create, edit, discontinue.
 *
 * WHY THIS IS SEPARATE FROM THE CSV IMPORT
 *
 * The import REPLACES a menu: everything in the database and absent from the
 * file is discontinued. That is right for "here is our menu" and catastrophic
 * for "the momos went up by ₹20" — the owner would have to re-upload all forty
 * items, and anything they forgot would silently come off sale.
 *
 * So this is the other shape: additive, one row, no side effects on anything
 * the request did not name.
 *
 * WHY IT IS `menu.write` AND THEREFORE OWNER-ONLY
 *
 * `menu.write` is `{ VENDOR_OWNER: ALLOW, PLATFORM_OPS: ALLOW }` and
 * deliberately excludes `VENDOR_OPERATOR`. A cook has `stock.toggle` and
 * `inventory.write` — they can say what is off and how much is left, which is
 * the whole of what a kitchen decides during service. Prices are not a service
 * decision, and a price field reachable by whoever is standing at the tablet is
 * how a ₹180 roll becomes ₹18 in the middle of a rush.
 *
 * PRICES ARE PAISE, IN AND OUT
 *
 * The client sends rupees because that is what an owner types, and converts at
 * the edge. Money never becomes a float anywhere: `Math.round(rupees * 100)` is
 * done once, on a value bounded by the schema, and everything downstream is an
 * integer. PRD §14.5.
 */

import {
  Body,
  Controller,
  Delete,
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
import { StaffGuard, staffOf, vendorScopeOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';

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

const DIETARY = ['VEG', 'NON_VEG', 'EGG', 'JAIN'] as const;

/**
 * Price in RUPEES, two decimals, bounded.
 *
 * ₹100,000 is not a real menu price and the ceiling is there to make a
 * misplaced decimal fail loudly rather than book a ₹18,000 plate of rice.
 */
const Rupees = z.number().min(0).max(100_000).multipleOf(0.01);

const CreateItem = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(1).max(80),
  priceRupees: Rupees,
  description: z.string().trim().max(500).optional(),
  /**
   * At most one, and optional.
   *
   * No dietary information is NOT the same as vegetarian — `VegMark` renders
   * nothing rather than a green circle for exactly this reason, because a green
   * mark on an unlabelled item is a claim the platform cannot support and the
   * one mistake that matters most to a Jain or vegetarian diner.
   */
  dietary: z.enum(DIETARY).optional(),
  /** Basis points. 500 = 5%, the schema default for food. */
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  /**
   * A URL, not an upload.
   *
   * There is no object storage configured, so an upload endpoint would need
   * somewhere to put the bytes before it could exist. A URL works today, the
   * CSV import already writes this column the same way, and swapping to an
   * upload later changes how the string is produced without changing anything
   * that reads it.
   *
   * `.url()` rather than a free string: a broken path renders as a missing
   * image, which on a menu looks identical to a dish nobody photographed.
   */
  imageUrl: z.string().url().max(500).nullable().optional(),
});

const UpdateItem = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  priceRupees: Rupees.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  dietary: z.enum(DIETARY).nullable().optional(),
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
});

@Controller('api/v1/vendor/menu')
@UseGuards(StaffGuard)
export class MenuEditController {
  private readonly audit: AuditRepository;

  constructor(@Inject(DB) private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  /**
   * The caller's stall, if they may write its menu.
   *
   * Two checks, and they fail for different reasons: no vendor scope is a
   * platform account on the wrong screen; no `menu.write` is a cook reaching
   * past their job. The scope is passed to `decide` so a VENDOR_OWNER cannot
   * name another stall's id — `assignmentCoversScope` confines an assignment
   * with a `vendorId` to that vendor and nothing else.
   */
  private scope(req: RequestWithStaff): { vendorId: string; actorId: string } {
    const staff = staffOf(req);
    const vendorId = vendorScopeOf(staff);
    if (!vendorId) {
      throw new AppError('TENANT_SCOPE_VIOLATION', 'This account is not attached to a stall.');
    }

    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'menu.write',
      { vendorId },
    );

    if (!decision.allowed) {
      throw new AppError(
        'ACCOUNT_SUSPENDED',
        'Only the stall owner can change the menu. Availability and stock are on the Menu tab for everyone.',
      );
    }

    return { vendorId, actorId: staff.userId };
  }

  /** This stall's menu row, created lazily for a stall that predates it. */
  private async menuId(vendorId: string): Promise<string> {
    const menu = await this.db
      .selectFrom('menu')
      .select('id')
      .where('vendor_id', '=', vendorId)
      .executeTakeFirst();

    if (menu) return menu.id;

    // Stalls created through the console get a menu row alongside them. This
    // covers anything seeded or migrated before that existed, so a first edit
    // never fails on a missing parent.
    const created = await this.db
      .insertInto('menu')
      .values({ vendor_id: vendorId })
      .returning('id')
      .executeTakeFirstOrThrow();

    return created.id;
  }

  /**
   * Find or create a category by NAME.
   *
   * The owner types "Starters"; they do not pick a UUID. Matching on name
   * within this menu keeps the form to one text field and makes the common case
   * — adding a second dish to an existing section — land in the right place
   * without a lookup.
   *
   * Case-insensitive, because "starters" and "Starters" are the same section to
   * everyone except a database.
   */
  private async categoryId(menuId: string, name: string): Promise<string> {
    const trimmed = name.trim();

    const existing = await this.db
      .selectFrom('menu_category')
      .select('id')
      .where('menu_id', '=', menuId)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', trimmed.toLowerCase()))
      .executeTakeFirst();

    if (existing) return existing.id;

    const last = await this.db
      .selectFrom('menu_category')
      .select((eb) => eb.fn.max<number>('sort_order').as('n'))
      .where('menu_id', '=', menuId)
      .executeTakeFirst();

    const created = await this.db
      .insertInto('menu_category')
      .values({ menu_id: menuId, name: trimmed, sort_order: (last?.n ?? 0) + 1 })
      .returning('id')
      .executeTakeFirstOrThrow();

    return created.id;
  }

  /** The sections on this menu, so the form can offer them rather than ask. */
  @Get('categories')
  async categories(@Req() req: RequestWithStaff): Promise<unknown> {
    const { vendorId } = this.scope(req);

    const rows = await this.db
      .selectFrom('menu_category as mc')
      .innerJoin('menu as m', 'm.id', 'mc.menu_id')
      .where('m.vendor_id', '=', vendorId)
      .where('mc.is_active', '=', true)
      .select(['mc.id as id', 'mc.name as name'])
      .orderBy('mc.sort_order')
      .execute();

    return { categories: rows };
  }

  @Post('items')
  async create(@Req() req: RequestWithStaff, @Body() body: unknown): Promise<unknown> {
    const { vendorId, actorId } = this.scope(req);
    const input = CreateItem.parse(body);

    const menuId = await this.menuId(vendorId);
    const categoryId = await this.categoryId(menuId, input.category);

    /**
     * A duplicate name in the same menu is refused.
     *
     * Not a database constraint — the CSV import matches on name to decide
     * update-or-create, so two items called "Veg Momo" would make every future
     * import ambiguous and silently update whichever it found first. Refusing
     * here keeps that matching honest.
     */
    const clash = await this.db
      .selectFrom('menu_item')
      .select('id')
      .where('menu_id', '=', menuId)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', input.name.toLowerCase()))
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();

    if (clash) {
      throw new AppError('CROSS_VENDOR_CART', `"${input.name}" is already on this menu.`);
    }

    const last = await this.db
      .selectFrom('menu_item')
      .select((eb) => eb.fn.max<number>('sort_order').as('n'))
      .where('menu_category_id', '=', categoryId)
      .executeTakeFirst();

    const item = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('menu_item')
        .values({
          menu_id: menuId,
          menu_category_id: categoryId,
          name: input.name,
          base_price_paise: Math.round(input.priceRupees * 100),
          ...(input.taxRateBps !== undefined ? { tax_rate_bps: input.taxRateBps } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
          dietary_flags: input.dietary ? [input.dietary] : [],
          status: 'ACTIVE',
          // A new dish is on sale immediately. The owner adding it is standing
          // in the kitchen that cooks it; making them add it and then switch it
          // on would be a second step with no decision in it.
          availability: 'AVAILABLE',
          sort_order: (last?.n ?? 0) + 1,
        })
        .returning(['id', 'name', 'base_price_paise'])
        .executeTakeFirstOrThrow();

      await this.audit.write(
        buildAuditEntry({
          action: 'menu.imported',
          entity: 'menu_item',
          entityId: row.id,
          vendorId,
          afterValue: {
            via: 'vendor_single_item',
            name: row.name,
            pricePaise: row.base_price_paise,
            category: input.category,
          },
        }),
        trx,
      );

      return row;
    });

    log().info(
      { event: 'menu_item_created', vendorId, itemId: item.id, actorId },
      'a stall owner added a dish',
    );

    return { id: item.id, name: item.name, pricePaise: item.base_price_paise };
  }

  @Patch('items/:itemId')
  async update(
    @Req() req: RequestWithStaff,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const { vendorId, actorId } = this.scope(req);
    const input = UpdateItem.parse(body);

    const before = await this.db
      .selectFrom('menu_item as mi')
      .innerJoin('menu as m', 'm.id', 'mi.menu_id')
      .where('mi.id', '=', itemId)
      .where('m.vendor_id', '=', vendorId)
      .select([
        'mi.id as id',
        'mi.menu_id as menu_id',
        'mi.name as name',
        'mi.base_price_paise as price',
        'mi.description as description',
        'mi.dietary_flags as dietary',
      ])
      .executeTakeFirst();

    // 404 either way — the caller must not learn an item exists in another
    // stall. PRD TENANT-01.
    if (!before) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such item.');

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.priceRupees !== undefined) {
      patch['base_price_paise'] = Math.round(input.priceRupees * 100);
    }
    if (input.taxRateBps !== undefined) patch['tax_rate_bps'] = input.taxRateBps;
    if (input.description !== undefined) {
      patch['description'] = input.description === null || input.description === '' ? null : input.description;
    }
    if (input.dietary !== undefined) {
      patch['dietary_flags'] = input.dietary === null ? [] : [input.dietary];
    }
    if (input.imageUrl !== undefined) patch['image_url'] = input.imageUrl;
    if (input.category !== undefined) {
      patch['menu_category_id'] = await this.categoryId(before.menu_id, input.category);
    }

    if (Object.keys(patch).length === 0) {
      return { id: before.id, name: before.name, pricePaise: before.price };
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('menu_item').set(patch).where('id', '=', itemId).execute();

      /**
       * A price change is audited with both numbers.
       *
       * `order_item` snapshots the price at placement, so an order already
       * taken is unaffected — but "why did this dish cost ₹180 last Tuesday and
       * ₹200 today" is a question a vendor will ask, and the answer has to be
       * somewhere other than a diff of the menu.
       */
      await this.audit.write(
        buildAuditEntry({
          action: 'menu.imported',
          entity: 'menu_item',
          entityId: itemId,
          vendorId,
          beforeValue: { name: before.name, pricePaise: before.price },
          afterValue: { via: 'vendor_single_item', ...patch },
        }),
        trx,
      );
    });

    log().info(
      {
        event: 'menu_item_updated',
        vendorId,
        itemId,
        actorId,
        priceChanged: patch['base_price_paise'] !== undefined,
      },
      'a stall owner edited a dish',
    );

    const after = await this.db
      .selectFrom('menu_item')
      .select(['id', 'name', 'base_price_paise as pricePaise'])
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();

    return after;
  }

  /**
   * Take a dish off the menu for good.
   *
   * `status = INACTIVE`, never a DELETE. `order_item` references the row, and
   * so does every stock history entry — removing it would turn "what did we
   * sell last month" into a dangling key. INACTIVE is also reversible, which a
   * delete is not, and "we stopped doing that dish" is a decision people
   * reverse constantly.
   *
   * DELETE as the HTTP verb because that is what it means to the caller. What
   * the database does about it is the database's business.
   */
  @Delete('items/:itemId')
  async discontinue(
    @Req() req: RequestWithStaff,
    @Param('itemId') itemId: string,
  ): Promise<unknown> {
    const { vendorId, actorId } = this.scope(req);

    const item = await this.db
      .selectFrom('menu_item as mi')
      .innerJoin('menu as m', 'm.id', 'mi.menu_id')
      .where('mi.id', '=', itemId)
      .where('m.vendor_id', '=', vendorId)
      .select(['mi.id as id', 'mi.name as name'])
      .executeTakeFirst();

    if (!item) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such item.');

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('menu_item')
        .set({ status: 'INACTIVE' })
        .where('id', '=', itemId)
        .execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'menu.imported',
          entity: 'menu_item',
          entityId: itemId,
          vendorId,
          beforeValue: { status: 'ACTIVE', name: item.name },
          afterValue: { via: 'vendor_single_item', status: 'INACTIVE' },
        }),
        trx,
      );
    });

    log().info(
      { event: 'menu_item_discontinued', vendorId, itemId, actorId },
      'a stall owner took a dish off the menu',
    );

    return { id: item.id, status: 'INACTIVE' };
  }
}
