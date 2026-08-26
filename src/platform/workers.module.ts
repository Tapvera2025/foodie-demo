/**
 * The dispatch, escalation and notification services, made injectable.
 *
 * These live in the worker process, but the API needs two of them too: the KDS
 * cancels the ladder the instant a kitchen acknowledges, and it sends the
 * rejection message from the request that caused it. Both are latency-sensitive
 * in a way a five-second sweep is not.
 *
 * Sharing the classes rather than duplicating the behaviour is the point. An
 * API that "also" cancelled escalations with its own UPDATE would be a second
 * implementation of the unblock rule, and the unblock rule has a subtlety worth
 * having in exactly one place: a stall sitting on three unacknowledged orders
 * does not get unblocked by acknowledging one of them.
 */

import { Global, Module, type Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { config } from './config.js';
import { DB } from './database.module.js';
import type { Database } from './schema.js';
import { DispatchRepository } from '../dispatch/dispatch.repository.js';
import { EscalationRepository } from '../dispatch/escalation.repository.js';
import { buildCustomerLadder } from '../notify/channel.js';
import { NotificationRepository } from '../notify/notification.repository.js';

export const DISPATCH = Symbol('DISPATCH');
export const ESCALATION = Symbol('ESCALATION');
export const NOTIFICATIONS = Symbol('NOTIFICATIONS');

function ladderConfig(): {
  step1Seconds: number;
  step2Seconds: number;
  step3Seconds: number;
  step4Seconds: number;
} {
  const cfg = config();
  return {
    step1Seconds: cfg.DISPATCH_LADDER_STEP1_SECONDS,
    step2Seconds: cfg.DISPATCH_LADDER_STEP2_SECONDS,
    step3Seconds: cfg.DISPATCH_LADDER_STEP3_SECONDS,
    step4Seconds: cfg.DISPATCH_LADDER_STEP4_SECONDS,
  };
}

const dispatchProvider: Provider = {
  provide: DISPATCH,
  inject: [DB],
  useFactory: (db: Kysely<Database>): DispatchRepository =>
    new DispatchRepository(db, ladderConfig()),
};

const escalationProvider: Provider = {
  provide: ESCALATION,
  inject: [DB, DISPATCH],
  useFactory: (db: Kysely<Database>, dispatch: DispatchRepository): EscalationRepository =>
    new EscalationRepository(db, dispatch, ladderConfig()),
};

const notificationProvider: Provider = {
  provide: NOTIFICATIONS,
  inject: [DB],
  useFactory: (db: Kysely<Database>): NotificationRepository =>
    // `buildCustomerLadder` throws in production, because a console channel
    // there would log every message and deliver none. The API failing to boot
    // is the correct outcome — see src/notify/channel.ts.
    new NotificationRepository(db, buildCustomerLadder(config().NODE_ENV)),
};

@Global()
@Module({
  providers: [dispatchProvider, escalationProvider, notificationProvider],
  exports: [DISPATCH, ESCALATION, NOTIFICATIONS],
})
export class WorkersModule {}
