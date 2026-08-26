/**
 * The spreadsheet adapter: `docs/menu_import_template.csv` → `NormalisedMenu`.
 *
 * The first implementation of `MenuSourceAdapter`, and deliberately not the
 * only shape the importer knows about — a POS adapter is a second one, not a
 * second path through the writer.
 *
 * WHY MONEY IS PARSED WITH A REGEX AND NOT WITH `parseFloat`
 *
 * The float-precision argument is the weak one — `Math.round(x * 100)` absorbs
 * the 1e-13 error on any two-decimal amount, and would be fine. The real
 * hazard is that **`parseFloat` succeeds on a prefix instead of failing on
 * garbage**:
 *
 *     parseFloat('1,180.50') * 100  →     100   ₹1.00 for a ₹1,180.50 dish
 *     parseFloat('1 80')     * 100  →     100   one stray space, same result
 *     parseFloat('180.5.0')  * 100  →   18050   malformed, silently accepted
 *     parseFloat('180.005')  * 100  →   18001   three decimals, quietly rounded
 *
 * Thousands separators and stray spaces are what a typed spreadsheet is made
 * of, and every line above returns a number rather than an error. A menu
 * imported that way is wrong by a factor of a thousand and looks completely
 * ordinary — §2.2's failure mode whose symptom is silence, priced in rupees.
 *
 * So the shape is asserted by a regex first and read as two integers after.
 * Anything that does not match is refused by line number rather than
 * interpreted, and §14.5's rule — no floats anywhere near money — holds for
 * free rather than by care.
 *
 * WHY IT COLLECTS PROBLEMS INSTEAD OF THROWING
 *
 * A vendor's menu arrives as a spreadsheet somebody typed. It will have eleven
 * mistakes. Reporting the first one eleven times is eleven round trips with a
 * person who is doing you a favour.
 */

import { paise, type Paise } from '../platform/money.js';
import type { OptionChoice, OptionGroup } from './options.js';
import {
  MenuParseError,
  type DietaryFlag,
  type MenuSourceAdapter,
  type NormalisedCategory,
  type NormalisedItem,
  type NormalisedMenu,
} from './menu-source.js';

/**
 * RFC 4180 enough for a spreadsheet export.
 *
 * Handles quoted fields, embedded commas, embedded newlines and doubled quotes
 * — all four of which appear the moment a description says `Served with rice,
 * dal and a 6" naan`. Not a general CSV library, because pulling one in for
 * this would be a dependency in the path of every menu the platform ever
 * ingests, and this is forty lines.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // A BOM from Excel is invisible and turns the first header into "\ufeffcategory".
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Skip rows that are entirely empty — trailing newlines are universal.
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i]!;

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Rupees as written, to paise, without ever becoming a float.
 *
 * Accepts `180`, `180.5`, `180.50`, `1,180.50` and a leading `₹` or `Rs.`,
 * because all five turn up in spreadsheets people actually send.
 */
export function rupeesToPaise(raw: string): Paise {
  const cleaned = raw.trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/,/g, '');
  if (cleaned === '') throw new Error('price is blank');

  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`"${raw.trim()}" is not a rupee amount`);

  const rupees = Number.parseInt(m[1]!, 10);
  // `.5` means fifty paise, not five. Padding rather than parsing then scaling
  // keeps this in integers throughout.
  const paisePart = m[2] === undefined ? 0 : Number.parseInt(m[2].padEnd(2, '0'), 10);

  return paise(rupees * 100 + paisePart);
}

/** `5` or `5%` or `5.0` → basis points. Same no-float rule. */
export function percentToBps(raw: string): number {
  const cleaned = raw.trim().replace(/%$/, '');
  if (cleaned === '') throw new Error('tax rate is blank');

  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`"${raw.trim()}" is not a percentage`);

  const whole = Number.parseInt(m[1]!, 10);
  const frac = m[2] === undefined ? 0 : Number.parseInt(m[2].padEnd(2, '0'), 10);
  return whole * 100 + frac;
}

const DIETARY: Readonly<Record<string, DietaryFlag>> = {
  VEG: 'VEG',
  VEGETARIAN: 'VEG',
  NON_VEG: 'NON_VEG',
  NONVEG: 'NON_VEG',
  'NON-VEG': 'NON_VEG',
  EGG: 'EGG',
  EGGETARIAN: 'EGG',
  JAIN: 'JAIN',
};

const YES = new Set(['yes', 'y', 'true', '1', 'available']);
const NO = new Set(['no', 'n', 'false', '0', 'unavailable', 'sold out', 'sold_out']);

/** `Half:0|Full:90` → two priced choices. */
function parseOptions(raw: string, groupId: string): OptionChoice[] {
  return raw
    .split('|')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk, index) => {
      const at = chunk.lastIndexOf(':');
      if (at === -1) throw new Error(`option "${chunk}" needs a price, as "Name:0"`);
      const name = chunk.slice(0, at).trim();
      const price = chunk.slice(at + 1).trim();
      if (name === '') throw new Error(`option "${chunk}" needs a name`);
      return {
        id: `${groupId}-${index + 1}`,
        name,
        priceDeltaPaise: rupeesToPaise(price),
        isAvailable: true,
      };
    });
}

