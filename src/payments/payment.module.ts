/**
 * Provider selection, in one place.
 *
 * PRD PAY-MODE-02: no order, cart or KDS code imports a provider SDK.
 * Everything goes through `PaymentProvider`, and the choice is made here from
 * configuration. That is what makes the aggregator decision — still open, PRD
 * §19 row 2 — cost one adapter rather than a rewrite.
 */

import { Module, type Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import type { Database } from '../platform/schema.js';
import { PaymentController } from './payment.controller.js';
import { PosController } from './pos.controller.js';
import { PAYMENT_ENGINE, PAYMENT_PROVIDER } from './payment.tokens.js';
import { PaymentRepository } from './payment.repository.js';
import type { PaymentProvider } from './provider.interface.js';
import { buildPaymentProvider } from './provider.factory.js';

// Re-exported so existing imports keep working; defined in payment.tokens.ts,
// which imports nothing and therefore cannot be part of a cycle.
export { PAYMENT_ENGINE, PAYMENT_PROVIDER } from './payment.tokens.js';

/**
 * How long a customer has to finish paying.
 *
 * Fifteen minutes, and it is deliberately generous. A UPI app can take a while
 * to open on a cheap phone on food-court wi-fi, and expiring a payment that is
 * halfway through is worse than holding an intent slightly too long: the money
 * may already be moving.
 */
const INTENT_TTL_SECONDS = 15 * 60;

const providerFactory: Provider = {
  provide: PAYMENT_PROVIDER,
  /*
   * One line, because the decision lives in `provider.factory.ts` and the
   * worker makes the same call. It used to be duplicated here, and the copy in
   * the worker silently disagreed.
   */
  useFactory: (): PaymentProvider => buildPaymentProvider(config()),
};

const engineFactory: Provider = {
  provide: PAYMENT_ENGINE,
  inject: [DB, PAYMENT_PROVIDER],
  useFactory: (db: Kysely<Database>, provider: PaymentProvider): PaymentRepository =>
    new PaymentRepository(db, provider, {
      splitTiming: config().PAYMENTS_SPLIT_TIMING,
      intentTtlSeconds: INTENT_TTL_SECONDS,
    }),
};

@Module({
  /*
   * `PosController` is mounted unconditionally, on every deployment, including
   * the ones paying through Cashfree.
   *
   * Mounting it conditionally would be tidier and is the wrong trade. A route
   * that exists only under one configuration is a route that is never exercised
   * under the others, and the first time anyone discovers it is missing is when
   * a till returns 404 with a queue at the counter. Mounted always, it answers
   * every caller with the sentence in `PosController.pos()` naming the
   * configuration it needs — which is a diagnosis rather than a mystery.
   */
  controllers: [PaymentController, PosController],
  providers: [providerFactory, engineFactory],
  exports: [PAYMENT_ENGINE, PAYMENT_PROVIDER],
})
export class PaymentModule {}
