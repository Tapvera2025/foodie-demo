/**
 * Why can a customer not see anything?
 *
 * THE SYMPTOM THIS EXISTS FOR
 *
 *   "the user side UI is not visible"
 *   "I added a food court and it does not show"
 *   "the stall list is empty"
 *
 * All three have the same shape and none of them is a UI bug. The customer app
 * is the END of a chain — Postgres, migrations, a seeded court, an ACTIVE
 * court, a QR token on that court, an ACTIVE vendor inside it, a vendor whose
 * kitchen tablet has checked in, and an available menu item. Any one link being
 * absent produces a correct, empty screen, and the screen cannot say which link
 * it was because it cannot see them.
 *
 * So this walks the chain and names the first broken link, with the command
 * that fixes it.
 *
 *   npm run diagnose:customer
 *
 * Read-only. It changes nothing.
 */

import { sql } from 'kysely';

import { createDb, createPool } from '../src/platform/db.js';


const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const OFF = '\x1b[0m';

const API = process.env['DIAGNOSE_API_URL'] ?? 'http://localhost:3000';

function head(s: string): void {
  console.log(`\n${BOLD}${s}${OFF}\n${'─'.repeat(74)}`);
}

/** A broken link, with what to do about it. Printed and then we stop. */
function stop(what: string, why: string, fix: string[]): never {
  console.log(`\n${RED}${BOLD}✗ ${what}${OFF}\n`);
  console.log(`  ${why}\n`);
  console.log(`  ${BOLD}Fix${OFF}`);
  for (const line of fix) console.log(`    ${CYAN}${line}${OFF}`);
  console.log();
  process.exit(1);
}

function ok(s: string): void {
  console.log(`  ${GREEN}✓${OFF} ${s}`);
}

function warn(s: string): void {
  console.log(`  ${YELLOW}!${OFF} ${s}`);
}

