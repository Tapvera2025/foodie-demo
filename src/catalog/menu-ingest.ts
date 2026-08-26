/**
 * Writes a `NormalisedMenu` into the database. Source-agnostic, by design.
 *
 * This half knows nothing about CSV and will know nothing about a POS. §4:
 * `POS → POS Adapter → Normalised Menu → Platform`, never `POS → Platform`.
 * Two adapters, one writer, one schema — which is what makes replacing a POS
 * cost an adapter instead of a migration.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO
 *
 * 1. It never deletes an item. `order_item.menu_item_id` is `ON DELETE SET
 *    NULL`, so deleting a discontinued dish would quietly detach it from every
 *    order that ever contained it, and the order history would stop being able
 *    to say what was sold. An item missing from the file becomes `INACTIVE` —
 *    §6's distinction between discontinuing something and running out of it,
 *    which is exactly the pair of concepts this schema was reshaped to keep
 *    apart in migration 20260817000008.
 *
 * 2. It never overwrites `availability` on an item that already exists. The
 *    spreadsheet's `is_available` column is what the vendor believed when they
 *    typed it; `availability` is what the stall says right now, and §15 names
 *    the vendor as the authority on that "as of last update". A price update
 *    re-imported at 3pm must not put this morning's sold-out biryani back on
 *    sale — the customer orders it and the kitchen cannot make it.
 *
 * 3. It never touches stock. `menu_item_stock` is today's count, owned by the
 *    kitchen, and a menu import is not a statement about it.
 *
 * All three are the same rule: a menu import describes the CATALOGUE, not the
 * state of the kitchen.
 */

import type { Transaction } from 'kysely';

import { AppError } from '../platform/errors.js';
import type { Database, Json } from '../platform/schema.js';
import type { MenuSource, NormalisedMenu } from './menu-source.js';
import { assertMenuIsSane } from './menu-source.js';

/** node-pg turns a JS object into a Postgres value, not JSON. JSONB needs text. */
const toJsonb = (v: unknown): Json => JSON.stringify(v) as unknown as Json;

export interface ImportPlan {
  readonly categoriesCreated: number;
  readonly itemsCreated: readonly string[];
  readonly itemsUpdated: readonly string[];
  /** Present in the database, absent from the file. Marked INACTIVE, not deleted. */
  readonly itemsDiscontinued: readonly string[];
  /** Already INACTIVE and back in the file. Worth surfacing — it is a resurrection. */
  readonly itemsReactivated: readonly string[];
  readonly priceChanges: readonly { item: string; fromPaise: number; toPaise: number }[];
}

const EMPTY_PLAN: ImportPlan = {
  categoriesCreated: 0,
  itemsCreated: [],
  itemsUpdated: [],
  itemsDiscontinued: [],
  itemsReactivated: [],
  priceChanges: [],
};

/**
 * The upsert key.
 *
 * A source with its own ids uses them, which is what makes a POS rename an
 * update rather than a duplicate — the entire point of `external_item_id` and
 * of the UNIQUE (menu_id, external_item_id) index that has been sitting unused
 * on the table since the first migration.
 *
 * A spreadsheet usually has none, so the fallback is the name, scoped to the
 * MENU rather than to the category.
 *
 * The first version scoped it to the category and the first real import showed
 * why that is wrong: the seeded menu had "Butter Naan" under "North Indian" and
 * the template has it under "Breads", so the plan reported the same dish as
 * both created and discontinued. A vendor reorganising their categories is
 * ordinary — far more ordinary than two different dishes sharing a name — and
 * it should move an item, not replace it. Replacing it would orphan the item's
 * stock row and point every historical order at a row marked INACTIVE.
 *
 * The cost is that a menu genuinely containing the same name twice is now
 * ambiguous, which `assertMenuIsSane` refuses outright rather than resolving
 * by guessing.
 */
function keyOf(item: { externalId: string | null; name: string }): string {
  return item.externalId !== null
    ? `ext:${item.externalId}`
    : `name:${item.name.trim().toLowerCase()}`;
}

export interface ImportOptions {
  /** Compute the plan and roll back. Nothing is written. */
  readonly dryRun?: boolean;
  readonly source?: MenuSource;
  readonly sourceVersion?: string;
}

/**
 * Apply a menu to a vendor, inside a caller-supplied transaction.
 *
 * The transaction is the caller's so the audit row commits with the import. A
 * menu that changed and an audit log that says it did not is worse than
 * neither.
 */
