/**
 * ============================================================================
 * IS THERE A PHOTO TO SHOW, OR IS THE SCREEN RIGHT TO DRAW A GRADIENT?
 * ============================================================================
 *
 *   npm run diagnose:images
 *
 * THE SYMPTOM THIS EXISTS FOR
 *
 *   "it's not fetching the product or store image"
 *
 * That sentence has two completely different causes and they look identical on
 * screen:
 *
 *   A. the client never asks for it     -> a code fix
 *   B. nothing has been uploaded        -> a data problem, and no code change
 *                                          will make a picture appear
 *
 * (A) was real: the order API returned `{name, quantity, lineTotalPaise}` and
 * nothing else, so the pay screen could only ever draw `FoodTile`'s gradient.
 * That is fixed — `menu_item.image_url` and `vendor.cover_image_url` are now
 * joined onto the order.
 *
 * But fixing (A) changes NOTHING VISIBLE if (B) is also true, and the two are
 * indistinguishable from the customer's side: a dish with no photo and a dish
 * whose photo was never requested both render the same coloured square. So
 * this counts the rows. It reads only; it writes nothing.
 *
 * WHAT THE ANSWER MEANS
 *
 *   items with an image = 0   -> upload one from the kitchen board (Menu -> a
 *                                dish -> its photo) and the pay screen will
 *                                show it immediately. Nothing else is wrong.
 *   items with an image > 0   -> the join is doing its job; if a specific dish
 *                                still shows a gradient, the last table below
 *                                names which line it is and why.
 */

import { sql } from 'kysely';

/*
 * THROUGH `createPool`/`createDb`, NOT A HAND-BUILT Kysely.
 *
 * `platform/db.ts` registers a node-pg type parser for INT8 as an IMPORT SIDE
 * EFFECT, because Postgres returns BIGINT as a string and every monetary column
 * in this schema is BIGINT paise. A script that assembles its own Pool skips
 * that registration and gets `"19900"` where the application gets `19900`.
 *
 * That is not cosmetic. `paise()` refuses a non-number by design, so the first
 * money value a script touched threw `money must be a number, got 19900` — and
 * it read as a bug in the money it was reporting on rather than in the
 * reporting. A diagnostic that fails differently from the application is worse
 * than no diagnostic, which is the same lesson `diagnose-cashfree.ts` learned
 * when it hand-built the payment provider.
 */
import { createDb, createPool } from '../src/platform/db.js';
import { config } from '../src/platform/config.js';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const step = (s: string): void => {
  process.stdout.write(`\n${BOLD}==> ${s}${OFF}\n`);
};
const line = (s: string): void => {
  process.stdout.write(`    ${s}\n`);
};
const dim = (s: string): void => {
  process.stdout.write(`    ${DIM}${s}${OFF}\n`);
};

