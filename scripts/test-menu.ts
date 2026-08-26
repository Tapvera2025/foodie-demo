/**
 * Asserts that importing a vendor's menu twice is not the same as importing it
 * once, and that it is.
 *
 * The parser has unit tests. What those cannot see is the half that meets the
 * database: whether a re-import is a no-op, whether moving a dish between
 * categories updates it or replaces it, and whether the stall's own
 * availability survives a price change. All three are decided by an upsert key
 * and a set of columns the writer chooses not to touch, and all three are
 * invisible until something runs them against real rows.
 *
 * The category-move case is here because the first version got it wrong. The
 * key was scoped to the category, so a vendor reorganising their menu had every
 * dish reported as both created and discontinued — which would have orphaned
 * each item's stock row and pointed order history at a row marked INACTIVE.
 * A unit test would have agreed with the code.
 *
 *   npm run setup && npm run dev
 *   npm run test:menu
 */

import { readFileSync } from 'node:fs';
/**
 * `createPool`, not `new pg.Pool`.
 *
 * All three of these scripts were on the allowlist in `money-driver.test.ts`,
 * excused on the grounds that they only compare values rather than adding them.
 * The excuse was wrong, and `test-menu.ts` proved it on its first run:
 * `base_price_paise` came back as the STRING "3000" and every equality check
 * against a number failed. Reading a BIGINT without the int8 parser is the
 * §14.5 hazard whether or not you then do arithmetic on it.
 */
import { createPool } from '../src/platform/db.js';

const BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = createPool({ connectionString: url });

let failures = 0;
let checks = 0;
const expect = (name: string, actual: unknown, wanted: unknown): void => {
  checks++;
  if (actual === wanted) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}\n        got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  }
};

interface Plan {
  itemsCreated: string[];
  itemsUpdated: string[];
  itemsDiscontinued: string[];
  itemsReactivated: string[];
  priceChanges: { item: string }[];
}

