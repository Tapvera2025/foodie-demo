/**
 * "Tell me when it is back" — the customer's side.
 *
 * Session-guarded rather than customer-guarded, and that is the whole point of
 * the feature. Someone who scanned a poster ninety seconds ago and found the
 * momos sold out has no account, no phone number and no order history; making
 * them verify a number to be told about a plate of momos would lose every one
 * of them. The session cookie they already have is enough to know who to tell.
 *
 * WHAT DELIVERY LOOKS LIKE TODAY
 *
 * Every remote tier in `src/notify/channel.ts` is a documented stub —
 * WEBSOCKET reports "no socket layer, the client polls every 4s", WEB_PUSH
 * reports "no VAPID keys". So this feature delivers through the poll the client
 * already runs: a toast while the tab is open, and a banner when they come
 * back. The moment a real tier exists, the sweep has the recipient and nothing
 * on this route has to change.
 */

import { Controller, Delete, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { StockWatchRepository, type WatchRefusal } from './stock-watch.repository.js';
import { AppError } from '../platform/errors.js';
import { DB } from '../platform/database.module.js';
import type { Database } from '../platform/schema.js';
import { SessionGuard, sessionOf, type RequestWithSession } from '../identity/session.guard.js';

/**
 * How long a watch lives.
 *
 * Four hours, matching the browsing session rather than exceeding it. A diner
 * who wanted a roll at lunch does not want to hear about it at nine tomorrow,
 * and a watch that outlives the session that made it is a row that can never be
 * delivered to anybody — the client that would have shown it is gone.
 */
const WATCH_TTL_MINUTES = 240;

/** What to say when a watch cannot be created. The server owns the reason. */
const REFUSALS: Record<WatchRefusal, string> = {
  not_found: 'That dish is not on this menu.',
  already_available: 'Good news — that one is available right now.',
  discontinued: 'That dish is no longer on the menu.',
  // The scheduled-start case. Saying WHY matters: "we cannot tell you" reads as
  // a broken feature, "it is not sold out, it starts later" reads as an answer.
  not_restockable: 'That dish is not sold out — it goes on sale later today.',
};

@Controller('api/v1/stock-watch')
@UseGuards(SessionGuard)
export class StockWatchController {
  private readonly watches: StockWatchRepository;

  constructor(@Inject(DB) db: Kysely<Database>) {
    this.watches = new StockWatchRepository(db);
  }

  /** Everything this session is waiting on, and everything that came back. */
  @Get()
  async list(@Req() req: RequestWithSession): Promise<unknown> {
    const { sessionId } = sessionOf(req);
    return { watches: await this.watches.forSession(sessionId) };
  }

  @Post(':menuItemId')
  async create(
    @Param('menuItemId') menuItemId: string,
    @Req() req: RequestWithSession,
  ): Promise<unknown> {
    const { sessionId, customerId } = sessionOf(req);

    const result = await this.watches.watch(
      menuItemId,
      sessionId,
      customerId,
      new Date(Date.now() + WATCH_TTL_MINUTES * 60_000),
    );

    if ('refused' in result) {
      /*
       * `ITEM_UNAVAILABLE` — 409, and it is the honest code for all four.
       *
       * Every refusal is "the state of this item is not what your screen
       * thought it was", which is a conflict rather than a malformed request.
       * A 404 for `not_found` would be defensible and would also mean the
       * client has to branch on the status to know whether to re-fetch the
       * menu; it always should, so one code is one branch.
       */
      throw new AppError('ITEM_UNAVAILABLE', REFUSALS[result.refused]);
    }

    return { id: result.id, watching: true };
  }

  @Delete(':menuItemId')
  async remove(
    @Param('menuItemId') menuItemId: string,
    @Req() req: RequestWithSession,
  ): Promise<unknown> {
    const { sessionId } = sessionOf(req);
    await this.watches.unwatch(menuItemId, sessionId);
    return { watching: false };
  }

  /**
   * The customer has been shown these.
   *
   * A POST with the ids in the PATH rather than a body, because it is fired
   * from a toast that has just been dismissed and the client may be
   * unmounting — `navigator.sendBeacon` and a keepalive fetch are both simpler
   * without one.
   */
  @Post('seen/:ids')
  async seen(@Param('ids') ids: string, @Req() req: RequestWithSession): Promise<unknown> {
    const { sessionId } = sessionOf(req);
    // Capped. A client naming ten thousand ids is not a client.
    const list = ids.split(',').filter(Boolean).slice(0, 50);
    await this.watches.markSeen(list, sessionId);
    return { seen: list.length };
  }
}
