/**
 * Availability and inventory, from the vendor's side.
 *
 * PRD §6 gave these separate columns; this gives them separate endpoints,
 * because they are separate acts:
 *
 *   PUT  /items/:id/availability   "we're out of chicken rolls"     stock.toggle
 *   PUT  /items/:id/stock          "tomorrow we have 100"           inventory.write
 *   GET  /items                    what the kitchen has left today
 *   POST /pause                    "stop sending us orders"         vendor.ordering.toggle
 *   GET  /status                   are we taking orders right now
 *
 * One endpoint for both would mean a cook who can mark an item sold out can
 * also set the day's stock to zero. Those look identical to the customer and
 * completely different in the stock history.
 *
 * THE PAUSE HAD A PERMISSION, A COLUMN, AND NO WAY IN.
 *
 * `vendor.ordering.toggle` has been in the matrix since the RBAC work, and
 * `vendor.temp_closed_until` is read in three places — order placement rejects
 * against it, the stall list renders "Paused" from it, and the KDS reads it for
 * the banner. Nothing could write it. Every one of those readers was branching
 * on a value that was permanently null: a switch wired at both ends and missing
 * from the middle, which §2.2 calls a check whose failure mode is silence.
 */

import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { currentCorrelationId } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { storage } from '../platform/storage/index.js';
import { grantFor } from '../identity/permissions.js';
import { CatalogBroadcastInterceptor } from '../realtime/catalog-broadcast.interceptor.js';
import { StaffGuard, staffOf, vendorScopeOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { itemState } from './availability.js';
import { serviceDateFor } from './service-date.js';

/**
 * Three, and the number is the design rather than a detail.
 *
 * Two is too few for a stall with a genuinely varied menu; five stops reading
 * as "these ones". Defined here, next to the endpoint that enforces it, so the
 * cap and its enforcement cannot drift apart — and referenced by name in the
 * error message so a cook is told the actual rule.
 */
const MUST_TRY_LIMIT = 3;

const MustTryBody = z.object({ mustTry: z.boolean() });

const AvailabilityBody = z.object({
  availability: z.enum(['AVAILABLE', 'SOLD_OUT', 'TEMPORARILY_UNAVAILABLE']),
  /**
   * When it should come back. Optional: omitted means "until someone says
   * otherwise", and the sweeper still clears it at the next service day.
   */
  availableFrom: z.string().datetime().optional(),
});

const StockBody = z.object({
  dailyStock: z.number().int().min(0).max(100_000),
  note: z.string().max(280).optional(),
});

/**
 * Which image, so the server can pick the folder and the transformation.
 *
 * An enum and not a path. A free-text folder would let a caller write into
 * another stall's directory, and the folder is how an image is later traced to
 * the stall that owns it.
 */
const SignUploadBody = z.object({
  kind: z.enum(['dish', 'stall-cover', 'stall-logo', 'offer']),
});

/**
 * The carousel offer, as a pair that cannot come apart.
 *
 * `imageUrl: null` clears both. The database CHECK refuses an image with no
 * headline — the headline is the alt text, and an offer that exists only as
 * artwork is invisible to a screen reader and to anybody whose image never
 * loaded, which in a basement food court is common rather than exotic.
 */
/**
 * The stall's own banner.
 *
 * Nullable, because removing one is a thing an owner does — a seasonal
 * photograph that is now wrong is worse than no photograph.
 */
const CoverBody = z.object({
  imageUrl: z.string().url().max(2048).nullable(),
});

const OfferBody = z.object({
  imageUrl: z.string().url().max(2048).nullable(),
  headline: z.string().trim().min(1).max(80),
});

/**
 * A pause has a length. It is not a toggle.
 *
 * "Stop taking orders" with no end is the setting somebody flips during a rush
 * and finds still on the next morning — the stall shows as closed, sells
 * nothing, and nobody can see why because the switch is on a tablet in the
 * back. Every real use of this has a duration: the fryer is down for twenty
 * minutes, we are slammed for ten.
 *
 * `0` is the way back: an explicit resume, rather than a second switch that can
 * disagree with the first.
 */
const PauseBody = z.object({
  minutes: z.number().int().min(0).max(240),
  reason: z.string().trim().max(200).optional(),
});

@Controller('api/v1/vendor')
@UseGuards(StaffGuard)
/*
  Every successful write on this controller broadcasts `catalog.changed` to the
  stall and its court. Applied at the CLASS, not per method, so an endpoint
  added later is covered by existing code rather than by remembering — see the
  interceptor for why the catalogue has no choke point of its own.
*/
@UseInterceptors(CatalogBroadcastInterceptor)
export class InventoryController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /**
   * The vendor this caller may act for, and whether they hold the permission.
   *
   * Both, together, because they fail differently: no vendor scope is a
   * manager on the wrong screen, and no permission is a cook reaching past
   * their job. Checked here rather than in the guard — a guard that means
   * "logged in" is how every authenticated user quietly gains everything.
   */
  private scope(
    req: RequestWithStaff,
    // `menu.write` joins the list for the offer banner. It is owner-only, the
    // same bar as changing a price — a carousel banner is a claim about this
    // stall's pricing on the most prominent screen in the customer app.
    permission: 'stock.toggle' | 'inventory.write' | 'vendor.ordering.toggle' | 'menu.write',
  ): string {
    const principal = staffOf(req);
    const vendorId = vendorScopeOf(principal);
    if (!vendorId) {
      throw new AppError('TENANT_SCOPE_VIOLATION', 'This account is not attached to a stall.');
    }

    const permitted = principal.roles.some((r) => grantFor(permission, r.role) !== undefined);
    if (!permitted) {
      // 404-shaped rather than 403 would be wrong here: the caller is inside
      // their own tenant and is simply not allowed. There is nothing to hide.
      throw new AppError('ACCOUNT_SUSPENDED', 'Your account cannot change this.');
    }
    return vendorId;
  }

  /** The item, if it belongs to this vendor. 404 either way — PRD TENANT-01. */
  private async ownedItem(
    vendorId: string,
    itemId: string,
  ): Promise<{ id: string; name: string; timezone: string }> {
    const row = await this.db
      .selectFrom('menu_item')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select(['menu_item.id as id', 'menu_item.name as name', 'food_court.timezone as timezone'])
      .where('menu_item.id', '=', itemId)
      .where('menu.vendor_id', '=', vendorId)
      .executeTakeFirst();

    if (!row) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such item');
    return row;
  }

  // =========================================================================
  // The stall itself — taking orders, or not
  // =========================================================================

  /**
   * Whether this stall is accepting orders, and why not if it is not.
   *
   * THREE THINGS CAN STOP A STALL, AND THEY ARE NOT THE SAME.
   *
   *   paused    the kitchen said so. Reversible here, has an end time.
   *   blocked   the escalation ladder stopped it for not acknowledging orders.
   *             NOT clearable from this screen — it clears when the stall
   *             starts acknowledging again, and a button to dismiss it would
   *             let a stall that cannot see its tickets keep taking orders.
   *   closed    the stall is not ACTIVE. A platform decision, not a kitchen one.
   *
   * Returned as three separate fields rather than one enum because the kitchen
   * needs to know which applies — the remedy differs completely — and because
   * more than one can be true at once.
   */
  @Get('status')
  async status(@Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'stock.toggle');

    const v = await this.db
      .selectFrom('vendor')
      .select([
        'name',
        'status',
        'temp_closed_until',
        'dispatch_blocked_at',
        'kds_last_heartbeat_at',
        'offer_uploads_enabled',
        'offer_image_url',
        'offer_headline',
        'offer_slot_requested_at',
        'offer_slot_decided_at',
        'cover_image_url',
      ])
      .where('id', '=', vendorId)
      .executeTakeFirstOrThrow();

    const now = Date.now();
    const pausedUntil =
      v.temp_closed_until && v.temp_closed_until.getTime() > now ? v.temp_closed_until : null;

    /**
     * Whether this caller may edit the menu, decided by the SERVER.
     *
     * The alternative is the client decoding the `rol` claim and deciding for
     * itself, which is two implementations of one rule — and the client's copy
     * is the one that drifts. This is a hint for rendering only; every write
     * endpoint checks `menu.write` again regardless, so a client that lied
     * about it would get a 403 rather than an edit.
     */
    const canEditMenu = staffOf(req).roles.some(
      (r) => grantFor('menu.write', r.role) !== undefined,
    );

    return {
      name: v.name,
      vendorStatus: v.status,
      canEditMenu,
      pausedUntil: pausedUntil?.toISOString() ?? null,
      pausedMinutesLeft: pausedUntil
        ? Math.max(1, Math.ceil((pausedUntil.getTime() - now) / 60_000))
        : 0,
      dispatchBlocked: v.dispatch_blocked_at !== null,
      acceptingOrders: v.status === 'ACTIVE' && pausedUntil === null && v.dispatch_blocked_at === null,
      /**
       * The carousel slot. GRANTED by the platform, FILLED by this stall.
       *
       * Sent even when false, so the board can say "the platform has not given
       * you a slot" rather than simply not showing the control. A missing
       * feature with no explanation gets asked about; a disabled one with a
       * sentence does not.
       */
      offerUploadsEnabled: v.offer_uploads_enabled,
      offerImageUrl: v.offer_image_url,
      offerHeadline: v.offer_headline,
      /** The stall's own banner. Null until somebody uploads one. */
      coverImageUrl: v.cover_image_url,
      /**
       * Four states, not two, and the board says something different for each.
       *
       *   granted    the slot is theirs
       *   requested  asked, nobody has answered
       *   declined   asked, the office said no
       *   none       never asked
       *
       * Collapsing the middle two is what makes a stall ask every week into
       * what feels like silence. `decided_at` without `requested_at` is a
       * decline; both null is a stall that has never asked.
       */
      offerSlotRequestedAt: v.offer_slot_requested_at?.toISOString() ?? null,
      offerSlotDecidedAt: v.offer_slot_decided_at?.toISOString() ?? null,
    };
  }

  /**
   * Ask the platform for a carousel slot.
   *
   * `menu.write`, so owner-only — this is a commercial request about how the
   * stall is promoted, not a service-time action a cook should be making.
   *
   * IDEMPOTENT, and that matters more than it looks. A stall that taps twice
   * must not queue two requests for one console operator to work through, and
   * re-asking must not reset the clock on a request already waiting — otherwise
   * the oldest request in the queue is whoever has been most patient about not
   * pressing the button again.
   */
  @Post('offer/request')
  async requestOfferSlot(@Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'menu.write');

    const v = await this.db
      .selectFrom('vendor')
      .select(['offer_uploads_enabled', 'offer_slot_requested_at'])
      .where('id', '=', vendorId)
      .executeTakeFirstOrThrow();

    // Nothing to ask for. A database CHECK refuses this pair anyway; refusing
    // here says why rather than surfacing a constraint name.
    if (v.offer_uploads_enabled) {
      throw new AppError('INVALID_TRANSITION', 'This stall already has a slot.');
    }

    if (v.offer_slot_requested_at === null) {
      await this.db
        .updateTable('vendor')
        .set({ offer_slot_requested_at: new Date() })
        .where('id', '=', vendorId)
        // Re-checked in the UPDATE, so two taps racing cannot both write.
        .where('offer_slot_requested_at', 'is', null)
        .execute();

      log().info(
        { event: 'offer_slot_requested', vendorId },
        'a stall asked for a carousel slot',
      );
    }

    return { requested: true };
  }

  /**
   * Authorise one image upload, and hand back a signature.
   *
   * ==========================================================================
   * THIS IS THE PERMISSION CHECK. THE UPLOAD ITSELF HAS NONE.
   * ==========================================================================
   *
   * The browser sends the file straight to the storage provider, which knows
   * nothing about stalls, roles or courts — it checks only that the signature
   * matches. So everything that decides whether this upload should happen at
   * all happens here, in the ten lines below, and the signature is the token
   * that says it did.
   *
   * Two consequences worth stating:
   *
   *   The FOLDER is derived from the caller's own vendor scope, never from the
   *   request. A caller that could name its folder could write into another
   *   stall's, and the folder is how an image is later traced or removed.
   *
   *   The `offer` scope additionally requires the platform's grant, the same
   *   check `PUT /vendor/offer` makes. Signing an upload for a stall that
   *   cannot use it would waste the vendor's data and leave an orphan in the
   *   account that nothing references.
   *
   * `menu.write`, so owner-only. Uploading a photograph of the food is a
   * decision about how the stall presents itself, not a service-time action.
   */
  @Post('uploads/sign')
  async signUpload(@Body() body: unknown, @Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'menu.write');
    const { kind } = SignUploadBody.parse(body);

    if (kind === 'offer') {
      const v = await this.db
        .selectFrom('vendor')
        .select('offer_uploads_enabled')
        .where('id', '=', vendorId)
        .executeTakeFirstOrThrow();

      if (!v.offer_uploads_enabled) {
        throw new AppError(
          'TOKEN_INVALID',
          'This stall has not been given an offer slot. Ask the food court office.',
        );
      }
    }

    // Throws with a message naming the missing variables when storage is not
    // configured — an operator problem, surfaced where an operator can read it.
    return storage().signUpload({ kind, vendorId });
  }

  /**
   * The stall's own offer artwork.
   *
   * `menu.write`, so owner-only — the same bar as changing a price. A carousel
   * banner is a claim about this stall's pricing on the most prominent screen
   * in the customer app, and a cook mid-service is not who should be making it.
   *
   * REFUSED WITHOUT THE PLATFORM'S GRANT. The check is here and not only in the
   * UI: a stall that could POST its way onto the carousel would take that space
   * from every other stall in the court, and the first one to try would keep it.
   */
  /**
   * ==========================================================================
   * THE STALL'S IDENTITY BANNER
   * ==========================================================================
   *
   * `vendor.cover_image_url` has existed since migration 12 and NOTHING HAS
   * EVER WRITTEN IT. Three places read it, the upload scope `stall-cover` was
   * defined for it, and there was no route by which a value could arrive — so
   * every row held NULL, and every reader fell through to its fallback.
   *
   * On the stall page that fallback is why the banner appeared to change by
   * itself: it resolved to "the first dish with a photograph, ordered by id",
   * so adding a dish, deleting one, or photographing one changed the picture at
   * the top of the stall's page without anybody touching it.
   *
   * `menu.write`, not `stock.toggle`. A cook works the queue; the shopfront is
   * an owner's decision, and it is the same permission that guards the menu
   * itself. Deliberately NOT a console-only setting: the person who knows what
   * the stall looks like is standing in it.
   *
   * NO HEADLINE, unlike the offer banner. This is not a claim about anything —
   * it is a photograph of a shop, and the stall's NAME is already beside it in
   * text. The offer needs alt text because its content is inside the JPEG.
   */
  @Put('cover')
  async setCover(@Body() body: unknown, @Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'menu.write');
    const { imageUrl } = CoverBody.parse(body);

    await this.db
      .updateTable('vendor')
      .set({ cover_image_url: imageUrl })
      .where('id', '=', vendorId)
      .execute();

    log().info(
      { event: 'vendor_cover_updated', vendorId, cleared: imageUrl === null },
      'a stall changed its banner',
    );

    return { coverImageUrl: imageUrl };
  }

  @Put('offer')
  async setOffer(@Body() body: unknown, @Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'menu.write');
    const input = OfferBody.parse(body);

    const v = await this.db
      .selectFrom('vendor')
      .select('offer_uploads_enabled')
      .where('id', '=', vendorId)
      .executeTakeFirstOrThrow();

    if (!v.offer_uploads_enabled) {
      throw new AppError(
        'TOKEN_INVALID',
        'This stall has not been given an offer slot. Ask the food court office.',
      );
    }

    // Clearing takes the headline with it — the database CHECK refuses an image
    // with no headline, and a headline with no image is an offer nobody sees.
    const clearing = input.imageUrl === null;

    await this.db
      .updateTable('vendor')
      .set({
        offer_image_url: clearing ? null : input.imageUrl,
        offer_headline: clearing ? null : input.headline,
      })
      .where('id', '=', vendorId)
      .execute();

    log().info(
      { event: 'vendor_offer_updated', vendorId, cleared: clearing },
      'a stall changed its carousel offer',
    );

    return { offerImageUrl: clearing ? null : input.imageUrl, offerHeadline: clearing ? null : input.headline };
  }

  /**
   * Pause, or resume.
   *
   * Writes `temp_closed_until`, which `order.repository.placeOrder` already
   * checks and refuses against, and which the customer stall list already
   * renders as "Paused". Nothing downstream needed changing — the readers were
   * all written and waiting.
   *
   * DOES NOT TOUCH `dispatch_blocked_at`. A stall blocked by the escalation
   * ladder is a stall that stopped acknowledging orders, and resuming here must
   * not clear that: the remedy for being blocked is to accept the tickets
   * already waiting, not to press a button saying you are fine.
   */
  @Post('pause')
  async pause(@Req() req: RequestWithStaff, @Body() body: unknown): Promise<unknown> {
    const vendorId = this.scope(req, 'vendor.ordering.toggle');
    const { minutes, reason } = PauseBody.parse(body);

    const until = minutes === 0 ? null : new Date(Date.now() + minutes * 60_000);

    await this.db
      .updateTable('vendor')
      .set({ temp_closed_until: until })
      .where('id', '=', vendorId)
      .execute();

    log().warn(
      {
        event: minutes === 0 ? 'vendor_resumed' : 'vendor_paused',
        vendorId,
        minutes,
        reason: reason ?? null,
        correlationId: currentCorrelationId(),
      },
      minutes === 0
        ? 'a stall resumed taking orders'
        : 'a stall paused new orders — customers now see it as closed',
    );

    return {
      pausedUntil: until?.toISOString() ?? null,
      pausedMinutesLeft: minutes,
      acceptingOrders: until === null,
    };
  }

  // =========================================================================
  // Availability — the fast switch
  // =========================================================================

  @Put('items/:itemId/availability')
  async setAvailability(
    @Req() req: RequestWithStaff,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const vendorId = this.scope(req, 'stock.toggle');
    const item = await this.ownedItem(vendorId, itemId);
    const { availability, availableFrom } = AvailabilityBody.parse(body);

    // The database constraint refuses AVAILABLE with a future available_from,
    // so this is not belt-and-braces — the write fails without it. Clearing on
    // the way back to AVAILABLE is what makes "back on the menu" mean it.
    const from = availability === 'AVAILABLE' ? null : (availableFrom ?? null);

    await this.db
      .updateTable('menu_item')
      .set({ availability, available_from: from === null ? null : new Date(from) })
      .where('id', '=', item.id)
      .execute();

    return { itemId: item.id, name: item.name, availability, availableFrom: from };
  }

  // =========================================================================
  // Must try — the stall's own recommendation
  // =========================================================================

  /**
   * ==========================================================================
   * A COOK'S PICK, CAPPED AT THREE, ENFORCED UNDER A LOCK
   * ==========================================================================
   *
   * NOT the same thing as the "Bestseller" badge. That one is computed in
   * `discovery.controller.ts` from units actually sold and nobody can edit it —
   * the note there explains why, and this endpoint does not touch it.
   *
   * This is the stall saying "if you only try one thing, try this". It is real
   * information a sales count cannot produce: a dish launched yesterday has no
   * history, and the thing a kitchen is proud of is not always its highest
   * seller.
   *
   * ---------------------------------------------------------------------------
   * THE CAP, AND WHY IT IS A TRANSACTION RATHER THAN A COUNT
   * ---------------------------------------------------------------------------
   *
   * Three per stall. Without a limit every item gets flagged within a week and
   * the badge means nothing — which is precisely the failure the bestseller
   * note warns about, and the reason that badge was never made editable.
   *
   * The obvious implementation is `SELECT COUNT(*)` then `UPDATE`, and it is
   * wrong: two cooks on two tablets both read 2, both write, and the stall has
   * four. Rare, silent, and it degrades the exact property the cap exists to
   * protect.
   *
   * So the count happens inside a transaction that holds `FOR UPDATE` on the
   * VENDOR row. The vendor is not read for its data — it is the mutex. Any
   * second request for the same stall waits, re-counts and is refused. This is
   * the same mechanism `describe.controller.ts` uses to reserve an AI credit,
   * for the same reason.
   *
   * `menu.write` rather than `stock.toggle`: this is a claim about the stall's
   * food shown on the most-read screen in the customer app, which is the same
   * bar as changing a price or setting the offer banner — not the same bar as
   * marking something sold out for the afternoon.
   */
  @Put('items/:itemId/must-try')
  async setMustTry(
    @Req() req: RequestWithStaff,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const vendorId = this.scope(req, 'menu.write');
    const item = await this.ownedItem(vendorId, itemId);
    const { mustTry } = MustTryBody.parse(body);

    const result = await this.db.transaction().execute(async (trx) => {
      /*
       * The lock. Nothing on the row is used — `id` is selected because a
       * SELECT needs a column. Taking it BEFORE the count is what makes the
       * count trustworthy.
       */
      await trx
        .selectFrom('vendor')
        .select('id')
        .where('id', '=', vendorId)
        .forUpdate()
        .executeTakeFirst();

      const marked = await trx
        .selectFrom('menu_item')
        .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
        .select((e) => e.fn.countAll<string>().as('n'))
        .where('menu.vendor_id', '=', vendorId)
        .where('menu_item.must_try', '=', true)
        .where('menu_item.id', '!=', item.id)
        .executeTakeFirst();

      const others = Number(marked?.n ?? 0);

      /*
       * `!= item.id` above, so re-marking something already marked is a no-op
       * rather than a refusal. A tablet that retries a request it already
       * delivered must not be told the stall is full.
       */
      if (mustTry && others >= MUST_TRY_LIMIT) {
        throw new AppError(
          'MUST_TRY_LIMIT_REACHED',
          `A stall can recommend ${MUST_TRY_LIMIT} dishes. Unmark one first.`,
        );
      }

      await trx
        .updateTable('menu_item')
        .set({ must_try: mustTry })
        .where('id', '=', item.id)
        .execute();

      return { remaining: MUST_TRY_LIMIT - (others + (mustTry ? 1 : 0)) };
    });

    return {
      itemId: item.id,
      name: item.name,
      mustTry,
      /** So the board can say "1 pick left" without a second request. */
      remaining: result.remaining,
      limit: MUST_TRY_LIMIT,
    };
  }

  // =========================================================================
  // Stock — the planning number
  // =========================================================================

  /**
   * Set today's count for one item.
   *
   * Setting a count switches the item to TRACKED. That is the only way to turn
   * tracking on, deliberately: a separate "enable tracking" toggle would let an
   * item be TRACKED with no count, which reads as zero and silently removes it
   * from sale.
   *
   * Nothing is decremented here, now or ever. Remaining is computed from
   * confirmed orders (PRD §6.2), so this number and the orders against it
   * cannot drift apart.
   */
  @Put('items/:itemId/stock')
  async setStock(
    @Req() req: RequestWithStaff,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const vendorId = this.scope(req, 'inventory.write');
    const item = await this.ownedItem(vendorId, itemId);
    const { dailyStock, note } = StockBody.parse(body);
    const actorId = staffOf(req).userId;

    const serviceDate = serviceDateFor(new Date(), item.timezone);

    return this.db.transaction().execute(async (trx) => {
      const previous = await trx
        .selectFrom('menu_item_stock')
        .select('daily_stock')
        .where('menu_item_id', '=', item.id)
        .where('service_date', '=', serviceDate)
        .forUpdate()
        .executeTakeFirst();

      await trx
        .insertInto('menu_item_stock')
        .values({
          menu_item_id: item.id,
          service_date: serviceDate,
          daily_stock: dailyStock,
          set_by: actorId,
        })
        .onConflict((oc) =>
          oc
            .columns(['menu_item_id', 'service_date'])
            .doUpdateSet({ daily_stock: dailyStock, set_by: actorId }),
        )
        .execute();

      // Append-only. "Who set this to zero at 12:40" is a question that gets
      // asked after an argument, and it needs an answer that nobody can edit.
      await trx
        .insertInto('menu_item_stock_history')
        .values({
          menu_item_id: item.id,
          service_date: serviceDate,
          previous_stock: previous?.daily_stock ?? null,
          new_stock: dailyStock,
          actor_type: 'VENDOR_USER',
          actor_id: actorId,
          note: note ?? null,
          correlation_id: currentCorrelationId(),
        })
        .execute();

      await trx
        .updateTable('menu_item')
        .set({ inventory_mode: 'TRACKED' })
        .where('id', '=', item.id)
        .execute();

      const remaining = await trx
        .selectFrom('v_menu_item_stock_remaining')
        .select(['consumed', 'remaining'])
        .where('menu_item_id', '=', item.id)
        .where('service_date', '=', serviceDate)
        .executeTakeFirst();

      return {
        itemId: item.id,
        name: item.name,
        serviceDate,
        dailyStock,
        consumed: remaining?.consumed ?? 0,
        remaining: remaining?.remaining ?? dailyStock,
      };
    });
  }

  // =========================================================================
  // The kitchen's own view
  // =========================================================================

  /**
   * Every item on this stall's menu, with what is left.
   *
   * Includes INACTIVE items, unlike the customer menu — the vendor needs to see
   * what they have discontinued in order to bring it back.
   */
  @Get('items')
  async list(@Req() req: RequestWithStaff): Promise<unknown> {
    const vendorId = this.scope(req, 'stock.toggle');

    const rows = await this.db
      .selectFrom('menu_item')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'menu_item.id as id',
        'menu_item.name as name',
        'menu_item.base_price_paise as price',
        'menu_item.status as status',
        'menu_item.availability as availability',
        'menu_item.inventory_mode as inventoryMode',
        'menu_item.available_from as availableFrom',
        'menu_item.image_url as imageUrl',
        'menu_item.must_try as mustTry',
        'food_court.timezone as timezone',
      ])
      .where('menu.vendor_id', '=', vendorId)
      .orderBy('menu_item.sort_order')
      .orderBy('menu_item.name')
      .execute();

    if (rows.length === 0) return { items: [] };

    const timezone = rows[0]!.timezone;
    const serviceDate = serviceDateFor(new Date(), timezone);

    const stock = await this.db
      .selectFrom('v_menu_item_stock_remaining')
      .select(['menu_item_id', 'daily_stock', 'consumed', 'remaining'])
      .where(
        'menu_item_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('service_date', '=', serviceDate)
      .execute();

    const byItem = new Map(stock.map((s) => [s.menu_item_id, s]));
    const now = new Date();

    return {
      serviceDate,
      items: rows.map((r) => {
        const s = byItem.get(r.id);
        const state = itemState(
          {
            status: r.status,
            availability: r.availability,
            availableFrom: r.availableFrom,
            inventoryMode: r.inventoryMode,
            remaining: s?.remaining ?? null,
          },
          now,
        );

        return {
          id: r.id,
          name: r.name,
          pricePaise: r.price,
          status: r.status,
          availability: r.availability,
          inventoryMode: r.inventoryMode,
          availableFrom: r.availableFrom?.toISOString() ?? null,
          // The owner's editor prefills from this, and the customer menu shows
          // the same URL — one column, two readers, no second source of truth.
          imageUrl: r.imageUrl,
          // Unlike the customer menu, the vendor sees the numbers. They are the
          // ones who have to decide whether to cook more.
          dailyStock: s?.daily_stock ?? null,
          consumed: s?.consumed ?? null,
          remaining: s?.remaining ?? null,
          orderable: state.orderable,
          reason: state.reason,
        };
      }),
    };
  }
}
