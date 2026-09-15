/**
 * Seeds one food court you can actually order from.
 *
 *   npm run seed:dev
 *
 * Unlike `demo:order`, this COMMITS — the point is to leave something behind
 * for the PWA to talk to. It is idempotent: re-running updates the same rows
 * rather than creating a second Phoenix Marketcity.
 *
 * It deliberately touches no append-only table. Nothing here writes a ledger
 * entry or an order, so everything it creates can be changed or removed later.
 */

import { randomBytes } from 'node:crypto';

import { DEFAULT_PWA_BASE_URL } from '../src/platform/config.js';
import { createDb, createPool } from '../src/platform/db.js';
import { generateQrToken } from '../src/tenancy/qr.js';
import { hashPassword } from '../src/identity/password.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const COURT = 'Phoenix Marketcity — Level 3';

const MENU: Record<string, [string, number, string][]> = {
  'Indo-Chinese': [
    ['Veg Manchurian', 18_000, 'Crisp cabbage dumplings in a garlic-chilli gravy'],
    ['Hakka Noodles', 14_000, 'Wok-tossed with julienned vegetables'],
    ['Chilli Paneer', 21_000, 'Dry, with capsicum and spring onion'],
  ],
  'North Indian': [
    ['Dal Makhani', 19_000, 'Slow-cooked overnight, finished with cream'],
    ['Paneer Butter Masala', 24_000, 'Rich tomato and cashew gravy'],
    ['Butter Naan', 6_000, 'Two pieces'],
  ],
  Beverages: [
    ['Masala Chai', 4_000, ''],
    ['Sweet Lime Soda', 7_000, 'Salted or sweet'],
  ],
};

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: url! }));

  // Look-then-insert rather than ON CONFLICT: food_court.name has no unique
  // index, so there is no conflict target to name.
  const court =
    (await db.selectFrom('food_court').selectAll().where('name', '=', COURT).executeTakeFirst()) ??
    (await db
      .insertInto('food_court')
      .values({ name: COURT, city: 'Ahmedabad', status: 'ACTIVE' })
      .returningAll()
      .executeTakeFirstOrThrow());

  // Fee rules. Config, not code — PRD PAY-MODE-01.
  const existingRules = await db
    .selectFrom('fee_rule')
    .select('id')
    .where('food_court_id', '=', court.id)
    .execute();

  if (existingRules.length === 0) {
    await db
      .insertInto('fee_rule')
      .values([
        // FOOD_COURT, not PLATFORM_DEFAULT. The CHECK constraint
        // `fee_rule_scope_target` requires PLATFORM_DEFAULT rules to have a
        // NULL food_court_id, and it is right to: a "platform default" scoped
        // to one court is a contradiction, and the two would then disagree
        // about which rule is more specific. The ₹5 convenience fee is
        // negotiated per court anyway, so FOOD_COURT is also the truthful
        // scope.
        {
          scope: 'FOOD_COURT',
          party: 'CUSTOMER',
          fee_type: 'FLAT_PER_ORDER',
          amount_paise: 500,
          tax_rate_bps: 1800,
          allowed_modes: ['PLATFORM_COLLECT'],
          food_court_id: court.id,
        },
        {
          scope: 'FOOD_COURT',
          party: 'VENDOR',
          fee_type: 'PERCENTAGE',
          rate_bps: 300,
          tax_rate_bps: 1800,
          allowed_modes: ['PLATFORM_COLLECT', 'VENDOR_DIRECT'],
          food_court_id: court.id,
        },
        // No OPERATOR rule. Two parties split an order — the vendor and the
        // platform — and migration 20260818000010 makes a third impossible at
        // the database. §14.1's flexibility is unaffected: charge the vendor,
        // the customer, both, or neither, per court and per stall.
      ])
      .execute();
  }

  // One QR token for the whole court. Printed on posters and stall fronts;
  // there is deliberately no per-table code — see migration 20260812000003.
  let token = court.qr_token;
  if (!token) {
    token = generateQrToken(randomBytes);
    await db.updateTable('food_court').set({ qr_token: token }).where('id', '=', court.id).execute();
  }

  const vendorSpecs = [
    { name: 'Spice Garden', cuisine: ['Indo-Chinese', 'North Indian'], prep: 12 },
    { name: 'Wok This Way', cuisine: ['Indo-Chinese'], prep: 9 },
    { name: 'Tandoor Tales', cuisine: ['North Indian'], prep: 18 },
  ];

  for (const spec of vendorSpecs) {
    let vendor = await db
      .selectFrom('vendor')
      .selectAll()
      .where('food_court_id', '=', court.id)
      .where('name', '=', spec.name)
      .executeTakeFirst();

    vendor ??= await db
      .insertInto('vendor')
      .values({
        food_court_id: court.id,
        name: spec.name,
        cuisine: spec.cuisine,
        status: 'ACTIVE',
        settlement_mode: 'PLATFORM_COLLECT',
        provider_linked_account_id: `acc_${spec.name.toLowerCase().replace(/\W+/g, '_')}`,
        estimated_prep_minutes: spec.prep,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let menu = await db
      .selectFrom('menu')
      .selectAll()
      .where('vendor_id', '=', vendor.id)
      .executeTakeFirst();

    menu ??= await db
      .insertInto('menu')
      .values({ vendor_id: vendor.id })
      .returningAll()
      .executeTakeFirstOrThrow();

    let sort = 0;
    for (const [categoryName, items] of Object.entries(MENU)) {
      if (!spec.cuisine.includes(categoryName) && categoryName !== 'Beverages') continue;

      let category = await db
        .selectFrom('menu_category')
        .selectAll()
        .where('menu_id', '=', menu.id)
        .where('name', '=', categoryName)
        .executeTakeFirst();

      category ??= await db
        .insertInto('menu_category')
        .values({ menu_id: menu.id, name: categoryName, sort_order: sort })
        .returningAll()
        .executeTakeFirstOrThrow();
      sort += 1;

      for (const [name, price, description] of items) {
        const exists = await db
          .selectFrom('menu_item')
          .select('id')
          .where('menu_id', '=', menu.id)
          .where('name', '=', name)
          .executeTakeFirst();
        if (exists) continue;

        await db
          .insertInto('menu_item')
          .values({
            menu_id: menu.id,
            menu_category_id: category.id,
            name,
            description: description || null,
            base_price_paise: price,
            tax_rate_bps: 500,
            // PRD §6 — three separate concepts, and the seed says all three
            // rather than leaning on defaults, so a schema change that flips a
            // default cannot silently change what the seed means.
            status: 'ACTIVE',
            availability: 'AVAILABLE',
            inventory_mode: 'UNTRACKED',
          })
          .execute();
      }
    }
  }

  // A kitchen login per stall. Per-user accounts, but for a dev seed one user
  // per vendor is enough to exercise the scoping: each can only see their own
  // queue, which is the property worth being able to check by hand.
  const password = 'kitchen-password-2026';
  const staff: { email: string; vendor: string; role: string }[] = [];

  /**
   * TWO ACCOUNTS PER STALL, AND THE DIFFERENCE IS THE POINT.
   *
   * The seed made one `VENDOR_OPERATOR` per stall, which meant the owner-only
   * half of the board was unreachable from a fresh database — every seeded
   * login saw availability and stock and no way to add a dish or change a
   * price. The permission split was real, enforced, and impossible to observe.
   *
   * A rule you cannot watch working is one nobody trusts. So both roles exist
   * out of the box:
   *
   *   *.owner@example.com    VENDOR_OWNER      board + menu editing + prices
   *   *.cook@example.com     VENDOR_OPERATOR   board + availability + stock
   *
   * Signing in as each is the fastest way to check that `menu.write` is doing
   * what the matrix says.
   */
  const ROLES = [
    { suffix: 'owner', role: 'VENDOR_OWNER' as const, title: 'Owner' },
    { suffix: 'cook', role: 'VENDOR_OPERATOR' as const, title: 'Kitchen' },
  ];

  for (const spec of vendorSpecs) {
    const vendor = await db
      .selectFrom('vendor')
      .select('id')
      .where('food_court_id', '=', court.id)
      .where('name', '=', spec.name)
      .executeTakeFirstOrThrow();

    const slug = spec.name.toLowerCase().replace(/\W+/g, '.');

    for (const r of ROLES) {
      const email = `${slug}.${r.suffix}@example.com`;

      let user = await db
        .selectFrom('platform_user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();

      if (!user) {
        user = await db
          .insertInto('platform_user')
          .values({
            email,
            display_name: `${spec.name} ${r.title}`,
            password_hash: await hashPassword(password),
            status: 'ACTIVE',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await db
          .insertInto('user_role_assignment')
          .values({
            user_id: user.id,
            role: r.role,
            food_court_id: court.id,
            vendor_id: vendor.id,
            status: 'ACTIVE',
          })
          .execute();
      }
      staff.push({ email, vendor: spec.name, role: r.role });
    }
  }

  /**
   * The console login — you.
   *
   * The seed made three kitchen accounts and no platform account, which was
   * right when the product was sold to a venue with its own manager. Selling
   * direct to vendors makes the platform the only administrator there is, and
   * onboarding a stall was still a hand-written INSERT.
   *
   * THREE ROLES, NOT ONE.
   *
   * `SUPER_ADMIN` holds exactly one of the thirty-one permissions in the
   * matrix — `tenant.manage`. That is deliberate rather than an oversight: a
   * super admin can create tenants and cannot silently reprice a menu or move
   * money. Keeping those separate is worth almost nothing today and a great
   * deal on the first day somebody else has a login, so the seed assigns all
   * three rather than making one of them omnipotent. `user_role_assignment`
   * and the token's `rol` claim are both plural precisely for this.
   */
  const consoleEmail = 'ops@tapvera.example.com';
  let consoleUser = await db
    .selectFrom('platform_user')
    .select('id')
    .where('email', '=', consoleEmail)
    .executeTakeFirst();

  if (!consoleUser) {
    consoleUser = await db
      .insertInto('platform_user')
      .values({
        email: consoleEmail,
        display_name: 'Platform Console',
        password_hash: await hashPassword(password),
        status: 'ACTIVE',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('user_role_assignment')
      .values(
        (['SUPER_ADMIN', 'PLATFORM_OPS', 'PLATFORM_FINANCE'] as const).map((role) => ({
          user_id: consoleUser!.id,
          role,
          status: 'ACTIVE' as const,
        })),
      )
      .execute();
  }

  // The default is shared with ConfigSchema rather than repeated, so the link
  // printed here cannot drift from the one an issued QR encodes.
  const base = process.env.PWA_BASE_URL ?? DEFAULT_PWA_BASE_URL;
  console.log(`\n  ${COURT}`);
  console.log(`  ${vendorSpecs.length} vendors\n`);
  console.log('  Scan URL — open it in a browser to start a session:\n');
  console.log(`    ${base}/t/${token}\n`);
  console.log('  Kitchen logins (http://localhost:5174):\n');
  for (const s2 of staff) {
    // The role is printed because it decides what the board shows: an owner
    // gets the menu editing controls, a cook does not.
    const what = s2.role === 'VENDOR_OWNER' ? 'owner — can edit the menu' : 'cook — availability only';
    console.log(`    ${s2.email.padEnd(34)} ${s2.vendor.padEnd(16)} ${what}`);
  }
  console.log(`\n  Platform console (http://localhost:5175):\n`);
  console.log(`    ${consoleEmail.padEnd(28)} SUPER_ADMIN + PLATFORM_OPS + PLATFORM_FINANCE`);
  console.log(`\n    Three roles on one login. SUPER_ADMIN alone holds only`);
  console.log(`    tenant.manage, so it can create a court and not a stall.`);
  console.log(`\n    password for all: ${password}\n`);

  await db.destroy();
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
