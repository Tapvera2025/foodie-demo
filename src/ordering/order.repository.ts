/**
 * Order placement — the one transaction that must never be half-done.
 *
 * TDD §6, PRD API-01, ORD-SM-01, LED-01.
 *
 * Everything below happens in a single transaction: the order row, its items,
 * the first status-history row, and every ledger entry. A ledger that can lag
 * the order it describes is a ledger that is sometimes wrong, and the window is
 * precisely when a process dies mid-checkout.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. The client never sets a price. It names menu items and quantities; the
 *    server reads its own prices and reprices. A checkout endpoint that trusts
 *    a client-supplied total is a checkout endpoint that will be sent a total
 *    of zero.
 *
 * 2. The commercial terms are SNAPSHOTTED onto the order. When the commission
 *    changes next month, last week's settlement must not move with it.
 *
 * 3. Retrying with the same idempotency key returns the original order. Not a
 *    second order, and not an error — the customer tapped twice on a bad
 *    connection and deserves the order they already have.
 */

import type { Kysely, Selectable, Transaction } from 'kysely';

import { itemState } from '../catalog/availability.js';
import { serviceDateFor } from '../catalog/service-date.js';
import { config } from '../platform/config.js';
import { AppError } from '../platform/errors.js';
import { paise, type Paise } from '../platform/money.js';
import type { AppSessionTable, Database, Json, VendorTable } from '../platform/schema.js';
import { computeQuote, type Quote } from '../pricing/quote.js';
import type { FeeRule, TaxModel } from '../pricing/fee-engine.js';
import { orderPlacementEntries } from '../ledger/entries.js';

/** node-pg turns a JS object into a Postgres value, not JSON. JSONB needs text. */
const toJsonb = (v: unknown): Json => JSON.stringify(v) as unknown as Json;

export interface PlaceOrderLine {
  readonly menuItemId: string;
  readonly quantity: number;
  /**
   * `| undefined` is load-bearing under `exactOptionalPropertyTypes`. Zod's
   * `.optional()` produces a present-but-undefined property, and without this
   * the parsed body will not assign to the input type.
   */
  readonly instructions?: string | undefined;
}

