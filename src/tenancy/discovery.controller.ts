/**
 * Scan and browse. The first two screens of the product.
 *
 * `contracts/openapi.yaml` — /qr/{token}, /food-courts/{id}/vendors,
 * /vendors/{id}/menu.
 *
 * Unauthenticated by design: the QR token IS the credential. There is no login
 * because a customer will not create an account to buy a plate of noodles, and
 * PRD §8 treats every extra tap before the menu as attrition.
 */

import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { sql, type Kysely } from 'kysely';

import { itemReasonCopyKey, itemState } from '../catalog/availability.js';
import { currentClose, isOpenAt, nextOpening, parseHours } from '../catalog/opening-hours.js';
import { serviceDateFor } from '../catalog/service-date.js';
import { authKeys } from '../identity/keys.js';
import { issueToken } from '../identity/tokens.js';
import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { buildCategoryChips } from './categories.js';
import { isValidQrTokenFormat } from './qr.js';
import { optionalSessionPrincipal, SESSION_AUDIENCE } from '../identity/session.guard.js';
import { DEFAULT_SESSION_TTL_MINUTES } from './session.js';

@Controller('api/v1')
export class DiscoveryController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /**
   * Resolve a QR token to a FOOD COURT, and open a session in it.
   *
   * One code per venue, printed on posters and stall fronts — not one per
   * table. Food-court seating is shared, unnumbered and constantly rearranged,
   * so nobody owns a table well enough to maintain a sticker on it, and there
   * is no table service to justify knowing which one you are at. The order
   * number is what identifies a customer at the counter.
   *
   * GET rather than POST, because this is what a phone camera does when it
   * opens the URL. Safe despite appearances: rescanning with the session token
   * this endpoint issued returns that same session rather than opening a second
   * one, so the basket survives. Rescanning WITHOUT it opens a new session —
   * see the note on resumption below for why that direction is the safe one.
   */
  @Get('qr/:token')
  async scan(@Param('token') token: string, @Req() req: Request): Promise<unknown> {
    // Format-check before touching the database. A malformed token is a
    // sticker from somewhere else, not a lookup worth doing.
    if (!isValidQrTokenFormat(token)) {
      throw new AppError('QR_INVALID', 'That code is not one of ours');
    }

    const court = await this.db
      .selectFrom('food_court')
      .select(['id', 'name', 'status'])
      .where('qr_token', '=', token)
      .executeTakeFirst();

    // Same error for "no such token" and "suspended court". Distinguishing
    // them tells someone probing tokens which guesses were close.
    if (!court || court.status !== 'ACTIVE') {
      throw new AppError('QR_INVALID', 'That code is not active');
    }

    /**
     * RESUME ONLY WHAT THIS CLIENT CAN PROVE IS ITS OWN.
     *
     * The previous version selected the newest unexpired `app_session` for the
     * court and handed it back to whoever asked. That is not a resume, it is a
     * shared session: at one venue with a four-hour TTL, every customer who
     * scanned the poster got the same row, inherited the identity of the first
     * person to verify an OTP on it, and could read their orders.
     *
     * Resumption now requires the signed token issued when the session was
     * created. Everything else opens a new one, which is the safe direction —
     * an extra session costs a row, a shared session costs a stranger's lunch.
     *
     * The court is re-checked against the token rather than trusted from it: a
     * valid token for a different venue is somebody carrying a session across
     * the city, not a resume.
     */
    const presented = await optionalSessionPrincipal(req);

    const live =
      presented && presented.foodCourtId === court.id
        ? ((await this.db
            .selectFrom('app_session')
            .select(['id', 'expires_at', 'customer_id'])
            .where('id', '=', presented.sessionId)
            .where('food_court_id', '=', court.id)
            .where('expires_at', '>', new Date())
            .executeTakeFirst()) ?? null)
        : null;

    const session =
      live ??
      (await this.db
        .insertInto('app_session')
        .values({
          food_court_id: court.id,
          // No table. Nullable since migration 20260812000003.
          court_table_id: null,
          expires_at: new Date(Date.now() + DEFAULT_SESSION_TTL_MINUTES * 60_000),
        })
        .returning(['id', 'expires_at', 'customer_id'])
        .executeTakeFirstOrThrow());

    /**
     * The credential that makes the next scan a resume rather than a new
     * session. Signed, so the client cannot name a session it was not given.
     */
    const sessionToken = await issueToken(
      authKeys(),
      {
        typ: 'session',
        sub: session.id,
        fc: court.id,
        // The table concept was removed in §2.1. The claim survives nullable
        // for the same reason the column does: some venues do have numbered
        // seating, and re-deriving a deleted concept costs a migration.
        tbl: null,
        cus: session.customer_id,
      },
      { audience: SESSION_AUDIENCE },
    );

    return {
      sessionId: session.id,
      sessionToken,
      expiresAt: session.expires_at.toISOString(),
      foodCourt: { id: court.id, name: court.name },
      resumed: live !== null,
    };
  }

  /**
   * DEVELOPMENT ONLY. Lists courts with their QR tokens so you can "scan"
   * without a phone.
   *
   * This endpoint must never answer in production, and the guard is inside the
   * handler rather than at registration so it cannot be defeated by a module
   * being wired up somewhere unexpected.
   *
   * Why it matters more than it looks: the QR token IS the credential. The
   * entire security model is that possessing it means you are physically at
   * that venue. An endpoint that hands out tokens would let anyone order from
   * anywhere — no authentication bypass required, because there is no
   * authentication to bypass. That is the design, and it only holds while the
   * tokens stay on the posters.
   */
  @Get('dev/courts')
  async devCourts(): Promise<unknown> {
    if (config().NODE_ENV === 'production') {
      throw new NotFoundException();
    }

    /**
     * TOKENLESS COURTS ARE RETURNED, NOT FILTERED OUT.
     *
     * The previous version had `where qr_token is not null`, which was correct
     * — you cannot link to a court you cannot scan into — and produced the
     * worst possible symptom: a court created in the console was simply absent
     * here, with nothing erroring and nothing explaining it. "I added a food
     * court and it does not show" has no discoverable answer from this screen.
     *
     * So they come back with `token: null` and the client renders them as
     * unreachable with the reason. Same information, one fewer mystery.
     *
     * Still filtered on ACTIVE: a suspended or closed court is not a
     * configuration gap somebody needs to act on, it is a decision somebody
     * made, and listing it would invite undoing it from the wrong surface.
     */
    const rows = await this.db
      .selectFrom('food_court')
      .select(['name', 'city', 'qr_token'])
      .where('status', '=', 'ACTIVE')
      .orderBy('qr_token', 'desc') // scannable first; nulls sort last
      .orderBy('name')
      .execute();

    return { courts: rows.map((r) => ({ name: r.name, city: r.city, token: r.qr_token })) };
  }

  @Get('food-courts/:foodCourtId/vendors')
  async vendors(@Param('foodCourtId') foodCourtId: string): Promise<unknown> {
    // The court's timezone, because "is this stall open" is a question about
    // wall-clock time where the customer is standing, not where the server is.
    const court = await this.db
      .selectFrom('food_court')
      .select('timezone')
      .where('id', '=', foodCourtId)
      .executeTakeFirst();

    const timezone = court?.timezone ?? 'Asia/Kolkata';

    const rows = await this.db
      .selectFrom('vendor')
      .select((eb) => [
        'id',
        'name',
        'cuisine',
        'status',
        'estimated_prep_minutes',
        'temp_closed_until',
        'dispatch_blocked_at',
        'kds_last_heartbeat_at',
        'cover_image_url',
        'logo_url',
        'operating_hours',
        'offer_image_url',
        'offer_headline',
        'offer_uploads_enabled',
        /**
         * A typical spend, as the reference's "₹250 for one".
         *
         * The MEDIAN item price, not the mean. A stall selling twenty dishes at
         * ₹120 and one thali at ₹900 has a mean of ₹157 and a median of ₹120,
         * and the median is what a customer will actually pay. Means are pulled
         * around by exactly the outlier every menu has.
         *
         * `percentile_cont` interpolates, which is right here — a two-item menu
         * at 100 and 200 should read 150 rather than arbitrarily picking one.
         */
        sql<number | null>`(
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mi.base_price_paise)
            FROM menu_item mi
            JOIN menu m ON m.id = mi.menu_id
           WHERE m.vendor_id = vendor.id AND mi.status = 'ACTIVE'
        )`.as('median_price_paise'),
        /**
         * How many orders this stall has actually taken lately.
         *
         * The basis for POPULAR, and the reason that badge is a fact rather
         * than a decoration. Confirmed or later only — an order that never got
         * paid for is not evidence of anything, and counting it would let a
         * stall trend by having a broken checkout.
         *
         * Seven days rather than all time: "popular" in a food court means
         * busy now, and an all-time count would freeze whichever stall opened
         * first at the top for ever.
         */
        eb
          .selectFrom('order')
          .select((e) => e.fn.countAll<number>().as('n'))
          .whereRef('order.vendor_id', '=', 'vendor.id')
          .where('order.status', 'in', [
            'PAYMENT_CONFIRMED',
            'DISPATCHED',
            'ACKNOWLEDGED',
            'PREPARING',
            'READY',
            'COLLECTED',
          ])
          .where('order.created_at', '>', new Date(Date.now() - 7 * 24 * 60 * 60_000))
          .as('recent_orders'),
        /**
         * THE COVER FALLS BACK TO A DISH PHOTOGRAPH.
         *
         * `vendor.cover_image_url` landed with migration 12 and there is no
         * upload path yet, so every row holds NULL and will keep holding NULL
         * until somebody types a URL by hand. Shipping the card against the
         * explicit field alone would mean shipping a design made of grey
         * rectangles and calling it done.
         *
         * A stall that has photographed its food already has the picture the
         * card wants. So: the explicit cover if set, otherwise the first dish
         * image, otherwise a gradient generated client-side from the name.
         *
         * A CORRELATED SUBQUERY, NOT A JOIN. A join would multiply the vendor
         * row by its menu items and need a DISTINCT ON to collapse again —
         * which silently drops stalls with no menu at all, and a stall with no
         * menu is exactly the one being onboarded that somebody is checking on.
         *
         * `order by id` rather than by name or price: it must be STABLE. A card
         * whose photograph changes between two refreshes because two dishes tie
         * on price reads as a glitch.
         */
        eb
          .selectFrom('menu_item')
          .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
          .select('menu_item.image_url')
          .whereRef('menu.vendor_id', '=', 'vendor.id')
          .where('menu_item.status', '=', 'ACTIVE')
          .where('menu_item.image_url', 'is not', null)
          .orderBy('menu_item.id')
          .limit(1)
          .as('fallback_image_url'),
      ])
      .where('food_court_id', '=', foodCourtId)
      .where('status', '=', 'ACTIVE')
      .orderBy('name')
      .execute();

    const now = Date.now();
    const instant = new Date(now);

    const vendors = rows.map((v) => {
      // Availability is DERIVED, never a column someone forgets to update.
      // A stall whose tablet went to sleep is closed whatever its status
      // says — PRD VEN-AVAIL-01.
      const pausedUntil = v.temp_closed_until?.getTime() ?? 0;

      /**
       * Opening hours are the FOURTH input, and the only one that can say when.
       *
       * Ordered below pause and dispatch-block on purpose. All three mean the
       * stall is shut, but they are not interchangeable: a stall that is
       * blocked or paused has a problem somebody is dealing with, and one that
       * is merely outside its hours is behaving exactly as intended. Reporting
       * the first two as "opens at 5pm" would tell a customer to come back for
       * something that will still be broken.
       */
      const hours = parseHours(v.operating_hours);
      const withinHours = isOpenAt(hours, instant, timezone);
      const opensAt = withinHours ? null : nextOpening(hours, instant, timezone);

      const closedReason = v.dispatch_blocked_at
        ? 'unavailable'
        : pausedUntil > now
          ? 'paused'
          : !withinHours
            ? 'outside_hours'
            : null;

      return {
        id: v.id,
        name: v.name,
        cuisine: v.cuisine,
        estimatedPrepMinutes: v.estimated_prep_minutes,
        accepting: closedReason === null,
        closedReason,
        /** `HH:MM` in the court's timezone, only when hours are the reason. */
        opensAt: opensAt?.at ?? null,
        opensToday: opensAt?.today ?? null,
        // One field for the client. Which of the two sources it came from is
        // this endpoint's business, not the card's.
        coverImageUrl: v.cover_image_url ?? v.fallback_image_url ?? null,
        logoUrl: v.logo_url,
        recentOrders: Number(v.recent_orders ?? 0),
        /**
         * Rounded to the nearest ten rupees, because it is an ESTIMATE.
         *
         * "₹247 for one" claims a precision the number does not have — it is
         * the median of a menu, not a price anybody will be charged. Rounding
         * is what stops it reading as a quote.
         */
        typicalSpendPaise:
          v.median_price_paise === null
            ? null
            : Math.round(Number(v.median_price_paise) / 1000) * 1000,
        /** The stall's own claim about its own pricing. No discount is applied. */
        offerHeadline: v.offer_uploads_enabled ? v.offer_headline : null,
      };
    });

    /**
     * THE CAROUSEL, AND THE THREE CONDITIONS FOR BEING IN IT.
     *
     *   granted    the platform enabled this stall's slot. Default FALSE.
     *   filled     the stall uploaded artwork and a headline.
     *   open       the stall is accepting orders right now.
     *
     * The third is the one that is easy to forget and worst to get wrong. The
     * carousel is the first thing on the screen, and leading with a shut stall's
     * offer is an advertisement for a disappointment — the customer taps it,
     * reads the menu, and finds out at the end.
     */
    const offers = rows
      .filter((v) => v.offer_uploads_enabled && v.offer_image_url && v.offer_headline)
      .map((v) => ({
        vendorId: v.id,
        vendorName: v.name,
        imageUrl: v.offer_image_url!,
        headline: v.offer_headline!,
      }))
      .filter((o) => vendors.find((v) => v.id === o.vendorId)?.accepting === true);

    /**
     * TRENDING, FROM FACTS THE PLATFORM ACTUALLY HOLDS.
     *
     * The reference showed a star rating on these cards. There is no rating
     * data anywhere in this system, so the badges are computed from the two
     * things that are genuinely known and genuinely useful:
     *
     *   QUICKEST  the lowest prep estimate among stalls open right now
     *   POPULAR   the most orders actually taken in the last seven days
     *
     * Both are restricted to ACCEPTING stalls. A trending card for a stall that
     * cannot take the order is a photograph of a disappointment, and it sits at
     * the very top of the screen.
     *
     * A stall can only hold one badge — whichever it wins, POPULAR first, so
     * two cards never say the same thing about different stalls.
     */
    const open = vendors.filter((v) => v.accepting);

    const popular = [...open].sort((a, b) => b.recentOrders - a.recentOrders)[0];
    const quickest = [...open]
      .filter((v) => v.id !== popular?.id)
      .sort((a, b) => a.estimatedPrepMinutes - b.estimatedPrepMinutes)[0];

    const trending = [
      // Only if it has actually sold something. "Popular" on a stall with zero
      // orders is the emptiest claim the app could make.
      ...(popular && popular.recentOrders > 0 ? [{ vendorId: popular.id, badge: 'POPULAR' }] : []),
      ...(quickest ? [{ vendorId: quickest.id, badge: 'QUICKEST' }] : []),
    ];

    /**
     * THE CATEGORY CHIPS, BUILT FROM WHAT THIS COURT ACTUALLY SELLS.
     *
     * Not a fixed platform-wide list. A curated "All / Cake / Biryani / Rolls /
     * Pizza" looks like the reference and produces chips that return nothing —
     * and a chip that filters to an empty list is worse than a missing chip,
     * because the customer concludes the court has no biryani when really the
     * chip was never wired to anything.
     *
     * Two sources, because they answer at different grains. Cuisine tags are
     * how a stall describes itself ("North Indian"); menu category names are
     * what it actually cooks ("Momos", "Biryani"). The reference's chips are
     * clearly the second kind, and the first is what a stall with a generic
     * menu falls back on.
     *
     * Ranked by how many STALLS justify each label, so the chip a court leads
     * with is the thing most of its stalls sell. See `categories.ts` for why
     * that is a set of ids rather than a counter, and for the membership each
     * chip now carries.
     */
    const menuCategories = await this.db
      .selectFrom('menu_category')
      .innerJoin('menu', 'menu.id', 'menu_category.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .select(['menu_category.name as name', 'vendor.id as vendorId'])
      .where('vendor.food_court_id', '=', foodCourtId)
      .where('vendor.status', '=', 'ACTIVE')
      .execute();

    const photos = await this.db
      .selectFrom('menu_item')
      .innerJoin('menu_category', 'menu_category.id', 'menu_item.menu_category_id')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .select([
        'menu_item.name as itemName',
        'menu_item.image_url as imageUrl',
        'menu_category.name as categoryName',
        'vendor.cuisine as cuisine',
      ])
      .where('vendor.food_court_id', '=', foodCourtId)
      .where('vendor.status', '=', 'ACTIVE')
      .where('menu_item.status', '=', 'ACTIVE')
      .where('menu_item.image_url', 'is not', null)
      .execute();

    /*
     * The shaping lives in `categories.ts` — pure, and tested there.
     *
     * Three queries in, one array of chips out. Keeping it here meant the only
     * way to check that "Bread" selects the stalls with a Bread section was to
     * stand up a database and look at a phone, which is how it stayed broken.
     */
    const categories = buildCategoryChips({ vendors: rows, menuCategories, photos });

    return { vendors, trending, offers, categories };
  }

  /**
   * Search a court by what somebody wants to EAT.
   *
   * ==========================================================================
   * THE PROBLEM THIS SOLVES
   * ==========================================================================
   *
   * The stall list filtered on stall name and cuisine tags, client-side. So
   * "momo" found Wow Momo and missed the four other stalls in the court that
   * sell one — including, absurdly, the stall whose momo is the best. Cuisine
   * tags are written by whoever onboarded the stall and are never granular
   * enough: "Chinese" does not tell a customer who wants momos anything.
   *
   * People do not search for restaurants. They search for food.
   *
   * WHY THE MATCHED DISHES COME BACK WITH THE STALL
   *
   * A result list that shows only stall names after a dish search is a puzzle:
   * "I searched momo and got Spice Garden — why?" The dishes that matched are
   * the answer, and they carry the price, which is the next thing anybody wants
   * to know. Without them the customer has to open three stalls to compare.
   *
   * WHY ORDERABILITY IS A FIELD AND NOT A FILTER
   *
   * A closed stall that sells exactly what you want is genuinely useful
   * information — it is a reason to come back tomorrow, and hiding it makes the
   * court look like it has less than it does. They sort below the open ones and
   * say so, the same rule the unsearched list already follows.
   */
  @Get('food-courts/:foodCourtId/search')
  async search(
    @Param('foodCourtId') foodCourtId: string,
    @Query('q') q?: string,
  ): Promise<unknown> {
    const term = (q ?? '').trim();

    // Two characters is where trigram similarity starts meaning anything — a
    // single letter is one partial trigram and matches most of the menu. Below
    // that, say nothing rather than return noise.
    if (term.length < 2) return { term, vendors: [] };

    /**
     * `similarity` is set per-request rather than relying on the database's
     * default `pg_trgm.similarity_threshold` (0.3), which is a SESSION setting
     * somebody else can change. 0.22 is deliberately looser than the default:
     * a customer typing "biriyani" against a menu holding "Biryani" scores
     * about 0.6, but "momos" against "Steamed Momo" scores near 0.3, and the
     * default would drop it.
     */
    const MIN_SIMILARITY = 0.22;

    interface ScoredRow {
      vendor_id: string;
      item_id: string | null;
      item_name: string | null;
      item_price: number | null;
      item_orderable: boolean | null;
      score: number;
    }

    const rows = await sql<ScoredRow>`
      WITH scored AS (
        SELECT
          v.id AS vendor_id,
          mi.id AS item_id,
          mi.name AS item_name,
          mi.base_price_paise AS item_price,
          (mi.availability = 'AVAILABLE' AND mi.status = 'ACTIVE') AS item_orderable,
          GREATEST(
            similarity(mi.name, ${term}),
            -- The stall's own name and its cuisine tags still count, so "wow"
            -- finds Wow Momo and "chinese" finds the Chinese stalls. The dish
            -- match usually wins on score, which is the right ordering.
            similarity(v.name, ${term}) * 0.9,
            COALESCE(
              (SELECT MAX(similarity(tag, ${term})) FROM unnest(v.cuisine) AS tag),
              0
            ) * 0.8
          ) AS score
        FROM vendor v
        LEFT JOIN menu m  ON m.vendor_id = v.id
        LEFT JOIN menu_item mi ON mi.menu_id = m.id AND mi.status = 'ACTIVE'
        WHERE v.food_court_id = ${foodCourtId}
          AND v.status = 'ACTIVE'
      )
      SELECT * FROM scored WHERE score >= ${MIN_SIMILARITY}
      ORDER BY score DESC
      LIMIT 200
    `.execute(this.db);

    if (rows.rows.length === 0) return { term, vendors: [] };

    // The stall rows for whatever matched. Re-read rather than carried through
    // the CTE: this is the same shape `vendors` returns, and two endpoints
    // describing a stall differently is how a card renders one way in a list
    // and another way in a search result.
    const scored: ScoredRow[] = rows.rows;
    const vendorIds: string[] = [...new Set(scored.map((r) => r.vendor_id))];

    const vendors = await this.db
      .selectFrom('vendor')
      .select((eb) => [
        'id',
        'name',
        'cuisine',
        'estimated_prep_minutes',
        'temp_closed_until',
        'dispatch_blocked_at',
        'cover_image_url',
        'logo_url',
        eb
          .selectFrom('menu_item')
          .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
          .select('menu_item.image_url')
          .whereRef('menu.vendor_id', '=', 'vendor.id')
          .where('menu_item.status', '=', 'ACTIVE')
          .where('menu_item.image_url', 'is not', null)
          .orderBy('menu_item.id')
          .limit(1)
          .as('fallback_image_url'),
      ])
      .where('id', 'in', vendorIds)
      .execute();

    const now = Date.now();
    const byId = new Map(vendors.map((v) => [v.id, v]));

    const out = vendorIds.flatMap((id) => {
      const v = byId.get(id);
      if (!v) return [];

      const pausedUntil = v.temp_closed_until?.getTime() ?? 0;
      const closedReason = v.dispatch_blocked_at
        ? 'unavailable'
        : pausedUntil > now
          ? 'paused'
          : null;

      // At most three, because the card is a card. A stall with eleven kinds of
      // momo would otherwise push every other result off the screen — and the
      // eleven are visible one tap away on its menu.
      const matches = scored
        .filter((r) => r.vendor_id === id && r.item_id !== null)
        .slice(0, 3)
        .map((r) => ({
          id: r.item_id!,
          name: r.item_name!,
          pricePaise: r.item_price!,
          orderable: r.item_orderable ?? false,
        }));

      return [
        {
          id: v.id,
          name: v.name,
          cuisine: v.cuisine,
          estimatedPrepMinutes: v.estimated_prep_minutes,
          accepting: closedReason === null,
          closedReason,
          coverImageUrl: v.cover_image_url ?? v.fallback_image_url ?? null,
          logoUrl: v.logo_url,
          /** Why this stall is in the results. Empty when it matched by name. */
          matches,
        },
      ];
    });

    // Open stalls first, exactly as the unsearched list does. Relevance decides
    // the order within each group, so the best match that a customer can
    // actually order from is always the first card.
    out.sort((a, b) => (a.accepting === b.accepting ? 0 : a.accepting ? -1 : 1));

    return { term, vendors: out };
  }

  @Get('vendors/:vendorId/menu')
  async menu(@Param('vendorId') vendorId: string): Promise<unknown> {
    // The court's timezone travels with the menu because the stock lookup needs
    // it. Joined rather than assumed 'Asia/Kolkata': a hardcoded zone works
    // until the second city and then miscounts every evening.
    const menu = await this.db
      .selectFrom('menu')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'menu.id as id',
        'food_court.timezone as timezone',
        // The stall's own header, travelling with its menu.
        //
        // The screen previously knew only the name, carried over from the cart
        // store — which meant a customer who opened a menu link directly saw a
        // header with no cuisine and no way to tell whether the stall was even
        // taking orders. One request rather than two: the menu and the header
        // above it are the same screen and should not be able to disagree.
        'vendor.name as vendorName',
        'vendor.cuisine as cuisine',
        'vendor.estimated_prep_minutes as prepMinutes',
        'vendor.temp_closed_until as tempClosedUntil',
        'vendor.dispatch_blocked_at as dispatchBlockedAt',
        /*
         * THE HEADER THE STALL PAGE DRAWS, AND WHY IT IS ON THIS QUERY.
         *
         * The redesigned page opens with a banner, a cuisine line, a closing
         * time and a typical spend — everything the stall CARD already shows,
         * because tapping a card and landing on a page that knows less than the
         * card did reads as the page having failed to load.
         *
         * Fetched here rather than by a second request for the same reason the
         * name and cuisine already are: the banner and the menu under it are
         * one screen, and two requests can disagree.
         */
        'vendor.operating_hours as operatingHours',
        'vendor.cover_image_url as coverImageUrl',
        'vendor.logo_url as logoUrl',
      ])
      .where('menu.vendor_id', '=', vendorId)
      .executeTakeFirst();

    if (!menu) throw new NotFoundException('No menu for this vendor');
    const court = { timezone: menu.timezone };

    /*
     * Derived by the same rule as the stall list, not a second copy of it.
     *
     * OPENING HOURS WERE MISSING FROM THIS COPY, and that was a real
     * disagreement rather than a tidiness point: a stall outside its hours read
     * `accepting: true` here and `outside_hours` on the list, so a customer
     * tapping a card marked "Opens 5pm" landed on a menu with live ADD buttons.
     * The order would then be refused at checkout by a rule the menu never
     * mentioned.
     */
    const instant = new Date();
    const hours = parseHours(menu.operatingHours);
    const withinHours = isOpenAt(hours, instant, court.timezone);
    const opensAt = withinHours ? null : nextOpening(hours, instant, court.timezone);
    const closesAt = withinHours ? currentClose(hours, instant, court.timezone) : null;

    const pausedUntil = menu.tempClosedUntil?.getTime() ?? 0;
    const closedReason = menu.dispatchBlockedAt
      ? 'unavailable'
      : pausedUntil > Date.now()
        ? 'paused'
        : !withinHours
          ? 'outside_hours'
          : null;

    const categories = await this.db
      .selectFrom('menu_category')
      .select(['id', 'name', 'sort_order'])
      .where('menu_id', '=', menu.id)
      .orderBy('sort_order')
      .orderBy('name')
      .execute();

    const items = await this.db
      .selectFrom('menu_item')
      .select([
        'id',
        'menu_category_id',
        'name',
        'description',
        'base_price_paise',
        'tax_rate_bps',
        'dietary_flags',
        'image_url',
        'status',
        'availability',
        'inventory_mode',
        'available_from',
        'sort_order',
        'must_try',
      ])
      .where('menu_id', '=', menu.id)
      // A discontinued item is not a greyed-out item — it is not on the menu.
      // Filtered in SQL rather than after, so the row never reaches the wire.
      .where('status', '=', 'ACTIVE')
      .orderBy('sort_order')
      .orderBy('name')
      .execute();

    /*
     * THE TYPICAL SPEND, FROM ROWS ALREADY IN MEMORY.
     *
     * The stall list computes this as a correlated subquery, because there it
     * is answering for thirty vendors at once and cannot fetch every menu. Here
     * the whole menu has just been selected, so a second trip to the database
     * for a figure sitting in `items` would be work done twice.
     *
     * The MEDIAN rather than the mean, matching the list, because one ₹900
     * thali on a menu of ₹120 dishes drags a mean somewhere nobody pays.
     *
     * A `heroFallback` used to be computed here too — the first dish photo,
     * sorted by id for stability. It is gone: the stall page shows the stall's
     * OWN banner or nothing, and a "stable" fallback was still a picture that
     * changed whenever the menu did.
     */
    const prices = items.map((i) => i.base_price_paise).sort((a, b) => a - b);
    const medianPricePaise = ((): number | null => {
      if (prices.length === 0) return null;
      const mid = prices.length / 2;
      // Interpolating on an even count, matching `percentile_cont` on the list.
      // A two-item menu at 100 and 200 reads 150 rather than arbitrarily
      // picking one of them.
      const median =
        prices.length % 2 === 1
          ? prices[Math.floor(mid)]!
          : (prices[mid - 1]! + prices[mid]!) / 2;
      // Rounded to the nearest ten rupees, because it is an ESTIMATE. "₹247"
      // claims a precision the median of a menu does not have.
      return Math.round(median / 1000) * 1000;
    })();

    // Remaining counts, for TRACKED items only. One query for the whole menu
    // rather than one per item: a food court menu is small, and N+1 on the
    // screen that must render in 1.5s on 4G is not a trade worth making.
    const tracked = items.filter((i) => i.inventory_mode === 'TRACKED').map((i) => i.id);
    const remaining = new Map<string, number>();
    if (tracked.length > 0) {
      const rows = await this.db
        .selectFrom('v_menu_item_stock_remaining')
        .select(['menu_item_id', 'remaining'])
        .where('menu_item_id', 'in', tracked)
        .where('service_date', '=', serviceDateFor(new Date(), court.timezone))
        .execute();
      for (const r of rows) remaining.set(r.menu_item_id, r.remaining);
    }

    /**
     * ========================================================================
     * BESTSELLERS, FROM ORDERS RATHER THAN FROM AN OPINION
     * ========================================================================
     *
     * The reference badges dishes "Bestseller". Every version of that badge
     * worth shipping is a fact — a vendor-editable "featured" flag becomes a
     * badge on everything within a week, which is the same as a badge on
     * nothing.
     *
     * SUM(quantity), not COUNT(*). Six portions of one dish in one order is six
     * portions sold; counting rows would rank a dish somebody buys one of, in
     * every order, above one somebody buys ten of, occasionally.
     *
     * `is_rejected` excluded. A line the kitchen struck off was not sold, and
     * the item most often rejected is precisely the one that keeps running out
     * — so counting rejections would badge the dish nobody can actually get.
     *
     * Same seven-day window and same status list as the stall list's POPULAR
     * badge, because "selling well" should mean one thing in this product.
     */
    const soldRows = await this.db
      .selectFrom('order_item')
      .innerJoin('order', 'order.id', 'order_item.order_id')
      .select((e) => [
        'order_item.menu_item_id as itemId',
        e.fn.sum<string>('order_item.quantity').as('sold'),
      ])
      .where('order.vendor_id', '=', vendorId)
      .where('order_item.menu_item_id', 'is not', null)
      .where('order_item.is_rejected', '=', false)
      .where('order.status', 'in', [
        'PAYMENT_CONFIRMED',
        'DISPATCHED',
        'ACKNOWLEDGED',
        'PREPARING',
        'READY',
        'COLLECTED',
      ])
      .where('order.created_at', '>', new Date(Date.now() - 7 * 24 * 60 * 60_000))
      .groupBy('order_item.menu_item_id')
      .execute();

    /*
     * THE TOP THREE, AND ONLY IF THEY SOLD ANYTHING.
     *
     * A cap rather than a threshold: an absolute number like "20 sold" badges
     * everything at a busy stall and nothing at a quiet one on the same menu
     * page. Three is few enough that the badge still means "these ones", which
     * is the only thing it can usefully mean.
     *
     * A brand-new stall has no orders at all, and every count is zero. The
     * `> 0` filter is what stops the first three items alphabetically being
     * crowned bestsellers on opening day.
     */
    const bestsellers = new Set(
      soldRows
        .map((r) => ({ id: r.itemId as string, sold: Number(r.sold) }))
        .filter((r) => r.sold > 0)
        .sort((a, b) => b.sold - a.sold || a.id.localeCompare(b.id))
        .slice(0, 3)
        .map((r) => r.id),
    );

    const now = new Date();
    return {
      vendorId,
      vendor: {
        name: menu.vendorName,
        cuisine: menu.cuisine,
        estimatedPrepMinutes: menu.prepMinutes,
        accepting: closedReason === null,
        closedReason,
        /**
         * THE STALL'S OWN BANNER, AND NOTHING ELSE.
         *
         * This used to fall through to `heroFallback` — the first dish with a
         * photograph, ordered by id — the same rule the stall CARD uses. On a
         * card that is right: a gradient where a photograph of food could be is
         * a worse card, and nobody reads a card as a claim about the shop.
         *
         * On the stall's own page it is wrong, and it produced the bug: the
         * banner changed by itself whenever the menu did. Add a dish, remove
         * one, photograph one — the picture at the top of the page moved, with
         * nobody having touched it and nothing to blame.
         *
         * So the page shows what the stall CHOSE, or a generated band. There is
         * an upload for it now (`PUT /vendor/cover`); until an owner uses it,
         * the honest answer is that the stall has not picked a photograph.
         */
        coverImageUrl: menu.coverImageUrl,
        logoUrl: menu.logoUrl,
        /** `HH:MM` in the court's timezone, only when hours are the reason. */
        opensAt: opensAt?.at ?? null,
        opensToday: opensAt?.today ?? null,
        /**
         * When the stretch it is currently open for runs out.
         *
         * Null for a shut stall and null for one with no schedule — see
         * `currentClose`. "Open now" with nothing after it is the correct
         * rendering of a counter that has not told anyone when it stops.
         */
        closesAt: closesAt?.at ?? null,
        closesTomorrow: closesAt?.tomorrow ?? null,
        /** Rounded to ten rupees. An estimate, not a quote. See the list. */
        typicalSpendPaise: medianPricePaise,
      },
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        items: items
          .filter((i) => i.menu_category_id === c.id)
          .map((i) => {
            // Derived here, by the same pure function the KDS and the order
            // path use. Three copies of this logic is three chances for the
            // customer menu and the checkout to disagree about one item.
            const state = itemState(
              {
                status: i.status,
                availability: i.availability,
                availableFrom: i.available_from,
                inventoryMode: i.inventory_mode,
                remaining: remaining.get(i.id) ?? null,
              },
              now,
            );

            return {
              id: i.id,
              name: i.name,
              description: i.description,
              // Paise on the wire, formatted on the client. A float here is how
              // ₹180.00 becomes ₹179.99 on somebody's phone.
              pricePaise: i.base_price_paise,
              taxRateBps: i.tax_rate_bps,
              dietaryFlags: i.dietary_flags,
              // Null for every item on the pilot menu — no vendor has uploaded
              // a photograph. The client renders a deterministic tile instead,
              // so this being null is a designed state rather than a gap.
              imageUrl: i.image_url,
              available: state.orderable,
              /**
               * Top three by units sold in seven days. See the query above.
               *
               * A FACT the client renders, not a hint it interprets. If this
               * were `soldLast7Days: number` every screen would have to invent
               * its own threshold, and the customer app and the console would
               * disagree about which dishes are selling.
               */
              bestseller: bestsellers.has(i.id),
              /**
               * THE STALL'S OWN PICK, AND WHY IT IS A SEPARATE FIELD.
               *
               * It would have been less code to fold this into `bestseller`,
               * and it would have destroyed that field. The note above the
               * bestseller query argues that a vendor-editable badge "becomes
               * a badge on everything within a week, which is the same as a
               * badge on nothing" — true, and the remedy is to keep the two
               * apart rather than to refuse the stall a voice.
               *
               * So the client gets both and labels them differently:
               * "Bestseller" is measured, "Must try" is recommended. A
               * customer can tell which is which, which is the entire point.
               *
               * Capped at three per stall by the endpoint that sets it.
               */
              mustTry: i.must_try,
              // The customer is told sold out, never "3 left". A countdown on a
              // menu manufactures urgency, and the number is a race the diner
              // cannot see the other side of.
              unavailableReason: itemReasonCopyKey(state.reason),
            };
          }),
      })),
    };
  }
}
