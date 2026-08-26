/**
 * The normalised menu, and the port every source produces one through.
 *
 * WHY A PORT RATHER THAN A CSV PARSER
 *
 * There will be two sources of menus and they arrive at different times. Today
 * it is a spreadsheet, because the platform is sold direct to vendors and
 * digitising their menu is the platform's own onboarding cost — §19.2 calls it
 * the most underestimated task in the plan, and selling direct means paying it
 * once per vendor, forever. Later it is a POS.
 *
 * §4 states the rule this file exists to make true:
 *
 *     POS → POS Adapter → Normalised Menu + Inventory → Platform
 *
 * never `POS → Platform`. And §19.3: "the internal normalised model is
 * specified now; `external_item_id` already exists as the seam. The adapter
 * waits for a POS." That seam is real — `menu_item` has the column and a
 * UNIQUE (menu_id, external_item_id) index on it — but nothing had ever been
 * written against it, so it was a seam in the schema and not in the code.
 *
 * So: `NormalisedMenu` is the contract. `csv-source.ts` produces one. A POS
 * adapter will produce one. `menu-ingest.ts` consumes one and knows about
 * neither. A POS that dictated the internal shape would be one we cannot
 * replace, and swapping a provider must cost an adapter rather than a schema.
 *
 * PURE. No I/O — the whole point is that a source can be tested by handing it
 * bytes and reading the result, without a database in the room.
 */

import { AppError } from '../platform/errors.js';
import type { Paise } from '../platform/money.js';
import { assertValidGroupDefinition, type OptionGroup } from './options.js';

export type DietaryFlag = 'VEG' | 'NON_VEG' | 'EGG' | 'JAIN';

export interface NormalisedItem {
  /**
   * The source's own id, and the upsert key.
   *
   * Null for a spreadsheet that does not carry one, in which case the item is
   * matched by name within its category. A POS always has one, and once it
   * does, renaming an item in the POS updates it here rather than creating a
   * second one — which is the entire reason the column exists.
   */
  readonly externalId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly pricePaise: Paise;
  readonly taxRateBps: number;
  readonly dietaryFlags: readonly DietaryFlag[];
  readonly available: boolean;
  readonly sortOrder: number;
  readonly imageUrl: string | null;
  readonly variantGroups: readonly OptionGroup[];
  readonly addonGroups: readonly OptionGroup[];
}

export interface NormalisedCategory {
  readonly name: string;
  readonly sortOrder: number;
  readonly items: readonly NormalisedItem[];
}

export interface NormalisedMenu {
  readonly categories: readonly NormalisedCategory[];
}

/** Where a menu came from. Mirrors the `menu_source_type` enum. */
export type MenuSource = 'PLATFORM' | 'POS_PETPOOJA' | 'POS_OTHER';

/**
 * A source turns whatever it has into the model above.
 *
 * `parse` is synchronous and pure on purpose: a source that reaches the network
 * is one that cannot be tested without mocking it, and a POS adapter should
 * fetch first and parse second rather than blending the two.
 */
export interface MenuSourceAdapter {
  readonly source: MenuSource;
  parse(raw: string): NormalisedMenu;
}

/**
 * Everything wrong with a menu, at once.
 *
 * A parser that throws on the first bad row makes somebody fix eleven typos in
 * eleven round trips. A vendor's spreadsheet with eleven problems should come
 * back with eleven line numbers.
 */
export class MenuParseError extends AppError {
  constructor(readonly problems: readonly string[]) {
    super(
      'MENU_IMPORT_INVALID',
      `This menu could not be read (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
      { problems: problems.slice(0, 50).join('\n') },
    );
    this.name = 'MenuParseError';
  }
}

/**
 * Checks that hold for every source, applied after parsing and before writing.
 *
 * Kept here rather than in each adapter so a POS cannot arrive with a laxer
 * idea of what a menu is. `assertValidGroupDefinition` has existed since week
 * five with a comment saying it validates "at menu import time"; this is the
 * import time it was written for.
 */
export function assertMenuIsSane(menu: NormalisedMenu): void {
  const problems: string[] = [];

  if (menu.categories.length === 0) problems.push('the menu has no categories');

  const seenExternal = new Set<string>();
  /**
   * Menu-wide, not per category, because that is the scope the upsert key uses
   * when a source has no ids of its own. Two dishes called the same thing in
   * different categories would make an import ambiguous — and the ambiguity
   * would show up as one of them silently overwriting the other.
   */
  const seenName = new Map<string, string>();

  for (const category of menu.categories) {
    if (category.items.length === 0) {
      problems.push(`category "${category.name}" has no items`);
    }

    for (const item of category.items) {
      const where = `"${category.name}" / "${item.name}"`;

      if (item.name.trim() === '') problems.push(`${where}: an item needs a name`);

      const key = item.name.trim().toLowerCase();
      const firstSeenIn = seenName.get(key);
      if (firstSeenIn !== undefined && item.externalId === null) {
        problems.push(
          `${where}: an item with this name is already in "${firstSeenIn}". ` +
            'Rename one, or give both an external_item_id.',
        );
      }
      seenName.set(key, category.name);

      /**
       * A duplicate external id would make the upsert non-deterministic: two
       * rows claim the same key and whichever is written last wins, silently.
       * The database's UNIQUE index would also refuse it, but by then half the
       * menu is already in and the vendor is looking at a partial one.
       */
      if (item.externalId !== null) {
        if (seenExternal.has(item.externalId)) {
          problems.push(`${where}: external id "${item.externalId}" is used more than once`);
        }
        seenExternal.add(item.externalId);
      }

      // Zero is legal — a free side, a complimentary chutney. Negative is not.
      if (item.pricePaise < 0) problems.push(`${where}: price cannot be negative`);
      if (item.taxRateBps < 0 || item.taxRateBps > 10_000) {
        problems.push(`${where}: tax rate must be between 0% and 100%`);
      }

      for (const group of [...item.variantGroups, ...item.addonGroups]) {
        try {
          assertValidGroupDefinition(group);
        } catch (e) {
          problems.push(`${where}: option group "${group.name}" — ${(e as Error).message}`);
        }
      }
    }
  }

  if (problems.length > 0) throw new MenuParseError(problems);
}
