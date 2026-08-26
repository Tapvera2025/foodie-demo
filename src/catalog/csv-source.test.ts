import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { CsvMenuSource, parseCsv, percentToBps, rupeesToPaise } from './csv-source.js';
import { assertMenuIsSane, MenuParseError } from './menu-source.js';

const source = new CsvMenuSource();

/**
 * The reason this file parses money with a regex.
 *
 * Each of these returns a plausible number from `parseFloat` and a wrong one.
 * They are the values a typed spreadsheet actually contains.
 */
describe('money is refused rather than misread', () => {
  it('reads ordinary rupee amounts exactly', () => {
    expect(rupeesToPaise('180.00')).toBe(18_000);
    expect(rupeesToPaise('19.99')).toBe(1_999);
    expect(rupeesToPaise('45')).toBe(4_500);
    // ".5" is fifty paise, not five. Padding, not scaling.
    expect(rupeesToPaise('180.5')).toBe(18_050);
    expect(rupeesToPaise('0')).toBe(0);
  });

  it('accepts the decorations a spreadsheet adds', () => {
    expect(rupeesToPaise('₹260')).toBe(26_000);
    expect(rupeesToPaise('Rs. 260')).toBe(26_000);
    expect(rupeesToPaise('1,180.50')).toBe(118_050);
  });

  it('REFUSES what parseFloat would have silently truncated', () => {
    // parseFloat('1 80') is 1. A ₹180 dish becomes ₹1.
    expect(() => rupeesToPaise('1 80')).toThrow();
    // parseFloat('180.5.0') is 180.5. Malformed input, plausible output.
    expect(() => rupeesToPaise('180.5.0')).toThrow();
    // Three decimals is not a rupee amount; rounding it hides a typo.
    expect(() => rupeesToPaise('180.005')).toThrow();
    expect(() => rupeesToPaise('free')).toThrow();
    expect(() => rupeesToPaise('')).toThrow();
    expect(() => rupeesToPaise('-5')).toThrow();
  });

  it('reads tax rates as basis points without a float', () => {
    expect(percentToBps('5')).toBe(500);
    expect(percentToBps('12%')).toBe(1_200);
    expect(percentToBps('18.5')).toBe(1_850);
    expect(() => percentToBps('five')).toThrow();
  });
});

describe('the CSV reader survives what spreadsheets emit', () => {
  it('handles quoted fields with commas and newlines', () => {
    const rows = parseCsv('a,b\n"one, two","line\nbreak"\n');
    expect(rows[1]).toEqual(['one, two', 'line\nbreak']);
  });

  it('handles doubled quotes', () => {
    expect(parseCsv('a\n"a 6"" naan"\n')[1]).toEqual(['a 6" naan']);
  });

  it('strips the BOM Excel writes', () => {
    // Without this the first header is "\ufeffcategory" and every lookup misses.
    // Written as an escape rather than the character: a literal BOM in the file
    // that explains BOMs is itself irregular whitespace, and lint says so.
    expect(parseCsv('\ufeffcategory,item_name\nStarters,Naan\n')[0]).toEqual([
      'category',
      'item_name',
    ]);
  });

  it('ignores trailing blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n\n').length).toBe(2);
  });
});