export interface PlaceOrderInput {
  readonly sessionId: string;
  readonly vendorId: string;
  readonly lines: readonly PlaceOrderLine[];
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/** One basket line, joined to the menu row the server priced it from. */
interface PricedLine {
  readonly line: PlaceOrderLine;
  readonly item: { readonly id: string; readonly name: string; readonly base_price_paise: number };
  readonly lineTotalPaise: Paise;
  readonly taxRateBps: number;
}

/**
 * What `resolve` establishes before anything is written.
 *
 * `vendor.settlement_mode` is non-null here where the table allows null: the
 * check has already run, and carrying the nullable type further would force a
 * redundant guard at the one call site that writes money.
 */
interface ResolvedOrder {
  readonly session: Selectable<AppSessionTable>;
  readonly vendor: Selectable<VendorTable> & { settlement_mode: NonNullable<VendorTable['settlement_mode']> };
  readonly priced: readonly PricedLine[];
  readonly feeRules: FeeRule[];
  readonly taxModel: TaxModel;
  readonly quote: Quote;
}

export interface PlacedOrder {
  readonly id: string;
  readonly publicOrderNumber: string;
  readonly status: string;
  readonly totalPayablePaise: Paise;
  readonly quote: Quote | null;
  /** True when an existing order was returned for a repeated idempotency key. */
  readonly replayed: boolean;
}

/**
 * Order numbers are per-court, per-day and human-sayable, because a customer
 * reads one aloud at a counter. Not the UUID, and not a global sequence — that
 * would tell any competitor placing two orders exactly how many the platform
 * handled in between.
 *
 * The caller must already hold a lock on the food_court row. Counting rows and
 * adding one is a textbook race: two concurrent checkouts both count 6 and both
 * claim A-007, and two customers at different tables are then told to collect
 * the same order. Serialising per court costs throughput the pilot does not
 * need and buys a number nobody has to disambiguate at a busy counter.
 */
/**
 * The trading day an order belongs to.
 *
 * Its own function because two places must agree on it exactly — the number
 * generator and the column stored beside the number — and because "which day is
 * this" is a business rule, not an incidental `new Date()`. A court that trades
 * past midnight would change this and nothing else.
 *
 * Returned as `YYYY-MM-DD` in the SERVER'S LOCAL ZONE, matching the boundary
 * the original counter used, so numbers issued before this change keep the
 * meaning they were issued with.
 */
export function businessDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The next number, from the HIGHEST issued today rather than a count of rows.
 *
 * ============================================================================
 * WHY NOT COUNT
 * ============================================================================
 *
 * It used to be `COUNT(*) + 1` over today's orders, and that is wrong twice.
 *
 * FIRST, ACROSS DAYS. The count resets at midnight; the unique index behind it
 * did not — migration 1 made `(food_court_id, public_order_number)` unique for
 * ever. So the first order of every subsequent day proposed `A-001`, collided
 * with an `A-001` from an earlier day, and threw. It could not recover either:
 * a retry counted zero again and proposed the same number again. Any court that
 * had taken one order stopped being able to take orders at the next midnight.
 * Migration 19 puts the day in the key; this function is the other half.
 *
 * SECOND, WITHIN A DAY, EVEN NOW. A count assumes the numbers issued so far are
 * exactly 1..n with no gaps. One gap — a row removed by hand, a partial restore,
 * anything — and the count points at a number already taken. `MAX + 1` cannot
 * propose an existing number regardless of what the sequence looks like, which
 * makes it right for reasons that do not depend on nothing having gone wrong.
 *
 * The lock the caller holds is still required: `MAX + 1` races exactly as
 * `COUNT + 1` did, and two customers told to collect the same order is the
 * failure that matters at a counter.
 *
 * THE LETTER IS PER-DEPLOYMENT, NOT HARDCODED
 *
 * `ORDER_NUMBER_PREFIX` (config.ts) used to be a literal `'A-'`. Two
 * independent database instances (an always-online system and an offline edge
 * box that syncs to it later) generating numbers independently for the same
 * food court would both propose `A-001` — a collision the unique index cannot
 * catch until the two are merged, because each instance sees itself as the
 * only writer. Giving each instance its own letter makes that impossible
 * rather than merely unlikely: `A-001` and `B-001` are different strings, so
 * they can never collide regardless of when or how the data is combined.
 */
async function nextOrderNumber(trx: Transaction<Database>, foodCourtId: string): Promise<string> {
  const prefix = config().ORDER_NUMBER_PREFIX;

  const row = await trx
    .selectFrom('order')
    .select((eb) => eb.fn.max<string | null>('public_order_number').as('highest'))
    .where('food_court_id', '=', foodCourtId)
    .where('business_date', '=', businessDate())
    .where('public_order_number', 'like', `${prefix}-%`)
    .executeTakeFirst();

  /*
   * A textual MAX is correct only because the number is zero-padded.
   *
   * 'A-002' > 'A-001' lexicographically, and stays correct up to 'A-999'. Past
   * that, `A-1000` sorts BELOW `A-999` and the next number would repeat one —
   * so the padding is not cosmetic and the ceiling is real. A court taking more
   * than 999 orders in a day needs a wider format, and would rather find that
   * out here than at the counter.
   */
  const highest = row?.highest ?? null;
  const n = highest ? Number(highest.slice(prefix.length + 1)) : 0;

  if (!Number.isFinite(n)) {
    throw new AppError(
      'RECONCILIATION_REQUIRED',
      `Cannot read the last order number ("${String(highest)}") for this court today.`,
    );
  }

  if (n >= 999) {
    throw new AppError(
      'RECONCILIATION_REQUIRED',
      `This court has issued 999 order numbers today; the ${prefix}-000 format is exhausted.`,
    );
  }

  return `${prefix}-${String(n + 1).padStart(3, '0')}`;
}

export class OrderRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Price a basket without placing it, for the checkout preview.
   *
   * Runs `placeOrder`'s exact validation and pricing and then rolls back, on
   * purpose. A preview computed by a second, simpler function is a preview
   * that eventually disagrees with the invoice — and the customer sees that
   * disagreement at the worst possible moment, on the payment screen.
   *
   * It also means a sold-out item or a closed stall fails here, before the
   * customer has committed to anything.
   */
  async priceOnly(input: Omit<PlaceOrderInput, 'idempotencyKey' | 'correlationId'>): Promise<{
    subtotalPaise: Paise;
    foodTaxPaise: Paise;
    customerFeePaise: Paise;
    customerFeeTaxPaise: Paise;
    totalPayablePaise: Paise;
  }> {
    const q = await this.db.transaction().execute(async (trx) => {
      const ctx = await this.resolve(trx, input);
      return ctx.quote;
    });

    return {
      subtotalPaise: q.subtotalPaise,
      foodTaxPaise: q.foodTaxPaise,
      customerFeePaise: q.customerFeePaise,
      customerFeeTaxPaise: q.customerFeeTaxPaise,
      totalPayablePaise: q.totalPayablePaise,
    };
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlacedOrder> {
    return this.db.transaction().execute(async (trx) => {
      // --- idempotency first, before any work ------------------------------
      // Checked inside the transaction AND backed by a unique index. The check
      // alone races: two concurrent retries both see nothing and both insert.
      // The index is what actually prevents the second order; this lookup just
      // turns the common case into a clean replay instead of a 409.
      const existing = await trx
        .selectFrom('order')
        .select(['id', 'public_order_number', 'status', 'total_payable_paise', 'customer_id'])
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();

      /*
       * ====================================================================
       * A REPLAY MUST BELONG TO THE CUSTOMER ASKING FOR IT
       * ====================================================================
       *
       * This looked up the key and returned whatever it found. The key is a
       * client-generated UUID held in the basket, which `partialize` PERSISTS
       * to localStorage and `endCheckout()` clears only on success — so a
       * checkout that failed anywhere after placement leaves a live key in the
       * browser pointing at a real order.
       *
       * The customer token, by contrast, lives in memory and is gone on reload.
       * So the ordinary sequence "checkout failed, reload, verify again, try
       * again" ends with a stale key replaying an order that may belong to a
       * different customer row — and the response carries that order's public
       * number and total.
       *
       * It also produced the symptom that led here: placement replayed
       * somebody else's order id, and every scoped call afterwards answered
       *
       *     TENANT_SCOPE_VIOLATION  "No such order"
       *
       * which is the tenancy rule working correctly two steps too late.
       *
       * 404 rather than 403, per PRD §16.3 and every other check in this file:
       * a distinguishable status confirms the order exists.
       */
      if (existing) {
        /*
         * The session's customer, fetched here rather than taken from the full
         * `resolve()` below — that runs pricing, stock and opening-hours checks
         * and is deliberately AFTER this early return, because the whole point
         * of a replay is not to redo any of it.
         *
         * One indexed lookup by primary key is the right price for closing a
         * tenancy hole.
         */
        const asking = await trx
          .selectFrom('app_session')
          .select('customer_id')
          .where('id', '=', input.sessionId)
          .executeTakeFirst();

        if (!asking || existing.customer_id !== asking.customer_id) {
          throw new AppError('TENANT_SCOPE_VIOLATION', 'No such order');
        }
      }

      if (existing) {
        return {
          id: existing.id,
          publicOrderNumber: existing.public_order_number,
          status: existing.status,
          totalPayablePaise: paise(existing.total_payable_paise),
          quote: null,
          replayed: true,
        };
      }

      const { session, vendor, priced, feeRules, taxModel, quote } = await this.resolve(trx, input);

      // --- write ------------------------------------------------------------
      // Serialises order numbering within this court for the rest of the
      // transaction. See nextOrderNumber for why counting without it is wrong.
      await trx
        .selectFrom('food_court')
        .select('id')
        .where('id', '=', session.food_court_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const order = await trx
        .insertInto('order')
        .values({
          public_order_number: await nextOrderNumber(trx, session.food_court_id),
          // Stored, not derived: the unique index keys on it, and an index
          // cannot use an expression whose value depends on the session's
          // TimeZone. See migration 19.
          business_date: businessDate(),
          app_session_id: session.id,
          customer_id: session.customer_id,
          food_court_id: session.food_court_id,
          vendor_id: input.vendorId,
          // Usually null: a food-court customer collects at the counter and
          // is identified by the order number, not by where they sat.
          court_table_id: session.court_table_id,
          settlement_mode_snapshot: quote.settlementModeSnapshot,
          fee_rule_snapshot: toJsonb(feeRules),
          tax_model_snapshot: toJsonb(taxModel),
          subtotal_paise: quote.subtotalPaise,
          food_tax_paise: quote.foodTaxPaise,
          customer_fee_paise: quote.customerFeePaise,
          customer_fee_tax_paise: quote.customerFeeTaxPaise,
          total_payable_paise: quote.totalPayablePaise,
          vendor_commission_paise: quote.distribution.vendorCommissionPaise,
          operator_share_paise: quote.distribution.operatorSharePaise,
          platform_tax_reserve_paise: quote.distribution.platformTaxReservePaise,
          vendor_net_paise: quote.distribution.vendorNetPaise,
          idempotency_key: input.idempotencyKey,
          correlation_id: input.correlationId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const p of priced) {
        await trx
          .insertInto('order_item')
          .values({
            order_id: order.id,
            menu_item_id: p.item.id,
            name_snapshot: p.item.name,
            unit_price_paise_snapshot: p.item.base_price_paise,
            quantity: p.line.quantity,
            line_total_paise: p.lineTotalPaise,
            tax_rate_bps_snapshot: p.taxRateBps,
            instructions: p.line.instructions ?? null,
          })
          .execute();
      }

      // PRD ORD-SM-04: status is never assigned without a history row. Both in
      // this transaction, so the order can always be reconstructed from events.
      await trx
        .insertInto('order_status_history')
        .values({
          order_id: order.id,
          from_status: null,
          to_status: 'CREATED',
          actor_type: 'CUSTOMER',
          correlation_id: input.correlationId,
        })
        .execute();

      for (const e of orderPlacementEntries(quote)) {
        await trx
          .insertInto('ledger_entry')
          .values({
            order_id: order.id,
            vendor_id: e.party === 'VENDOR' ? input.vendorId : null,
            food_court_id: session.food_court_id,
            entry_type: e.entryType,
            party: e.party,
            direction: e.direction,
            amount_paise: e.amountPaise,
            authority: vendor.settlement_mode === 'PLATFORM_COLLECT' ? 'AUTHORITATIVE' : 'ADVISORY',
            correlation_id: input.correlationId,
          })
          .execute();
      }

      return {
        id: order.id,
        publicOrderNumber: order.public_order_number,
        status: order.status,
        totalPayablePaise: paise(order.total_payable_paise),
        quote,
        replayed: false,
      };
    });
  }


  /**
   * Everything between "who is asking" and "what does it cost", shared by
   * `priceOnly` and `placeOrder` so the preview and the invoice cannot drift.
   *
   * Throws on every condition that should stop an order: dead session, closed
   * or blocked vendor, item from another stall, sold-out item, bad quantity.
   */
  private async resolve(
    trx: Transaction<Database>,
    input: Omit<PlaceOrderInput, 'idempotencyKey' | 'correlationId'>,
  ): Promise<ResolvedOrder> {
    if (input.lines.length === 0) {
      throw new AppError('OPTION_RULE_VIOLATION', 'An order must contain at least one item');
    }

      // --- the session, and the court it is bound to -----------------------
      // The court's timezone comes along because the stock check needs to know
      // which service day this is, and 23:30 in Mumbai is a different UTC date
      // from the day the kitchen thinks it is still working.
      const session = await trx
        .selectFrom('app_session')
        .innerJoin('food_court', 'food_court.id', 'app_session.food_court_id')
        .selectAll('app_session')
        .select('food_court.timezone as timezone')
        .where('app_session.id', '=', input.sessionId)
        .executeTakeFirst();

      if (!session) throw new AppError('SESSION_EXPIRED', 'No such session');
      if (session.expires_at.getTime() <= Date.now()) {
        throw new AppError('SESSION_EXPIRED', 'This session has expired. Rescan the QR code.');
      }

      /**
       * An order must belong to somebody. PRD §11.2, DR-0001.
       *
       * The controller guard is the gate; this is the invariant. `customer_id`
       * is copied from the session a few lines below, and an anonymous session
       * would write a NULL — an order with no phone to notify, no identity at
       * the counter and no refund route. That is exactly what happened while
       * the only enforcement was the PWA asking politely.
       *
       * Stated here as well as at the edge because this method is reachable
       * from scripts and from any future endpoint, and the guard is not.
       */
      if (session.customer_id === null) {
        throw new AppError(
          'TOKEN_INVALID',
          'This order has no verified customer. Verify a mobile number before ordering.',
        );
      }

      // --- the vendor must be able to take the order -----------------------
      // FOR UPDATE: the row is read and then relied upon for the rest of the
      // transaction. Without the lock a manager could suspend the vendor
      // between this check and the insert.
      const vendor = await trx
        .selectFrom('vendor')
        .selectAll()
        .where('id', '=', input.vendorId)
        .where('food_court_id', '=', session.food_court_id)
        .forUpdate()
        .executeTakeFirst();

      // 404, not 403. A vendor in another food court must be indistinguishable
      // from one that does not exist — PRD TENANT-01.
      if (!vendor) throw new AppError('TENANT_SCOPE_VIOLATION', 'No such vendor in this food court');
      if (vendor.status !== 'ACTIVE') throw new AppError('VENDOR_CLOSED', `${vendor.name} is closed`);
      if (vendor.temp_closed_until && vendor.temp_closed_until.getTime() > Date.now()) {
        throw new AppError('VENDOR_CLOSED', `${vendor.name} has paused orders`);
      }
      if (vendor.dispatch_blocked_at) {
        throw new AppError('VENDOR_DISPATCH_BLOCKED', `${vendor.name} cannot receive orders`);
      }
      if (!vendor.settlement_mode) {
        // The CHECK constraint should make this unreachable. If it fires, the
        // schema and the code disagree and no money should move.
        throw new AppError('RECONCILIATION_REQUIRED', 'Vendor has no settlement mode');
      }

      /*
       * ====================================================================
       * A STALL WE CANNOT PAY MUST NOT BE ABLE TO TAKE MONEY
       * ====================================================================
       *
       * Under PLATFORM_COLLECT the customer pays Cashfree and Easy Split
       * routes the stall its share to a linked account. With no
       * `cashfree_vendor_id` there is no account to route to — and the
       * failure is not an error, it is SILENCE: the payment succeeds, the
       * food is made, and the stall's share stays in the platform's Cashfree
       * balance with nothing recording that it should not be there.
       *
       * Nobody notices until a settlement report weeks later, by which point
       * a stall has been trading on money it never received. That is the most
       * expensive thing this system can do, so it is refused at the earliest
       * possible moment — before an order exists, rather than at the payment
       * intent where the customer has already committed.
       *
       * `buildSplit` refuses too, for the same reason and later. Two guards
       * because this one keeps a customer from starting, and that one keeps a
       * second caller from bypassing this.
       *
       * VENDOR_DIRECT needs no account: the money never reaches us, and
       * commission is invoiced against the ledger afterwards.
       */
      if (vendor.settlement_mode === 'PLATFORM_COLLECT' && !vendor.provider_linked_account_id) {
        throw new AppError(
          'RECONCILIATION_REQUIRED',
          `${vendor.name} is not set up to receive payouts yet`,
        );
      }

      // --- prices come from OUR menu, never from the request ---------------
      const menuItems = await trx
        .selectFrom('menu_item')
        .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
        .select([
          'menu_item.id',
          'menu_item.name',
          'menu_item.base_price_paise',
          'menu_item.tax_rate_bps',
          'menu_item.status',
          'menu_item.availability',
          'menu_item.inventory_mode',
          'menu_item.available_from',
          'menu.vendor_id',
        ])
        .where(
          'menu_item.id',
          'in',
          input.lines.map((l) => l.menuItemId),
        )
        .execute();

      const byId = new Map(menuItems.map((m) => [m.id, m]));

      // Stock, for TRACKED lines only, read inside the same transaction as the
      // insert. This is a CHECK, not a deduction — PRD §6.1 deducts on payment
      // confirmation, and the count itself is derived from confirmed orders, so
      // there is nothing here to decrement.
      //
      // It does NOT hold a lock across the payment redirect. Two customers can
      // both pass this gate on the last portion and one of them will be
      // rejected by the kitchen with a reason. That is the honest failure: a
      // row lock held from checkout until a UPI app returns is a lock held
      // across a human being deciding whether to pay.
      const trackedIds = input.lines
        .map((l) => byId.get(l.menuItemId))
        .filter((m) => m?.inventory_mode === 'TRACKED')
        .map((m) => m!.id);

      const remainingById = new Map<string, number>();
      if (trackedIds.length > 0) {
        const rows = await trx
          .selectFrom('v_menu_item_stock_remaining')
          .select(['menu_item_id', 'remaining'])
          .where('menu_item_id', 'in', trackedIds)
          .where('service_date', '=', serviceDateFor(new Date(), session.timezone))
          .execute();
        for (const r of rows) remainingById.set(r.menu_item_id, r.remaining);
      }

      for (const line of input.lines) {
        const item = byId.get(line.menuItemId);
        if (!item) throw new AppError('ITEM_UNAVAILABLE', 'An item is no longer on the menu');
        // The single-vendor invariant, by construction: an order has one
        // vendor_id, and every item must belong to it.
        if (item.vendor_id !== input.vendorId) {
          throw new AppError('CROSS_VENDOR_CART', 'All items must come from one vendor');
        }

        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 50) {
          throw new AppError('OPTION_RULE_VIOLATION', 'Quantity must be between 1 and 50');
        }

        // The same pure function the customer menu used to grey the item out.
        // If these two ever disagree, a customer is shown an item they cannot
        // buy or refused one they can — and the second is the worse bug,
        // because it happens after they have chosen.
        const state = itemState(
          {
            status: item.status,
            availability: item.availability,
            availableFrom: item.available_from,
            inventoryMode: item.inventory_mode,
            // The quantity being ordered has to fit, not merely one of it.
            remaining: (remainingById.get(item.id) ?? 0) - line.quantity + 1,
          },
          new Date(),
        );

        if (!state.orderable) {
          throw new AppError(
            'ITEM_UNAVAILABLE',
            state.reason === 'DISCONTINUED'
              ? 'An item is no longer on the menu'
              : `${item.name} is not available right now`,
          );
        }
      }

      const feeRules = await this.loadFeeRules(trx, session.food_court_id, input.vendorId);
      const taxModel = this.taxModel();

      const priced = input.lines.map((line) => {
        const item = byId.get(line.menuItemId)!;
        return {
          line,
          item,
          lineTotalPaise: paise(item.base_price_paise * line.quantity),
          taxRateBps: item.tax_rate_bps,
        };
      });

      const quote = computeQuote({
        lines: priced.map((p) => ({ lineTotalPaise: p.lineTotalPaise, taxRateBps: p.taxRateBps })),
        feeRules,
        taxModel,
        settlementMode: vendor.settlement_mode,
      });

    // Re-attach the narrowed value explicitly. TypeScript narrows
    // `vendor.settlement_mode` at the guard above, but an object literal uses
    // the variable's DECLARED type, so `{ vendor }` would still be nullable.
    return {
      session,
      vendor: { ...vendor, settlement_mode: vendor.settlement_mode },
      priced,
      feeRules,
      taxModel,
      quote,
    };
  }

  /**
   * Most specific rule wins: VENDOR beats FOOD_COURT beats PLATFORM_DEFAULT.
   * Only rules in force right now — a rule with an `effective_to` in the past
   * must not price a new order, and one dated in the future must not either.
   */
  private async loadFeeRules(
    trx: Transaction<Database>,
    foodCourtId: string,
    vendorId: string,
  ): Promise<FeeRule[]> {
    const rows = await trx
      .selectFrom('fee_rule')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('scope', '=', 'PLATFORM_DEFAULT'),
          eb.and([eb('scope', '=', 'FOOD_COURT'), eb('food_court_id', '=', foodCourtId)]),
          eb.and([eb('scope', '=', 'VENDOR'), eb('vendor_id', '=', vendorId)]),
        ]),
      )
      .where('effective_from', '<=', new Date())
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', new Date())]))
      .execute();