async function main(): Promise<void> {
  /**
   * The console login, not a kitchen one.
   *
   * An earlier version granted `PLATFORM_OPS` to `spice.garden@example.com` so
   * it could import, and left it there. `actorTypeFor` picks the
   * most-privileged role a principal holds, so every subsequent order that
   * stall rejected was audited as PLATFORM_OPS — and `test-refund.ts` failed on
   * an assertion that had been correct an hour earlier. A test that permanently
   * changes who somebody is has effects outside itself.
   */
  const login = (await (
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ops@tapvera.example.com',
        password: 'kitchen-password-2026',
      }),
    })
  ).json()) as { token?: string };

  if (!login.token) {
    console.error('No console login. Run `npm run seed:dev` to create it.\n');
    process.exit(2);
  }
  const token = login.token;

  // A vendor the fixture menu has never been imported into.
  const { rows: vendors } = await pool.query<{ id: string }>(
    `SELECT id FROM vendor WHERE name = 'Tandoor Tales'`,
  );
  const vendorId = vendors[0]?.id;
  if (!vendorId) {
    console.error('Seeded vendor not found. Run `npm run seed:dev`.\n');
    process.exit(2);
  }

  const template = readFileSync('docs/menu_import_template.csv', 'utf8');

  const importCsv = async (csv: string, dryRun = false): Promise<Plan> => {
    const res = await fetch(
      `${API}/console/vendors/${vendorId}/menu/import${dryRun ? '?dryRun=true' : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ csv }),
      },
    );
    return (await res.json()) as Plan;
  };

  const statusOf = async (name: string): Promise<string | null> => {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT i.status FROM menu_item i JOIN menu m ON m.id = i.menu_id
        WHERE m.vendor_id = $1 AND i.name = $2 ORDER BY i.status LIMIT 1`,
      [vendorId, name],
    );
    return rows[0]?.status ?? null;
  };

  console.log('\nImporting the same file twice changes nothing the second time');
  await importCsv(template);
  const again = await importCsv(template);
  expect('nothing is created', again.itemsCreated.length, 0);
  expect('nothing is discontinued', again.itemsDiscontinued.length, 0);
  expect('no price moves', again.priceChanges.length, 0);

  console.log('\nA dry run reports the plan and writes none of it');
  const bumped = template.replace('Masala Chai,1,,30.00', 'Masala Chai,1,,35.00');
  const preview = await importCsv(bumped, true);
  expect('the preview sees the price change', preview.priceChanges.length, 1);
  const { rows: unchanged } = await pool.query<{ base_price_paise: number }>(
    `SELECT i.base_price_paise FROM menu_item i JOIN menu m ON m.id = i.menu_id
      WHERE m.vendor_id = $1 AND i.name = 'Masala Chai'`,
    [vendorId],
  );
  expect('and the database still has the old price', unchanged[0]?.base_price_paise, 3_000);

  console.log('\nMoving a dish to another category updates it rather than replacing it');
  const moved = template.replace(/^Breads,3,Butter Naan/m, 'Sides,3,Butter Naan');
  const afterMove = await importCsv(moved);
  expect('nothing is created', afterMove.itemsCreated.length, 0);
  expect('nothing is discontinued', afterMove.itemsDiscontinued.length, 0);
  expect('and it is still on sale', await statusOf('Butter Naan'), 'ACTIVE');

  console.log('\nRemoving a dish discontinues it — it is never deleted');
  const withoutNaan = moved
    .split('\n')
    .filter((l) => !l.includes('Butter Naan'))
    .join('\n');
  const afterRemoval = await importCsv(withoutNaan);
  expect('it is reported as discontinued', afterRemoval.itemsDiscontinued.length, 1);
  expect('the row survives, marked INACTIVE', await statusOf('Butter Naan'), 'INACTIVE');

  console.log('\nPutting it back is reported as a reactivation, not a new dish');
  const restored = await importCsv(moved);
  expect('reactivated', restored.itemsReactivated.length, 1);
  expect('not created', restored.itemsCreated.length, 0);

  console.log("\nA price change does not put a sold-out dish back on sale (§15)");
  await pool.query(
    `UPDATE menu_item SET availability = 'SOLD_OUT'
      WHERE name = 'Masala Chai' AND menu_id IN (SELECT id FROM menu WHERE vendor_id = $1)`,
    [vendorId],
  );
  await importCsv(bumped.replace(/^Breads,3,Butter Naan/m, 'Sides,3,Butter Naan'));
  const { rows: chai } = await pool.query<{ availability: string; base_price_paise: number }>(
    `SELECT i.availability, i.base_price_paise FROM menu_item i JOIN menu m ON m.id = i.menu_id
      WHERE m.vendor_id = $1 AND i.name = 'Masala Chai'`,
    [vendorId],
  );
  expect('the price was updated', chai[0]?.base_price_paise, 3_500);
  expect('and the stall still says sold out', chai[0]?.availability, 'SOLD_OUT');

  console.log('\nA bad spreadsheet is refused with line numbers, and writes nothing');
  const before = (await pool.query(`SELECT count(*) FROM menu_item i JOIN menu m ON m.id = i.menu_id WHERE m.vendor_id = $1`, [vendorId])).rows[0];
  const bad = await importCsv(
    'category,item_name,price_inr,tax_rate_pct\nStarters,Naan,1 80,5\nStarters,Samosa,40,notanumber\n',
  );
  expect('two problems are reported', (bad as unknown as { fields?: { problems: string } }).fields?.problems.split('\n').length, 2);
  const after = (await pool.query(`SELECT count(*) FROM menu_item i JOIN menu m ON m.id = i.menu_id WHERE m.vendor_id = $1`, [vendorId])).rows[0];
  expect('and nothing changed', JSON.stringify(after), JSON.stringify(before));

  console.log('\nThe import is audited');
  const { rows: audits } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE action = 'menu.imported' AND entity_id = $1`,
    [vendorId],
  );
  expect('every import left a row', Number(audits[0]!.n) > 0, true);

  await pool.end();
  console.log('');
  if (failures > 0) {
    console.error(`${failures} of ${checks} checks failed.\n`);
    process.exit(1);
  }
  console.log(`All ${checks} menu import checks passed.\n`);
}

void main().catch(async (e: unknown) => {
  await pool.end().catch(() => undefined);
  console.error(`\ntest-menu could not run: ${(e as Error).message}`);
  console.error('Is the API up?  npm run dev\n');
  process.exit(2);
});