describe('the shipped template imports', () => {
  const raw = readFileSync('docs/menu_import_template.csv', 'utf8');
  const menu = source.parse(raw);

  it('parses and passes the shared sanity rules', () => {
    expect(() => assertMenuIsSane(menu)).not.toThrow();
  });

  it('produces the categories in the order the file asked for', () => {
    expect(menu.categories.map((c) => c.name)).toEqual([
      'Starters',
      'Main Course',
      'Breads',
      'Beverages',
    ]);
  });

  it('reads prices as exact paise', () => {
    const chai = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Masala Chai');
    expect(chai?.pricePaise).toBe(3_000);
  });

  it('reads a non-default tax rate rather than assuming 5%', () => {
    const soda = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Fresh Lime Soda');
    expect(soda?.taxRateBps).toBe(1_200);
  });

  it('carries "no" through as unavailable', () => {
    const soda = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Fresh Lime Soda');
    expect(soda?.available).toBe(false);
  });

  it('builds variant groups that default to exactly one required choice', () => {
    const chai = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Masala Chai');
    const size = chai?.variantGroups[0];
    expect(size?.name).toBe('Size');
    expect(size?.minSelect).toBe(1);
    expect(size?.maxSelect).toBe(1);
    expect(size?.options.map((o) => o.priceDeltaPaise)).toEqual([0, 1_500]);
  });

  it('builds add-on groups that default to optional', () => {
    const paneer = menu.categories
      .flatMap((c) => c.items)
      .find((i) => i.name === 'Paneer Butter Masala');
    expect(paneer?.addonGroups[0]?.minSelect).toBe(0);
    expect(paneer?.addonGroups[0]?.maxSelect).toBe(3);
  });

  it('gives every option a stable id, so a re-import is not a rename', () => {
    const chai = menu.categories.flatMap((c) => c.items).find((i) => i.name === 'Masala Chai');
    const again = source.parse(raw).categories.flatMap((c) => c.items).find((i) => i.name === 'Masala Chai');
    expect(chai?.variantGroups[0]?.options.map((o) => o.id)).toEqual(
      again?.variantGroups[0]?.options.map((o) => o.id),
    );
  });
});

describe('a bad menu comes back with every problem at once', () => {
  const bad = [
    'category,item_name,price_inr,tax_rate_pct,is_available,dietary',
    'Starters,Naan,not-a-price,5,yes,VEG',
    'Starters,Samosa,40,5,maybe,VEG',
    'Starters,Pakora,40,5,yes,MEAT',
    ',Orphan,40,5,yes,VEG',
  ].join('\n');

  it('reports all four rather than the first', () => {
    try {
      source.parse(bad);
      expect.unreachable('a menu with four problems parsed cleanly');
    } catch (e) {
      expect(e).toBeInstanceOf(MenuParseError);
      expect((e as MenuParseError).problems).toHaveLength(4);
    }
  });

  it('names the line number a human sees in the spreadsheet', () => {
    try {
      source.parse(bad);
    } catch (e) {
      // Line 2 is the first data row, because line 1 is the header.
      expect((e as MenuParseError).problems[0]).toMatch(/^line 2:/);
      expect((e as MenuParseError).problems[3]).toMatch(/^line 5:/);
    }
  });

  it('refuses a file with no header', () => {
    expect(() => source.parse('Starters,Naan,40\n')).toThrow(MenuParseError);
  });

  it('refuses two items with the same name anywhere in the menu', () => {
    // Menu-wide rather than per category: the upsert key for a source with no
    // ids is the name, so the same name twice is an ambiguous import.
    const dup = [
      'category,item_name,price_inr,tax_rate_pct',
      'Breads,Naan,40,5',
      'Sides,Naan,45,5',
    ].join('\n');
    expect(() => assertMenuIsSane(source.parse(dup))).toThrow(MenuParseError);
  });

  it('allows the same name twice when both carry an external id', () => {
    // A POS resolves the ambiguity itself; the platform should not insist on
    // renaming somebody's menu to suit a fallback it is not using.
    const ok = [
      'category,item_name,price_inr,tax_rate_pct,external_item_id',
      'Breads,Naan,40,5,POS-1',
      'Sides,Naan,45,5,POS-2',
    ].join('\n');
    expect(() => assertMenuIsSane(source.parse(ok))).not.toThrow();
  });

  it('refuses a duplicate external id, which would make the upsert a coin toss', () => {
    const dup = [
      'category,item_name,price_inr,tax_rate_pct,external_item_id',
      'Breads,Naan,40,5,POS-1',
      'Breads,Roti,20,5,POS-1',
    ].join('\n');
    expect(() => assertMenuIsSane(source.parse(dup))).toThrow(MenuParseError);
  });
});
