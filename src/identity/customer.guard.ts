/**
 * Turns a bearer token into a verified customer principal.
 *
 * WHY THIS EXISTS
 *
 * PRD §11.2 and DR-0001 make identification the gate on ordering: browsing is
 * anonymous, ordering is not. That was enforced by the PWA asking for an OTP
 * and by nothing else. `POST /orders` read no `Authorization` header at all, so
 * a request sent with no credential returned 201 and wrote an order with
 * `customer_id = NULL` — no phone to notify, no identity at the counter, and no
 * OTP anywhere in the transaction.
 *
 * A client is not an enforcement mechanism. It is the thing an attacker
 * replaces.
 *
 * Verification only. It does not decide what the customer may do with a
 * particular order — that is an ownership check at the call site, and
 * conflating the two is how a guard comes to mean "signed in" while every
 * signed-in customer quietly gains access to everyone else's orders.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Kysely } from 'kysely';

import { setActor } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { authKeys } from './keys.js';
import { verifyToken } from './tokens.js';

export const CUSTOMER_AUDIENCE = 'foodcourt-customer';

export interface CustomerPrincipal {
  readonly customerId: string;
}

export const CUSTOMER = Symbol('CUSTOMER_PRINCIPAL');

export interface RequestWithCustomer extends Request {
  [CUSTOMER]?: CustomerPrincipal;
}

@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithCustomer>();

    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('TOKEN_INVALID', 'Verify your mobile number to continue.');
    }

    const claims = await verifyToken(authKeys(), header.slice('Bearer '.length), {
      audience: CUSTOMER_AUDIENCE,
      expectType: 'customer',
    });

    if (claims.typ !== 'customer') {
      throw new AppError('TOKEN_WRONG_TYPE', 'Wrong kind of token for this endpoint.');
    }

    /**
     * The version check costs one indexed lookup and is worth it here in a way
     * it is not for a thirty-minute staff token.
     *
     * A customer token lives for thirty days (DR-0001 priced that deliberately:
     * re-verifying to buy lunch next Tuesday is the friction the whole decision
     * was about). Thirty days is long enough that "this credential is revoked"
     * has to mean something, and `token_version` is the mechanism AUTH-05
     * already chose. The same query also establishes that the customer still
     * exists, which a signature alone does not.
     */
    const customer = await this.db
      .selectFrom('customer')
      .select(['id', 'token_version'])
      .where('id', '=', claims.sub)
      .executeTakeFirst();

    if (!customer || customer.token_version !== claims.ver) {
      throw new AppError('TOKEN_INVALID', 'Verify your mobile number again to continue.');
    }

    req[CUSTOMER] = { customerId: customer.id };
    // So anything this request causes — an audit row, a ledger row, a log line
    // — names the person rather than the default.
    setActor('CUSTOMER', customer.id);
    return true;
  }
}

/** Reads what the guard attached. Throws if used on an unguarded route. */
/**
 * The customer on this request, or null if there is none.
 *
 * For `ORDER_IDENTITY_MODE=counter`, where a request may legitimately carry no
 * customer at all — see the note on that setting in `platform/config.ts`.
 *
 * Deliberately a SEPARATE function rather than a flag on `customerOf`. That
 * one throws, and every existing caller depends on it throwing; a parameter
 * that turns the throw off would put the decision at hundreds of call sites,
 * where the wrong default is invisible. A caller that can handle an anonymous
 * request has to say so by name.
 */
export function maybeCustomerOf(req: RequestWithCustomer): CustomerPrincipal | null {
  return req[CUSTOMER] ?? null;
}

export function customerOf(req: RequestWithCustomer): CustomerPrincipal {
  const p = req[CUSTOMER];
  if (!p) throw new AppError('TOKEN_INVALID', 'Verify your mobile number to continue.');
  return p;
}
