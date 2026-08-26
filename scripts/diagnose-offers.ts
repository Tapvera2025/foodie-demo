/**
 * Why is the offer banner not on the customer's screen?
 *
 * ============================================================================
 * THE SYMPTOM THIS EXISTS FOR
 * ============================================================================
 *
 *   "the admin granted the slot, the kitchen uploaded the image,
 *    and nothing shows up on the customer app"
 *
 * The carousel is the end of a four-link chain, and any one link being absent
 * produces the same thing: an empty space where a banner would be. The screen
 * cannot say which link it was, because from the client's side there is nothing
 * to say — the API returned `offers: []`, which is exactly what it returns when
 * everything is configured and no stall qualifies.
 *
 *   granted    `vendor.offer_uploads_enabled` — the console's switch
 *   image      `vendor.offer_image_url` — the kitchen's upload
 *   headline   `vendor.offer_headline` — required with the image, by CHECK
 *   OPEN       the stall is accepting orders RIGHT NOW
 *
 * The fourth is the one that surprises people, and it is deliberate. The
 * carousel is the first thing on the screen; leading with a shut stall's offer
 * is an advertisement for a disappointment. A stall outside its opening hours,
 * paused by its own kitchen, or blocked by the escalation ladder is excluded —
 * and none of those look like a problem with the offer.
 *
 *   npm run diagnose:offers
 *
 * Read-only. It changes nothing.
 */



import { createDb, createPool } from '../src/platform/db.js';
import { isOpenAt, nextOpening, parseHours } from '../src/catalog/opening-hours.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const OFF = '\x1b[0m';

const tick = (ok: boolean): string => (ok ? `${GREEN}yes${OFF}` : `${RED} no${OFF}`);

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.log(`${RED}DATABASE_URL is not set.${OFF}`);
    process.exit(1);
  }

  const db = createDb(createPool({ connectionString: url, max: 2 }));

  try {
    const rows = await db
      .selectFrom('vendor')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'vendor.id as id',
        'vendor.name as name',
        'vendor.status as status',
        'vendor.offer_uploads_enabled as granted',
        'vendor.offer_image_url as imageUrl',
        'vendor.offer_headline as headline',
        'vendor.offer_slot_requested_at as requestedAt',
        'vendor.temp_closed_until as pausedUntil',
        'vendor.dispatch_blocked_at as blockedAt',
        'vendor.operating_hours as hours',
        'food_court.name as courtName',
        'food_court.timezone as timezone',
      ])
      .orderBy('food_court.name')
      .orderBy('vendor.name')
      .execute();

    if (rows.length === 0) {
      console.log(`${YELLOW}No stalls at all. Seed one first: ${CYAN}npm run seed:dev${OFF}`);
      return;
    }

    const now = new Date();
    let showing = 0;

    console.log(`\n${BOLD}every stall, and the four things the carousel needs${OFF}`);
    console.log('─'.repeat(78));
    console.log(
      `${DIM}  granted  image  headline  open    stall${OFF}`,
    );

    for (const v of rows) {
      const hours = parseHours(v.hours);
      const withinHours = isOpenAt(hours, now, v.timezone);
      const paused = (v.pausedUntil?.getTime() ?? 0) > now.getTime();
      const accepting =
        v.status === 'ACTIVE' && !v.blockedAt && !paused && withinHours;

      const granted = Boolean(v.granted);
      const hasImage = Boolean(v.imageUrl);
      const hasHeadline = Boolean(v.headline);
      const qualifies = granted && hasImage && hasHeadline && accepting;
      if (qualifies) showing++;

      console.log(
        `  ${qualifies ? `${GREEN}▸${OFF}` : ' '} ` +
          `${tick(granted)}     ${tick(hasImage)}   ${tick(hasHeadline)}      ${tick(accepting)}   ` +
          `${BOLD}${v.name}${OFF} ${DIM}(${v.courtName})${OFF}`,
      );

      // The FIRST missing link, with the thing to do about it. Naming all four
      // would bury the one that matters under three that are already fine.
      if (qualifies) continue;

      if (!granted) {
        const waiting = v.requestedAt !== null;
        console.log(
          `        ${YELLOW}no slot${OFF} — ` +
            (waiting
              ? 'the kitchen has asked and nobody has answered. Console → Offers.'
              : 'the console has not granted one. Console → Offers, or the stall page.'),
        );
      } else if (!hasImage) {
        console.log(
          `        ${YELLOW}slot granted, nothing uploaded${OFF} — the kitchen board's Stall tab.`,
        );
      } else if (!hasHeadline) {
        // A database CHECK refuses this pair, so seeing it means somebody wrote
        // the column directly. Worth saying so rather than just "add a headline".
        console.log(
          `        ${RED}an image with no headline${OFF} — the CHECK constraint should` +
            ' have refused this. Written outside the app?',
        );
      } else {
        const why =
          v.status !== 'ACTIVE'
            ? `the platform has this stall ${String(v.status).toLowerCase()}`
            : v.blockedAt
              ? 'blocked by the escalation ladder — the board stopped accepting orders'
              : paused
                ? `paused by its own kitchen until ${v.pausedUntil?.toLocaleTimeString('en-IN')}`
                : `outside its opening hours${
                    nextOpening(hours, now, v.timezone)
                      ? ` — opens ${nextOpening(hours, now, v.timezone)!.at}`
                      : ''
                  }`;
        console.log(
          `        ${YELLOW}ready, but not open${OFF} — ${why}.\n` +
            `        ${DIM}Deliberate: the carousel is the first thing on the screen, and` +
            ` leading with a shut stall is an advert for a disappointment.${OFF}`,
        );
      }
    }

    console.log('\n' + '═'.repeat(78));
    if (showing > 0) {
      console.log(
        `${GREEN}${BOLD}${showing} banner${showing === 1 ? '' : 's'} should be on the customer home right now.${OFF}`,
      );
      console.log(
        `${DIM}If the screen is still empty, the break is client-side — check the` +
          ` network tab for ${OFF}GET /api/v1/food-courts/:id/vendors${DIM} and look at` +
          ` \`offers\`.${OFF}`,
      );
    } else {
      console.log(`${RED}${BOLD}No stall qualifies, so the carousel renders nothing.${OFF}`);
      console.log(`${DIM}The first unmet condition for each stall is named above.${OFF}`);
    }
  } finally {
    await db.destroy();
  }
}

void main().catch((e: unknown) => {
  console.error(`${RED}${String(e)}${OFF}`);
  process.exit(1);
});