async function main(): Promise<void> {
  const db = createDb(createPool({ connectionString: config().DATABASE_URL }));

  try {
    // -----------------------------------------------------------------------
    step('Stall cover photos — the disc on "Collecting from"');
    // -----------------------------------------------------------------------
    const vendors = await db
      .selectFrom('vendor')
      .select(['name', 'cover_image_url'])
      .where('status', '=', 'ACTIVE')
      .orderBy('name')
      .execute();

    const withCover = vendors.filter((v) => v.cover_image_url);
    line(`${withCover.length} of ${vendors.length} active stalls have a cover photo`);
    dim('');
    for (const v of vendors) {
      const mark = v.cover_image_url ? `${GREEN}yes${OFF}` : `${YELLOW}none${OFF}`;
      dim(`${v.name.slice(0, 26).padEnd(28)} ${mark}`);
    }
    if (withCover.length === 0) {
      dim('');
      dim('Every stall falls back to the awning icon. That is the screen behaving');
      dim('correctly, not a bug — upload a cover from the kitchen board.');
    }

    // -----------------------------------------------------------------------
    step('Dish photos — the tiles in the order summary');
    // -----------------------------------------------------------------------
    const items = await sql<{ vendor: string; total: string; withimage: string }>`
      SELECT v.name                                            AS vendor,
             COUNT(*)                                          AS total,
             COUNT(mi.image_url)                               AS withimage
        FROM menu_item mi
        JOIN vendor v ON v.id = mi.vendor_id
       GROUP BY v.name
       ORDER BY v.name
    `.execute(db);

    let totalItems = 0;
    let totalWith = 0;
    for (const r of items.rows) {
      totalItems += Number(r.total);
      totalWith += Number(r.withimage);
    }
    line(`${totalWith} of ${totalItems} menu items have an image`);
    dim('');
    for (const r of items.rows) {
      const n = Number(r.withimage);
      const t = Number(r.total);
      const mark = n === 0 ? `${YELLOW}0${OFF}` : `${GREEN}${n}${OFF}`;
      dim(`${r.vendor.slice(0, 26).padEnd(28)} ${mark} of ${t}`);
    }

    // -----------------------------------------------------------------------
    step('The most recent order, line by line — what the pay screen will draw');
    // -----------------------------------------------------------------------
    /*
     * This is the query the order controller now runs, so a line showing
     * "gradient" here shows a gradient in the app, for the reason given.
     * `menu_item_id IS NULL` and a dangling id are different causes with the
     * same appearance, which is exactly why they are separated.
     */
    const lines = await sql<{
      order_number: string;
      name_snapshot: string;
      menu_item_id: string | null;
      image_url: string | null;
      item_exists: boolean;
    }>`
      SELECT o.public_order_number       AS order_number,
             oi.name_snapshot,
             oi.menu_item_id,
             mi.image_url,
             (mi.id IS NOT NULL)         AS item_exists
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.id
        LEFT JOIN menu_item mi ON mi.id = oi.menu_item_id
       WHERE o.id = (SELECT id FROM "order" ORDER BY created_at DESC LIMIT 1)
       ORDER BY oi.created_at
    `.execute(db);

    if (lines.rows.length === 0) {
      line(`${YELLOW}No orders exist yet.${OFF} Place one and run this again.`);
    } else {
      line(`Order ${lines.rows[0]!.order_number}`);
      dim('');
      dim(`${'dish'.padEnd(28)} ${'draws'.padEnd(10)} why`);
      for (const r of lines.rows) {
        const draws = r.image_url ? `${GREEN}photo${OFF}` : `${YELLOW}gradient${OFF}`;
        const why = r.image_url
          ? 'menu_item.image_url is set'
          : r.menu_item_id === null
            ? 'the line has no menu_item_id (an external item)'
            : !r.item_exists
              ? 'the menu item was deleted — the order line is intact by design'
              : 'the dish exists but has no photo uploaded';
        dim(`${r.name_snapshot.slice(0, 26).padEnd(28)} ${draws.padEnd(19)} ${why}`);
      }
    }

    // -----------------------------------------------------------------------
    step('Verdict');
    // -----------------------------------------------------------------------
    if (totalWith === 0 && withCover.length === 0) {
      line(`${YELLOW}No images have been uploaded anywhere in this database.${OFF}`);
      dim('');
      dim('The join added to the order API is correct and is returning null,');
      dim('because null is what is there. Upload a dish photo and a stall cover');
      dim('from the kitchen board, then place an order — no code change will');
      dim('make a picture appear before that.');
    } else {
      line(`${GREEN}There are images to show.${OFF}`);
      dim('');
      dim('If a dish above says "gradient", the reason beside it is the reason.');
      dim('If one says "photo" and the app still shows a square, that is a client');
      dim('problem rather than a data one — say so and it gets looked at next.');
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  process.stderr.write(`\n${RED}${e instanceof Error ? (e.stack ?? e.message) : String(e)}${OFF}\n\n`);
  process.exit(1);
});
