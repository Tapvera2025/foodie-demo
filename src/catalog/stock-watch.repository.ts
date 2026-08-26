/**
 * "Tell me when it is back."
 *
 * ============================================================================
 * WHY A SWEEP AND NOT A HOOK
 * ============================================================================
 *
 * The obvious implementation is to fire a notification from wherever stock is
 * written — the cook's SOLD_OUT toggle, the stock-set endpoint, the console's
 * menu import. That is three call sites today, and the fourth one somebody adds
 * next month will not fire, silently, for a feature whose entire failure mode
 * is silence. Nobody notices a notification that was never sent.
 *
 * So this recomputes. Every tick it asks `itemState` about the items somebody
 * is waiting on, using the same pure function the menu and the checkout use,
 * and any route back to orderable is caught for free — including routes that do
 * not exist yet.
 *
 * The cost is latency: up to one tick. For a diner deciding whether to queue at
 * a counter fifteen seconds is not a number they can perceive.
 *
 * ============================================================================
 * WHAT COUNTS AS A RESTOCK, AND WHAT DOES NOT
 * ============================================================================
 *
 * PRD §6 keeps three concepts apart, and an item can become orderable through
 * any of them. Two are restocks and one is not:
 *
 *   inventory raised above zero   YES — it ran out and got topped up
 *   availability back to AVAILABLE  YES — a cook un-marked it; same experience
 *   `available_from` passing      NO  — biryani that only exists after 6pm was
 *                                 never out, it was not yet ON. Notifying would
 *                                 mean a 6pm buzz every day for anyone who ever
 *                                 looked at it once.
 *
 * The third is excluded by refusing to CREATE a watch on an item whose only
 * problem is a scheduled start, rather than by filtering at delivery. A watch
 * that can never legitimately fire should not exist in the table pretending it
 * might.
 */

import type { Kysely } from 'kysely';

import { itemState } from './availability.js';
import { serviceDateFor } from './service-date.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';

/** What the customer's screen needs to render one watch. */
export interface WatchRow {
  id: string;
  menuItemId: string;
  itemName: string;
  vendorId: string;
  vendorName: string;
  /** True once the sweep has seen it come back. */
  restocked: boolean;
  /** Whether the customer has already been shown this one. */
  seen: boolean;
}

/** Why a watch could not be created. A key, not a sentence. */
export type WatchRefusal =
  | 'not_found'
  | 'already_available'
  | 'not_restockable'
  | 'discontinued';