async function main(): Promise<void> {
  console.log(
    `\n${BOLD}Can a customer see stalls right now?${OFF}\n` +
      `${DIM}Walking the chain from the database to the phone.${OFF}`,
  );

  // ------------------------------------------------------------- 1. Postgres
  head('1. The database');

  /*
   * `createPool`, not a hand-built one — see tests/conformance/script-db.mjs.
   * `platform/db.ts` registers the INT8 type parser on import, and without it
   * every BIGINT money column arrives as a string.
   *
   * This script was the TENTH with that bug and the one the automated check
   * found: my own grep missed it because the Pool is formatted across four
   * lines rather than one. A regex over source finds what it was shaped for;
   * a check that parses every file finds what is actually there.
   */
  const db = createDb(
    createPool({
      connectionString: process.env['DATABASE_URL'] ?? '',
      connectionTimeoutMillis: 4000,
    }),
  );

  try {
    await sql`select 1`.execute(db);
    ok(`reachable at ${process.env['DATABASE_URL'] ? 'DATABASE_URL' : 'the default connection'}`);
  } catch (e) {
    stop(
      'Postgres is not reachable',
      'Nothing downstream can work. The API will start and every request will fail.\n' +
        `  ${DIM}${e instanceof Error ? e.message : String(e)}${OFF}`,
      [
        'npm run db:up          # start the container',
        'npm run db:doctor      # if that looks fine — usually a port collision',
      ],
    );
  }

  // -------------------------------------------------------- 2. Schema exists
  const migrated = await sql<{ n: number }>`
    select count(*)::int as n from information_schema.tables
     where table_schema = 'public' and table_name = 'food_court'
  `.execute(db);

  if ((migrated.rows[0]?.n ?? 0) === 0) {
    stop(
      'The schema has not been created',
      'The database is up but empty — no tables exist.',
      ['npm run migrate:up', 'npm run seed:dev'],
    );
  }
  ok('schema is present');

  // ---------------------------------------------------------- 3. Food courts
  head('2. Food courts');

  const courts = await db
    .selectFrom('food_court')
    .select(['id', 'name', 'city', 'status', 'qr_token'])
    .orderBy('created_at', 'asc')
    .execute();

  if (courts.length === 0) {
    stop(
      'There are no food courts at all',
      'The customer app opens on a court picker with nothing to pick.',
      ['npm run seed:dev      # creates a court, a stall, a menu and a QR'],
    );
  }

  for (const c of courts) {
    const live = c.status === 'ACTIVE';
    const scannable = live && c.qr_token !== null;
    const mark = scannable ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    console.log(
      `  ${mark} ${c.name.padEnd(28)} ${c.status.padEnd(10)} ${
        c.qr_token ? `${DIM}qr issued${OFF}` : `${YELLOW}NO QR${OFF}`
      }`,
    );
  }

  const reachable = courts.filter((c) => c.status === 'ACTIVE' && c.qr_token !== null);

  if (reachable.length === 0) {
    const activeNoQr = courts.filter((c) => c.status === 'ACTIVE' && c.qr_token === null);

    if (activeNoQr.length > 0) {
      /**
       * THE COMMONEST CAUSE, AND THE QUIETEST.
       *
       * A court created in the console is ACTIVE with no token. The platform
       * knows the venue exists and nobody can get in — two facts that look
       * identical on a row showing only status. It is the exact bug the QR
       * panel's header documents.
       */
      stop(
        'Every court is live but none has a QR code',
        `${activeNoQr.map((c) => `"${c.name}"`).join(', ')} ${
          activeNoQr.length === 1 ? 'is' : 'are'
        } ACTIVE with no token.\n` +
          '  A court with no QR cannot be entered — the token is the only thing that\n' +
          '  establishes a customer is standing in the venue. The court picker shows it\n' +
          '  as unreachable rather than hiding it, but there is nothing to tap.',
        [
          'Open the console at http://localhost:5175',
          'Food courts → pick the court → "Issue a QR" in the Venue QR panel',
        ],
      );
    }

    stop(
      'No court is live',
      'Every court is DRAFT, SUSPENDED or INACTIVE. Only ACTIVE courts are offered.',
      ['Open http://localhost:5175 → Food courts → put one live'],
    );
  }
  ok(`${reachable.length} court${reachable.length === 1 ? '' : 's'} reachable`);

  // -------------------------------------------------------------- 4. Vendors
  head('3. Stalls inside the reachable courts');

  const HEARTBEAT_GRACE_SECONDS = 90;

  for (const court of reachable) {
    const vendors = await db
      .selectFrom('vendor')
      .select([
        'id',
        'name',
        'status',
        'kds_last_heartbeat_at',
        'temp_closed_until',
        'dispatch_blocked_at',
      ])
      .where('food_court_id', '=', court.id)
      .orderBy('name', 'asc')
      .execute();

    console.log(`\n  ${BOLD}${court.name}${OFF}`);

    if (vendors.length === 0) {
      warn('no stalls at all — the court opens to an empty list');
      continue;
    }

    for (const v of vendors) {
      // Through `menu`, not off the item — a menu_item belongs to a MENU, and
      // the menu belongs to the vendor. Getting this wrong is how a diagnostic
      // ends up confidently reporting the wrong stall.
      const items = await db
        .selectFrom('menu_item')
        .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('menu.vendor_id', '=', v.id)
        .where('menu_item.status', '=', 'ACTIVE')
        .executeTakeFirst();

      const heartbeatAgeSeconds = v.kds_last_heartbeat_at
        ? Math.round((Date.now() - v.kds_last_heartbeat_at.getTime()) / 1000)
        : null;

      const reasons: string[] = [];
      if (v.status !== 'ACTIVE') reasons.push(`status ${v.status}`);
      if ((items?.n ?? 0) === 0) reasons.push('no active menu items');
      if (v.temp_closed_until && v.temp_closed_until > new Date()) reasons.push('paused');
      if (v.dispatch_blocked_at) reasons.push('dispatch blocked');
      if (heartbeatAgeSeconds === null) reasons.push('kitchen board never opened');
      else if (heartbeatAgeSeconds > HEARTBEAT_GRACE_SECONDS)
        reasons.push(`no heartbeat for ${heartbeatAgeSeconds}s`);

      const shown = v.status === 'ACTIVE';
      const orderable = reasons.length === 0;

      console.log(
        `    ${orderable ? `${GREEN}✓${OFF}` : shown ? `${YELLOW}!${OFF}` : `${RED}✗${OFF}`} ` +
          `${v.name.padEnd(26)} ${
            orderable
              ? `${GREEN}open${OFF}`
              : shown
                ? `${YELLOW}listed, not orderable${OFF} ${DIM}(${reasons.join('; ')})${OFF}`
                : `${RED}not listed${OFF} ${DIM}(${reasons.join('; ')})${OFF}`
          }`,
      );
    }
  }

  /**
   * A stall with a stale heartbeat is LISTED and not orderable, which is
   * correct and surprising. Availability is derived from the freshness of the
   * kitchen's heartbeat so that a stall whose tablet slept stops taking money
   * for tickets nobody can see — but in development nobody has the board open,
   * so every stall looks shut for a reason that is not a misconfiguration.
   */
  console.log(
    `\n  ${DIM}A stall shows as closed until its kitchen board is open — availability is\n` +
      `  derived from the tablet's heartbeat, on purpose. Open http://localhost:5174\n` +
      `  and sign in, and the stall becomes orderable within a few seconds.${OFF}`,
  );

  // ------------------------------------------------------------------ 5. API
  head('4. The API');

  try {
    const res = await fetch(`${API}/api/v1/dev/courts`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 404) {
      stop(
        'The dev court list is disabled',
        'The endpoint returns 404 when NODE_ENV is production. The customer app\n' +
          '  then shows a plain scan prompt with no list, which is correct for a real\n' +
          '  build and useless on a laptop.',
        ['Unset NODE_ENV, or set NODE_ENV=development, and restart the API'],
      );
    }

    if (!res.ok) {
      stop(
        `The API answered ${res.status}`,
        'The customer app shows "Cannot reach the server" with a retry button.',
        ['Check the API log — it prints the failing request with a correlation id'],
      );
    }

    const body = (await res.json()) as { courts: { name: string; token: string | null }[] };
    ok(`serving ${body.courts.length} court${body.courts.length === 1 ? '' : 's'} to the app`);

    const withToken = body.courts.filter((c) => c.token !== null).length;
    if (withToken === 0 && body.courts.length > 0) {
      warn('all of them render as unreachable — see section 2');
    }
  } catch (e) {
    stop(
      `The API is not answering on ${API}`,
      'This is what "the user side is not visible" almost always means: the PWA is\n' +
        '  running fine and proxying /api to port 3000, and nothing is there.\n' +
        `  ${DIM}${e instanceof Error ? e.message : String(e)}${OFF}`,
      [
        'npm run dev:all        # API, worker and all three front ends',
        '',
        'If it exits immediately, read the first lines — config is validated',
        'before anything starts and a missing variable exits with code 78.',
      ],
    );
  }

  // ---------------------------------------------------------------- verdict
  head('Verdict');
  console.log(
    `  ${GREEN}The chain is intact.${OFF} Open ${CYAN}http://localhost:5173${OFF} and pick a court.\n\n` +
      `  ${DIM}If the page is still blank, it is the browser and not the data:\n` +
      `    · hard reload (Cmd-Shift-R) — Vite serves a stale module after some edits\n` +
      `    · check the browser console for a red error, which Vite also shows as an overlay\n` +
      `    · confirm the tab is on 5173 and not 5174 (kitchen) or 5175 (console)${OFF}`,
  );
  console.log();

  await db.destroy();
}

main().catch((e) => {
  console.error(`\n${RED}The diagnosis itself failed.${OFF}`);
  console.error(e);
  process.exit(1);
});