export async function applyMenu(
  trx: Transaction<Database>,
  vendorId: string,
  menu: NormalisedMenu,
  opts: ImportOptions = {},
): Promise<ImportPlan> {
  assertMenuIsSane(menu);

  const vendor = await trx
    .selectFrom('vendor')
    .select(['id', 'name'])
    .where('id', '=', vendorId)
    .executeTakeFirst();
  if (!vendor) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such vendor');

  // One menu per vendor — `menu_vendor_uq`. Created on first import.
  const existingMenu = await trx
    .selectFrom('menu')
    .select(['id'])
    .where('vendor_id', '=', vendorId)
    .executeTakeFirst();

  const menuRow =
    existingMenu ??
    (await trx
      .insertInto('menu')
      .values({ vendor_id: vendorId, source_type: opts.source ?? 'PLATFORM' })
      .returning(['id'])
      .executeTakeFirstOrThrow());

  await trx
    .updateTable('menu')
    .set({
      source_type: opts.source ?? 'PLATFORM',
      ...(opts.sourceVersion !== undefined ? { source_version: opts.sourceVersion } : {}),
      synced_at: new Date(),
      is_stale: false,
    })
    .where('id', '=', menuRow.id)
    .execute();

  // ---------------------------------------------------------------- categories
  const existingCategories = await trx
    .selectFrom('menu_category')
    .select(['id', 'name'])
    .where('menu_id', '=', menuRow.id)
    .execute();

  const categoryByName = new Map(existingCategories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  let categoriesCreated = 0;

  for (const category of menu.categories) {
    const key = category.name.trim().toLowerCase();
    const found = categoryByName.get(key);
    if (found) {
      await trx
        .updateTable('menu_category')
        .set({ sort_order: category.sortOrder })
        .where('id', '=', found)
        .execute();
      continue;
    }
    const created = await trx
      .insertInto('menu_category')
      .values({ menu_id: menuRow.id, name: category.name, sort_order: category.sortOrder })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    categoryByName.set(key, created.id);
    categoriesCreated++;
  }

  // --------------------------------------------------------------------- items
  const existingItems = await trx
    .selectFrom('menu_item')
    .innerJoin('menu_category', 'menu_category.id', 'menu_item.menu_category_id')
    .select([
      'menu_item.id as id',
      'menu_item.name as name',
      'menu_item.external_item_id as externalId',
      'menu_item.base_price_paise as pricePaise',
      'menu_item.status as status',
      'menu_category.name as categoryName',
    ])
    .where('menu_item.menu_id', '=', menuRow.id)
    .execute();

  const byKey = new Map(
    existingItems.map((i) => [keyOf({ externalId: i.externalId, name: i.name }), i]),
  );

  const itemsCreated: string[] = [];
  const itemsUpdated: string[] = [];
  const itemsReactivated: string[] = [];
  const priceChanges: { item: string; fromPaise: number; toPaise: number }[] = [];
  const seen = new Set<string>();

  for (const category of menu.categories) {
    const categoryId = categoryByName.get(category.name.trim().toLowerCase())!;

    for (const item of category.items) {
      const key = keyOf(item);
      seen.add(key);
      const found = byKey.get(key);

      const shared = {
        menu_category_id: categoryId,
        external_item_id: item.externalId,
        name: item.name,
        description: item.description,
        base_price_paise: item.pricePaise,
        tax_rate_bps: item.taxRateBps,
        dietary_flags: [...item.dietaryFlags],
        image_url: item.imageUrl,
        sort_order: item.sortOrder,
        variant_groups: toJsonb(item.variantGroups),
        addon_groups: toJsonb(item.addonGroups),
      };

      if (!found) {
        await trx
          .insertInto('menu_item')
          .values({
            ...shared,
            menu_id: menuRow.id,
            status: 'ACTIVE',
            // Only on INSERT. See the note at the top of this file: on an
            // update the stall's own availability wins over the spreadsheet's.
            availability: item.available ? 'AVAILABLE' : 'TEMPORARILY_UNAVAILABLE',
          })
          .execute();
        itemsCreated.push(item.name);
        continue;
      }

      if (found.pricePaise !== item.pricePaise) {
        priceChanges.push({ item: item.name, fromPaise: found.pricePaise, toPaise: item.pricePaise });
      }
      if (found.status === 'INACTIVE') itemsReactivated.push(item.name);

      await trx
        .updateTable('menu_item')
        .set({ ...shared, status: 'ACTIVE' })
        .where('id', '=', found.id)
        .execute();
      itemsUpdated.push(item.name);
    }
  }

  // ------------------------------------------------------------- discontinued
  const gone = existingItems.filter(
    (i) =>
      i.status === 'ACTIVE' &&
      !seen.has(keyOf({ externalId: i.externalId, name: i.name })),
  );

  for (const item of gone) {
    await trx
      .updateTable('menu_item')
      .set({
        status: 'INACTIVE',
        // Availability is cleared to AVAILABLE deliberately: an INACTIVE item
        // is off the menu entirely, and leaving it SOLD_OUT would say two
        // things at once. The CHECK constraint
        // `menu_item_available_from_matches_availability` also requires
        // available_from to be null for AVAILABLE, so this is the consistent
        // resting state for something that is simply not on sale.
        availability: 'AVAILABLE',
        available_from: null,
      })
      .where('id', '=', item.id)
      .execute();
  }

  const plan: ImportPlan = {
    categoriesCreated,
    itemsCreated,
    itemsUpdated,
    itemsDiscontinued: gone.map((i) => i.name),
    itemsReactivated,
    priceChanges,
  };

  if (opts.dryRun) {
    /**
     * A dry run does the whole write and then refuses to keep it.
     *
     * Simulating the work instead would mean a second implementation of the
     * upsert whose only job is to predict the first — and the two would
     * disagree eventually, on the day somebody trusted the preview. Rolling
     * back the real thing is the only preview that cannot lie.
     */
    throw new DryRun(plan);
  }

  return plan;
}

/** Carries the plan out through the transaction rollback. Not an error. */
export class DryRun extends Error {
  constructor(readonly plan: ImportPlan) {
    super('dry run');
    this.name = 'DryRun';
  }
}

export { EMPTY_PLAN };