    const rank = { VENDOR: 3, FOOD_COURT: 2, PLATFORM_DEFAULT: 1 } as const;
    const best = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const current = best.get(r.party);
      if (!current || rank[r.scope] > rank[current.scope]) best.set(r.party, r);
    }

    return [...best.values()].map((r) => ({
      id: r.id,
      scope: r.scope,
      party: r.party,
      feeType: r.fee_type,
      // Spread-or-omit, not `?? undefined`. `exactOptionalPropertyTypes`
      // distinguishes "absent" from "present and undefined", and FeeRule
      // declares these as plain optionals. Widening FeeRule to accept
      // `| undefined` would weaken a pricing type to suit a database mapping.
      ...(r.rate_bps !== null ? { rateBps: r.rate_bps } : {}),
      ...(r.amount_paise !== null ? { amountPaise: paise(r.amount_paise) } : {}),
      minFloorPaise: paise(r.min_floor_paise),
      ...(r.max_cap_paise !== null ? { maxCapPaise: paise(r.max_cap_paise) } : {}),
      taxRateBps: r.tax_rate_bps,
      allowedModes: r.allowed_modes,
      version: r.version,
    }));
  }

  /**
   * From validated config, never from raw `process.env`.
   *
   * `process.env.X === 'true'` silently reads a missing variable as `false`,
   * which for this particular flag means quietly settling the food GST to the
   * vendor while the platform still owes it. `config()` has already refused to
   * boot if the determination is absent, so by the time this runs the value is
   * a real decision rather than a default. PRD §4.7.
   */
  private taxModel(): TaxModel {
    const cfg = config();
    return {
      section9_5Applies: cfg.TAX_SECTION_9_5_APPLIES,
      feeGstBps: cfg.TAX_FEE_GST_BPS,
    };
  }
}
