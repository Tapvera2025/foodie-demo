/**
 * ============================================================================
 * WHO IS ALLOWED TO PLACE AN ORDER, AND WHAT THEY HAD TO PROVE
 * ============================================================================
 *
 * Two deployments, two answers, one guard.
 *
 *   ORDER_IDENTITY_MODE=otp      a verified mobile number. The default, and
 *                                identical to `CustomerGuard` — this class
 *                                delegates to it and adds nothing.
 *
 *   ORDER_IDENTITY_MODE=counter  a valid table session is enough. The customer
 *                                proves who they are by standing at a counter
 *                                with a card, not by receiving an SMS.
 *
 * WHY THE MODE IS NOT CHECKED INSIDE `CustomerGuard`
 *
 * Because `CustomerGuard` answers exactly one question — "is there a verified
 * customer on this request" — and it is used by routes that must keep asking
 * it whatever this setting says: cancelling an order, opening a payment,
 * reading a payment. A mode check inside it would silently widen all of them,
 * and the blast radius of that edit would be invisible at the call sites.
 *
 * So the mode lives here, in a guard that a route opts into by name. A route
 * that has not opted in is unaffected by counter mode existing at all.
 *
 * ----------------------------------------------------------------------------
 * COUNTER MODE STILL VALIDATES A TOKEN THAT IS PRESENT
 * ----------------------------------------------------------------------------
 *
 * `counter` makes verification optional, not ignored. If the request carries an
 * `Authorization` header it is checked exactly as strictly as in `otp` mode and
 * a bad one is still rejected.
 *
 * Accepting an unverified request is a decision about ANONYMITY. Waving through
 * a forged or expired token would be a decision about FORGERY, and nothing here
 * calls for that. The difference matters most for a customer who did verify
 * before the internet went away: their token keeps working, their name stays on
 * the kitchen ticket, and they keep getting notified.
 *
 * ----------------------------------------------------------------------------
 * WHAT STOPS THIS BEING FREE FOOD
 * ----------------------------------------------------------------------------
 *
 * An order placed here is `CREATED`. The kitchen board lists `PAYMENT_CONFIRMED`
 * and later only (`LIVE` in `ordering/kds.controller.ts`), so nothing is cooked
 * until a cashier has taken money on the terminal. The worst an unverified
 * caller achieves is an unpaid row that no kitchen ever sees — noise in a table,
 * not a meal.
 *
 * That is the property this whole mode rests on. If the board ever starts
 * showing pre-payment states, counter mode becomes a way to order food without
 * paying for it, and `tests/conformance/counter-identity.mjs` fails loudly
 * rather than leaving that discovery to a vendor.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import type { Database } from '../platform/schema.js';
import { CustomerGuard, type RequestWithCustomer } from './customer.guard.js';

@Injectable()
export class OrderIdentityGuard implements CanActivate {
  private readonly customers: CustomerGuard;

  /**
   * `CustomerGuard` is constructed here rather than injected.
   *
   * Guards named in `@UseGuards(...)` are instantiated by Nest through the
   * module injector, and `CustomerGuard` is not a registered provider — it has
   * never needed to be, because every route referencing it gets one built from
   * the enhancer path. Asking for it as a constructor dependency would make it
   * a provider that has to exist, and the failure would be at boot, in DI, some
   * distance from anything that reads like authentication.
   *
   * It takes a database handle and nothing else, so building it is honest and
   * the delegation below is a plain method call.
   */
  constructor(@Inject(DB) db: Kysely<Database>) {
    this.customers = new CustomerGuard(db);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const counterMode = config().ORDER_IDENTITY_MODE === 'counter';

    if (!counterMode) return this.customers.canActivate(context);

    const req = context.switchToHttp().getRequest<RequestWithCustomer>();

    /*
     * No credential offered: allowed through with no customer principal, so
     * `maybeCustomerOf` returns null and the caller takes the anonymous path.
     *
     * The SessionGuard has already run — counter mode relaxes WHO the customer
     * is, never whether they hold a session for the table they are ordering
     * from. An order still belongs to a session, and a session still comes from
     * scanning a code on a table.
     */
    if (!req.header('authorization')) return true;

    // Offered a credential, so it has to be a good one.
    return this.customers.canActivate(context);
  }
}