/** A slug an option group can be addressed by, stable across re-imports. */
function slug(...parts: string[]): string {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const REQUIRED_HEADERS = ['category', 'item_name', 'price_inr', 'tax_rate_pct'];

export class CsvMenuSource implements MenuSourceAdapter {
  readonly source = 'PLATFORM' as const;

  parse(raw: string): NormalisedMenu {
    const rows = parseCsv(raw);
    const problems: string[] = [];

    if (rows.length === 0) throw new MenuParseError(['the file is empty']);

    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (name: string): number => header.indexOf(name);

    for (const required of REQUIRED_HEADERS) {
      if (col(required) === -1) problems.push(`the header row is missing "${required}"`);
    }
    if (problems.length > 0) throw new MenuParseError(problems);

    const get = (row: string[], name: string): string => {
      const at = col(name);
      return at === -1 ? '' : (row[at] ?? '').trim();
    };

    /** Insertion-ordered, so a menu with no explicit order keeps the file's. */
    const categories = new Map<string, { sortOrder: number; items: NormalisedItem[] }>();

    rows.slice(1).forEach((row, index) => {
      // +2: one for the header, one because humans count from 1. A line number
      // that does not match what the vendor sees in Excel is worse than none.
      const line = index + 2;
      const at = (msg: string): string => `line ${line}: ${msg}`;

      const categoryName = get(row, 'category');
      const itemName = get(row, 'item_name');

      if (categoryName === '' && itemName === '') return; // blank row
      if (categoryName === '') problems.push(at('this item has no category'));
      if (itemName === '') problems.push(at('this row has no item name'));
      if (categoryName === '' || itemName === '') return;

      let pricePaise: Paise;
      try {
        pricePaise = rupeesToPaise(get(row, 'price_inr'));
      } catch (e) {
        problems.push(at(`${itemName}: ${(e as Error).message}`));
        return;
      }

      let taxRateBps: number;
      try {
        taxRateBps = percentToBps(get(row, 'tax_rate_pct'));
      } catch (e) {
        problems.push(at(`${itemName}: ${(e as Error).message}`));
        return;
      }

      const availableRaw = get(row, 'is_available').toLowerCase();
      let available = true;
      if (availableRaw !== '') {
        if (YES.has(availableRaw)) available = true;
        else if (NO.has(availableRaw)) available = false;
        else {
          // Not defaulted. "available?" is the difference between selling food
          // and selling food you do not have, and a typo should not decide it.
          problems.push(at(`${itemName}: is_available "${availableRaw}" is not yes or no`));
          return;
        }
      }

      const dietaryRaw = get(row, 'dietary');
      const dietaryFlags: DietaryFlag[] = [];
      for (const token of dietaryRaw.split(/[|,]/).map((d) => d.trim()).filter(Boolean)) {
        const flag = DIETARY[token.toUpperCase()];
        if (flag === undefined) {
          problems.push(at(`${itemName}: dietary "${token}" is not one of VEG, NON_VEG, EGG, JAIN`));
          return;
        }
        if (!dietaryFlags.includes(flag)) dietaryFlags.push(flag);
      }

      const groupsFor = (prefix: 'variant' | 'addon'): OptionGroup[] => {
        const name = get(row, `${prefix}_group`);
        const optionsRaw = get(row, `${prefix}_options`);
        if (name === '' && optionsRaw === '') return [];
        if (name === '' || optionsRaw === '') {
          problems.push(at(`${itemName}: ${prefix} group needs both a name and options`));
          return [];
        }

        const id = slug(itemName, prefix, name);
        let options: OptionChoice[];
        try {
          options = parseOptions(optionsRaw, id);
        } catch (e) {
          problems.push(at(`${itemName}: ${(e as Error).message}`));
          return [];
        }

        const min = get(row, `${prefix}_min`);
        const max = get(row, `${prefix}_max`);
        return [
          {
            id,
            name,
            // A variant defaults to exactly one required choice (a size must be
            // picked); an add-on defaults to none required and any number. Both
            // match how the template's own examples are filled in.
            minSelect: min === '' ? (prefix === 'variant' ? 1 : 0) : Number.parseInt(min, 10),
            maxSelect: max === '' ? (prefix === 'variant' ? 1 : options.length) : Number.parseInt(max, 10),
            options,
          },
        ];
      };

      const categoryOrderRaw = get(row, 'category_order');
      const existing = categories.get(categoryName);
      const bucket = existing ?? {
        sortOrder: categoryOrderRaw === '' ? categories.size + 1 : Number.parseInt(categoryOrderRaw, 10),
        items: [],
      };
      if (!existing) categories.set(categoryName, bucket);

      const itemOrderRaw = get(row, 'item_order');
      const externalId = get(row, 'external_item_id');
      const description = get(row, 'description');
      const image = get(row, 'image_filename');

      bucket.items.push({
        externalId: externalId === '' ? null : externalId,
        name: itemName,
        description: description === '' ? null : description,
        pricePaise,
        taxRateBps,
        dietaryFlags,
        available,
        sortOrder: itemOrderRaw === '' ? bucket.items.length + 1 : Number.parseInt(itemOrderRaw, 10),
        imageUrl: image === '' ? null : image,
        variantGroups: groupsFor('variant'),
        addonGroups: groupsFor('addon'),
      });
    });

    if (problems.length > 0) throw new MenuParseError(problems);

    const out: NormalisedCategory[] = [...categories.entries()]
      .map(([name, b]) => ({ name, sortOrder: b.sortOrder, items: b.items }))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return { categories: out };
  }
}
