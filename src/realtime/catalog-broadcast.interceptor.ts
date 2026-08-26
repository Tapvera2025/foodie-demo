/**
 * ============================================================================
 * ANY SUCCESSFUL WRITE TO A STALL'S CATALOGUE ANNOUNCES ITSELF
 * ============================================================================
 *
 * WHY AN INTERCEPTOR AND NOT A `publish` IN EACH HANDLER
 *
 * `InventoryController` has eight write endpoints today — availability, stock,
 * cover image, offer banner, pause, offer request, item create, item edit —
 * and the list grows. Adding a publish call to each is a list that has to be
 * maintained by memory, and the ninth endpoint will be written by copying the
 * eighth on a day when the eighth is the one that was missed.
 *
 * `transition.ts` had a real choke point to put this in. The catalogue does
 * not: eight independent updates against four tables, with nothing in common
 * except that they all mutate one vendor's catalogue and all arrive through
 * this controller. So the controller IS the choke point, and an interceptor is
 * how you attach behaviour to it without touching a handler.
 *
 * The endpoint that forgets to announce itself is now unwritable rather than
 * merely discouraged.
 *
 * ----------------------------------------------------------------------------
 * AFTER THE HANDLER, NOT INSIDE THE TRANSACTION — AND WHY THAT IS FINE HERE
 * ----------------------------------------------------------------------------
 *
 * `transitionOrder` publishes inside its transaction so a rolled-back
 * transition cannot be announced. This cannot do that: it runs after the
 * handler has returned, by which point the handler's transaction has already
 * committed.
 *
 * That ordering is safe for the same reason it would be wrong for money. A
 * thrown handler never reaches `tap`, so a failed write publishes nothing; and
 * the event carries no state, so the worst case of a late notify is a client
 * refetching a fraction of a second after it could have. Nobody is told that a
 * dish is available when it is not — they are told to go and look, and looking
 * gives them the committed truth.
 *
 * ----------------------------------------------------------------------------
 * READS ARE SKIPPED, AND THAT IS THE MAIN THING THIS GETS RIGHT
 * ----------------------------------------------------------------------------
 *
 * A GET publishing `catalog.changed` would make every board's own polling
 * refetch wake every customer in the court, which is a feedback loop that
 * looks like load and is actually the app talking to itself.
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { staffOf, vendorScopeOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { DB } from '../platform/database.module.js';
import type { Database } from '../platform/schema.js';
import { publishCatalogChanged } from './publish.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class CatalogBroadcastInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithStaff>();

    if (!MUTATING.has(req.method)) return next.handle();

    return next.handle().pipe(
      tap(() => {
        /*
         * Resolved AFTER the handler ran, so the guard has certainly
         * populated the principal. Reading it before `handle()` would work
         * today and break the moment an endpoint on this controller is
         * exposed without `StaffGuard`.
         */
        let vendorId: string | null = null;
        try {
          vendorId = vendorScopeOf(staffOf(req));
        } catch {
          // No staff principal — nothing to scope a broadcast to. A missing
          // announcement is not worth turning a successful write into a 500.
          return;
        }
        if (!vendorId) return;

        void this.announce(vendorId);
      }),
    );
  }

  private async announce(vendorId: string): Promise<void> {
    /*
     * The court is looked up rather than carried on the request, because the
     * customer-facing rooms are court-scoped: a person browsing the stall list
     * is in `court:<id>` and has no idea which vendor they are about to care
     * about. One indexed lookup on a write path is not a cost worth avoiding.
     */
    const vendor = await this.db
      .selectFrom('vendor')
      .select(['food_court_id'])
      .where('id', '=', vendorId)
      .executeTakeFirst();

    await publishCatalogChanged(this.db, {
      vendorId,
      foodCourtId: vendor?.food_court_id ?? null,
    });
  }
}
