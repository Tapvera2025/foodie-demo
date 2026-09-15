/**
 * The mode dispatch in `OrderIdentityGuard`.
 *
 * These three cases are the whole security difference between an `otp`
 * deployment and a `counter` one, and the third is the one worth having a test
 * for: counter mode accepts ANONYMITY, and must still refuse FORGERY. A guard
 * that waved through a bad token because "no OTP is required anyway" would turn
 * an offline convenience into a way to order as somebody else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { __resetConfigForTests } from '../platform/config.js';
import type { Database } from '../platform/schema.js';
import { OrderIdentityGuard } from './order-identity.guard.js';
import { maybeCustomerOf, type RequestWithCustomer } from './customer.guard.js';

/** Enough of a Nest context for a guard that only reads a header. */
function contextFor(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: RequestWithCustomer;
} {
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as RequestWithCustomer;

  return {
    ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext,
    req,
  };
}

/*
 * The guard never reaches the database in any of these cases: a missing token
 * is decided on the header alone, and a malformed one fails signature
 * verification before a lookup. A handle that throws if touched keeps that
 * honest — if a future change starts querying here, this stops being a unit
 * test and says so.
 */
const db = new Proxy(
  {},
  {
    get() {
      throw new Error('the guard reached the database on a path that should not need it');
    },
  },
) as Kysely<Database>;

const ENV = { ...process.env };

function configure(mode: 'otp' | 'counter'): void {
  process.env['ORDER_IDENTITY_MODE'] = mode;
  process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['TAX_SECTION_9_5_APPLIES'] = 'true';
  process.env['AUTH_SIGNING_SEED'] = 'TfLK3O5RF6lg6We08OCyWPb5IHs0ZfeiDG4NMfneTjY=';
  // Counter identity is refused at boot without a POS terminal.
  if (mode === 'counter') process.env['PAYMENTS_PROVIDER'] = 'pos';
  __resetConfigForTests();
}

describe('OrderIdentityGuard', () => {
  beforeEach(() => __resetConfigForTests());

  afterEach(() => {
    process.env = { ...ENV };
    __resetConfigForTests();
  });

  it('otp mode: refuses a request carrying no credential', async () => {
    configure('otp');
    const { ctx } = contextFor({});
    await expect(new OrderIdentityGuard(db).canActivate(ctx)).rejects.toThrow();
  });

  it('counter mode: admits a request carrying no credential, with no customer', async () => {
    configure('counter');
    const { ctx, req } = contextFor({});

    await expect(new OrderIdentityGuard(db).canActivate(ctx)).resolves.toBe(true);

    // The caller must be able to see that nobody was identified — this is what
    // sends `sessionForCustomer` down its anonymous path.
    expect(maybeCustomerOf(req)).toBeNull();
  });

  /**
   * The one that matters.
   *
   * Counter mode is a decision about anonymity, not about forgery. A customer
   * who verified before the internet went away keeps a valid token, and a
   * caller presenting a forged or expired one is not that customer.
   */
  it('counter mode: still refuses a credential that is offered and bad', async () => {
    configure('counter');
    const { ctx } = contextFor({ authorization: 'Bearer not-a-real-token' });
    await expect(new OrderIdentityGuard(db).canActivate(ctx)).rejects.toThrow();
  });

  it('counter mode: refuses a malformed Authorization header', async () => {
    configure('counter');
    const { ctx } = contextFor({ authorization: 'Basic abc123' });
    await expect(new OrderIdentityGuard(db).canActivate(ctx)).rejects.toThrow();
  });
});