export class StockWatchRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Ask to be told about one item.
   *
   * Idempotent by the unique index rather than by a read-then-write: two taps
   * in the same second are one watch, and checking first would leave a window
   * between the check and the insert that is exactly one round trip wide.
   */
  async watch(
    menuItemId: string,
    sessionId: string,
    customerId: string | null,
    expiresAt: Date,
  ): Promise<{ id: string } | { refused: WatchRefusal }> {
    const item = await this.itemFor(menuItemId);
    if (!item) return { refused: 'not_found' };

    const state = itemState(item.input, new Date());

    // Not on the menu at all. A watch here would wait for something nobody
    // intends to cook again.
    if (state.reason === 'DISCONTINUED') return { refused: 'discontinued' };

    // Already orderable. The button should not have been on screen — but a menu
    // rendered ten seconds ago can be out of date, and answering "it is back,
    // go and order it" is better than recording a watch that fires instantly.
    if (state.orderable) return { refused: 'already_available' };

    /*
     * The scheduled-start case. See the header: this is not a restock, and the
     * refusal is here rather than at delivery so the table never holds a watch
     * that cannot honestly fire.
     */
    if (state.reason === 'TEMPORARILY_UNAVAILABLE' && item.input.availableFrom !== null) {
      return { refused: 'not_restockable' };
    }

    const row = await this.db
      .insertInto('stock_watch')
      .values({
        menu_item_id: menuItemId,
        app_session_id: sessionId,
        customer_id: customerId,
        expires_at: expiresAt,
      })
      .onConflict((oc) =>
        oc.columns(['menu_item_id', 'app_session_id']).doUpdateSet({
          // Re-asking extends the deadline. Somebody still looking at the
          // screen an hour later still wants to know.
          expires_at: expiresAt,
          customer_id: customerId,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    return { id: row.id };
  }

  /** Stop watching. Deletes rather than flags: there is nothing to remember. */
  async unwatch(menuItemId: string, sessionId: string): Promise<void> {
    await this.db
      .deleteFrom('stock_watch')
      .where('menu_item_id', '=', menuItemId)
      .where('app_session_id', '=', sessionId)
      .execute();
  }

  /**
   * Everything this session is waiting on, and everything that came back.
   *
   * Expired rows are filtered rather than deleted here — a read path that
   * writes is a read path that deadlocks under load. The sweep clears them.
   */
  async forSession(sessionId: string): Promise<WatchRow[]> {
    const rows = await this.db
      .selectFrom('stock_watch')
      .innerJoin('menu_item', 'menu_item.id', 'stock_watch.menu_item_id')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .select([
        'stock_watch.id as id',
        'stock_watch.menu_item_id as menuItemId',
        'stock_watch.restocked_at as restockedAt',
        'stock_watch.seen_at as seenAt',
        'menu_item.name as itemName',
        'vendor.id as vendorId',
        'vendor.name as vendorName',
      ])
      .where('stock_watch.app_session_id', '=', sessionId)
      .where('stock_watch.expires_at', '>', new Date())
      .orderBy('stock_watch.created_at', 'desc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      menuItemId: r.menuItemId,
      itemName: r.itemName,
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      restocked: r.restockedAt !== null,
      seen: r.seenAt !== null,
    }));
  }

  /** The customer has been shown these. Scoped to the session that owns them. */
  async markSeen(ids: string[], sessionId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable('stock_watch')
      .set({ seen_at: new Date() })
      .where('id', 'in', ids)
      // TENANT-01 in miniature: a client naming somebody else's watch id
      // changes nothing rather than being told it is not theirs.
      .where('app_session_id', '=', sessionId)
      .where('seen_at', 'is', null)
      .execute();
  }

  /**
   * ==========================================================================
   * THE SWEEP
   * ==========================================================================
   *
   * Returns how many watches it satisfied, for the worker's log.
   */
  async sweep(now = new Date()): Promise<{ restocked: number; expired: number }> {
    // Expired first, so the recompute below does not spend a query on items
    // nobody is waiting for any more.
    const expired = await this.db
      .deleteFrom('stock_watch')
      .where('expires_at', '<=', now)
      .where('restocked_at', 'is', null)
      .executeTakeFirst();

    const pending = await this.db
      .selectFrom('stock_watch')
      .select('menu_item_id')
      .where('restocked_at', 'is', null)
      .distinct()
      .execute();

    if (pending.length === 0) {
      return { restocked: 0, expired: Number(expired.numDeletedRows ?? 0) };
    }

    const ids = pending.map((p) => p.menu_item_id);
    const items = await this.itemsFor(ids);

    const back = items.filter((i) => itemState(i.input, now).orderable).map((i) => i.id);
    if (back.length === 0) {
      return { restocked: 0, expired: Number(expired.numDeletedRows ?? 0) };
    }

    /*
     * ONE STATEMENT, AND THE `restocked_at IS NULL` GUARD IS LOAD-BEARING.
     *
     * Two workers running this at once — which is the normal state of a
     * redeployed service for a few seconds — would otherwise both read NULL and
     * both write, and the customer gets told twice. With the guard the second
     * update matches nothing, because the first one has already moved the row
     * out of the set the WHERE describes.
     */
    const updated = await this.db
      .updateTable('stock_watch')
      .set({ restocked_at: now })
      .where('menu_item_id', 'in', back)
      .where('restocked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();

    const n = Number(updated.numUpdatedRows ?? 0);
    if (n > 0) {
      log().info(
        { event: 'stock_watch_restocked', items: back.length, watches: n },
        'items came back and the diners waiting on them can be told',
      );
    }

    return { restocked: n, expired: Number(expired.numDeletedRows ?? 0) };
  }

  // --------------------------------------------------------------- internals

  private async itemFor(
    id: string,
  ): Promise<{ id: string; input: Parameters<typeof itemState>[0] } | null> {
    const rows = await this.itemsFor([id]);
    return rows[0] ?? null;
  }

  /**
   * The availability inputs for a set of items, remaining counts included.
   *
   * The stock view is keyed by SERVICE DATE, and the service date is the
   * court's, not the server's — a stall open past midnight is still on
   * yesterday's date until it closes. Joining the court through to here rather
   * than assuming `Asia/Kolkata` is what keeps this correct at the second city
   * and at 00:30 in the first one.
   */
  private async itemsFor(
    ids: string[],
  ): Promise<{ id: string; input: Parameters<typeof itemState>[0] }[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .selectFrom('menu_item')
      .innerJoin('menu', 'menu.id', 'menu_item.menu_id')
      .innerJoin('vendor', 'vendor.id', 'menu.vendor_id')
      .innerJoin('food_court', 'food_court.id', 'vendor.food_court_id')
      .select([
        'menu_item.id as id',
        'menu_item.status as status',
        'menu_item.availability as availability',
        'menu_item.available_from as availableFrom',
        'menu_item.inventory_mode as inventoryMode',
        'food_court.timezone as timezone',
      ])
      .where('menu_item.id', 'in', ids)
      .execute();

    const tracked = rows.filter((r) => r.inventoryMode === 'TRACKED');
    const remaining = new Map<string, number>();

    if (tracked.length > 0) {
      // Grouped by timezone, because the service date differs between courts
      // and one query with one date would be wrong for all but one of them.
      const byZone = new Map<string, string[]>();
      for (const r of tracked) {
        const list = byZone.get(r.timezone) ?? [];
        list.push(r.id);
        byZone.set(r.timezone, list);
      }

      for (const [zone, itemIds] of byZone) {
        const stock = await this.db
          .selectFrom('v_menu_item_stock_remaining')
          .select(['menu_item_id', 'remaining'])
          .where('menu_item_id', 'in', itemIds)
          .where('service_date', '=', serviceDateFor(new Date(), zone))
          .execute();
        for (const s of stock) remaining.set(s.menu_item_id, s.remaining);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      input: {
        status: r.status,
        availability: r.availability,
        availableFrom: r.availableFrom,
        inventoryMode: r.inventoryMode,
        remaining: remaining.get(r.id) ?? null,
      },
    }));
  }
}
