/**
 * ============================================================================
 * "WRITE THIS FOR ME" — THE METERED ENDPOINT
 * ============================================================================
 *
 *   GET  /api/v1/vendor/menu/describe/credits   what is left, and is it switched on
 *   POST /api/v1/vendor/menu/describe           spend one, get a sentence
 *
 * The provider chain lives in `describe.provider.ts`. This file is only about
 * who may ask, how many times, and what happens when the answer is no.
 *
 * ----------------------------------------------------------------------------
 * THE ONE THING THAT IS EASY TO GET WRONG HERE
 * ----------------------------------------------------------------------------
 *
 * A stall has two credits. Two tablets in the same kitchen — or one owner
 * double-tapping a button that has not yet disabled itself — can both read
 * "used: 1", both conclude they may proceed, and both spend the second credit.
 * The stall gets three generations and the platform pays for three.
 *
 * Read-then-write across an await is a race whatever the numbers are. The
 * balance is checked and the row is written INSIDE ONE TRANSACTION, and that
 * transaction takes a row lock on the stall before it counts. The second
 * request blocks on the lock, and when it proceeds it counts the row the first
 * one just wrote.
 *
 * ----------------------------------------------------------------------------
 * AND THE CONSEQUENCE OF FIXING IT THAT WAY
 * ----------------------------------------------------------------------------
 *
 * The credit has to be reserved BEFORE the model is called, because the call
 * takes seconds and holding a database transaction open across it would pin a
 * connection and a lock for the duration. So the flow is:
 *
 *   1. transaction: lock the stall, count charged rows, refuse if none left,
 *      insert a PENDING row. Commit.
 *   2. outside the transaction: call the providers. Slow, no locks held.
 *   3. update that row with the real outcome.
 *
 * A PENDING row counts as spent while it is in flight, which is what stops the
 * double-spend. If the model then fails, step 3 rewrites the row to a failure
 * outcome and it stops counting — the stall is not charged for a failure, and
 * the credit comes back.
 *
 * If the process dies between 2 and 3 the row stays PENDING for ever and the
 * stall is short one credit. That is the deliberate trade: the alternative
 * failure — charging nobody and letting the count drift under concurrency —
 * costs the platform money on every stall rather than one credit on the rare
 * crash, and a stuck PENDING row is visible in the ledger and fixable by hand.
 */

import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { decide, type RoleAssignment } from '../identity/rbac.js';
import {
  StaffGuard,
  staffOf,
  vendorScopeOf,
  type RequestWithStaff,
} from '../identity/staff.guard.js';
import { describeConfigured, describeDish } from './describe.provider.js';

/**
 * Outcomes that count against the grant.
 *
 * `PENDING` is in here and that is the whole double-spend defence: a generation
 * in flight is spent until it is known to have failed. `OK` is in here because
 * it succeeded. Nothing else is.
 */
const CHARGED_OUTCOMES = ['OK', 'PENDING'] as const;

/**
 * The staff token's compact role claim, widened to what `decide` wants.
 *
 * Same shape as the one in `menu-edit.controller.ts`. Duplicated rather than
 * shared because lifting it into `rbac.ts` would put a JWT claim's field names
 * (`fc`, `vnd`) into the policy module, and the policy module deliberately
 * knows nothing about how a caller was authenticated.
 */
function toAssignment(r: {
  role: RoleAssignment['role'];
  fc?: string;
  vnd?: string;
}): RoleAssignment {
  return {
    role: r.role,
    ...(r.fc !== undefined ? { foodCourtId: r.fc } : {}),
    ...(r.vnd !== undefined ? { vendorId: r.vnd } : {}),
  };
}

const DescribeBody = z.object({
  /**
   * The dish name, which is the entire input to the model.
   *
   * Required and non-empty: a generation for an unnamed dish would spend a
   * credit on a sentence about nothing. The kitchen board disables the button
   * until the name field has something in it; this is the same rule stated
   * where it cannot be skipped.
   */
  dishName: z.string().trim().min(2).max(120),
  /** Optional context. Absent when the dish has not been filed yet. */
  categoryName: z.string().trim().max(80).nullish(),
  dietaryFlags: z.array(z.string().trim().max(20)).max(8).optional(),
  /**
   * The dish, when it exists. Absent while the "new item" form is open, which
   * is exactly when a kitchen most wants this button.
   */
  menuItemId: z.string().uuid().nullish(),
});

@Controller('api/v1/vendor/menu/describe')
@UseGuards(StaffGuard)
export class DescribeController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /**
   * The caller's stall, if they may write its menu.
   *
   * `menu.write` rather than a new permission. Generating a description is
   * writing menu copy — the same act as typing it — and inventing
   * `menu.describe` would let a role hold one without the other, which is a
   * distinction with no meaning. It also means this is owner-only for the same
   * reason the rest of menu editing is.
   */
  private scope(req: RequestWithStaff): { vendorId: string; actorId: string } {
    const staff = staffOf(req);
    const vendorId = vendorScopeOf(staff);
    if (!vendorId) {
      throw new AppError('TENANT_SCOPE_VIOLATION', 'This account is not attached to a stall.');
    }

    const decision = decide(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'menu.write',
      { vendorId },
    );

    if (!decision.allowed) {
      throw new AppError(
        'ACCOUNT_SUSPENDED',
        'Only the stall owner can write menu descriptions.',
      );
    }

    return { vendorId, actorId: staff.userId };
  }

  /**
   * What the kitchen board needs to render the button before anyone taps it.
   *
   * `configured` is separate from `remaining` because they are different
   * problems with different audiences: no credits is the stall's situation and
   * they are told to contact the platform; no keys is the operator's, and
   * telling a stall owner to "contact the administration for more credits" when
   * the real answer is that nobody set an environment variable would send them
   * on an errand that cannot succeed.
   */
  @Get('credits')
  async credits(@Req() req: RequestWithStaff): Promise<unknown> {
    const { vendorId } = this.scope(req);
    const state = await this.balance(this.db, vendorId);
    const configured = describeConfigured();

    return {
      granted: state.granted,
      used: state.used,
      remaining: state.remaining,
      /** Whether the SERVER can generate at all. Never the keys themselves. */
      configured: configured.any,
    };
  }

  /** Granted, used and remaining for one stall. Used by both routes. */
  private async balance(
    db: Kysely<Database>,
    vendorId: string,
  ): Promise<{ granted: number; used: number; remaining: number }> {
    const vendor = await db
      .selectFrom('vendor')
      .select('ai_description_credits')
      .where('id', '=', vendorId)
      .executeTakeFirst();

    if (!vendor) {
      throw new AppError('TENANT_SCOPE_VIOLATION', 'Stall not found.');
    }

    const used = await db
      .selectFrom('ai_generation')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('vendor_id', '=', vendorId)
      .where('outcome', 'in', [...CHARGED_OUTCOMES])
      .executeTakeFirst();

    const granted = vendor.ai_description_credits;
    const spent = Number(used?.n ?? 0);

    return { granted, used: spent, remaining: Math.max(0, granted - spent) };
  }

  @Post()
  async generate(@Req() req: RequestWithStaff, @Body() body: unknown): Promise<unknown> {
    const { vendorId, actorId } = this.scope(req);
    const input = DescribeBody.parse(body);

    /*
     * CONFIGURATION BEFORE CREDITS.
     *
     * Checked first, and before the transaction, so a server with no keys never
     * reserves a credit it cannot possibly use. Getting this order wrong would
     * burn a stall's free allowance on a misconfigured deployment — the worst
     * possible first impression of a paid feature.
     */
    if (!describeConfigured().any) {
      throw new AppError(
        'AI_NOT_CONFIGURED',
        'Automatic descriptions are not switched on for this server yet.',
      );
    }

    /*
     * ------------------------------------------------------------------
     * STEP 1 — RESERVE, UNDER A LOCK
     * ------------------------------------------------------------------
     */
    const reservation = await this.db.transaction().execute(async (trx) => {
      /*
       * `FOR UPDATE` on the stall row.
       *
       * The lock is on `vendor`, not on `ai_generation`, because the thing
       * being protected is a COUNT — and you cannot lock rows that do not exist
       * yet. Two concurrent requests both counting zero rows and both inserting
       * is precisely the anomaly a row lock on the shared parent prevents:
       * whoever gets the lock first inserts, and the second one counts it.
       */
      const vendor = await trx
        .selectFrom('vendor')
        .select('ai_description_credits')
        .where('id', '=', vendorId)
        .forUpdate()
        .executeTakeFirst();

      if (!vendor) {
        throw new AppError('TENANT_SCOPE_VIOLATION', 'Stall not found.');
      }

      const used = await trx
        .selectFrom('ai_generation')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('vendor_id', '=', vendorId)
        .where('outcome', 'in', [...CHARGED_OUTCOMES])
        .executeTakeFirst();

      const granted = vendor.ai_description_credits;
      const spent = Number(used?.n ?? 0);

      if (spent >= granted) {
        throw new AppError(
          'AI_CREDITS_EXHAUSTED',
          granted === 0
            ? 'Automatic descriptions are not enabled for this stall. Contact the platform team to get credits.'
            : `You have used all ${granted} automatic descriptions. Contact the platform team to get more credits.`,
        );
      }

      const row = await trx
        .insertInto('ai_generation')
        .values({
          vendor_id: vendorId,
          menu_item_id: input.menuItemId ?? null,
          dish_name: input.dishName,
          // Not known until a provider answers. The row exists to hold the
          // credit, and these are overwritten in step 3.
          provider: 'PENDING',
          model: 'PENDING',
          outcome: 'PENDING',
          staff_user_id: actorId,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      return { generationId: row.id, granted, usedAfter: spent + 1 };
    });

    /*
     * ------------------------------------------------------------------
     * STEP 2 — CALL OUT. NO TRANSACTION, NO LOCKS.
     * ------------------------------------------------------------------
     */
    const result = await describeDish({
      dishName: input.dishName,
      categoryName: input.categoryName ?? null,
      ...(input.dietaryFlags ? { dietaryFlags: input.dietaryFlags } : {}),
    });

    const last = result.attempts[result.attempts.length - 1];

    /*
     * ------------------------------------------------------------------
     * STEP 3 — SETTLE THE ROW
     * ------------------------------------------------------------------
     */
    if (!result.ok) {
      /*
       * The credit comes back, by writing an outcome that is not charged.
       *
       * `ALL_PROVIDERS_FAILED` is outside `CHARGED_OUTCOMES`, so the next
       * balance query no longer counts this row. There is no compensating
       * UPDATE on a counter and therefore nothing that can fail halfway and
       * leave the two disagreeing.
       */
      await this.db
        .updateTable('ai_generation')
        .set({
          provider: last?.provider ?? 'NONE',
          model: last?.model ?? 'NONE',
          outcome: 'ALL_PROVIDERS_FAILED',
          duration_ms: last?.durationMs ?? null,
        })
        .where('id', '=', reservation.generationId)
        .execute();

      log().warn(
        { vendorId, attempts: result.attempts.map((a) => `${a.provider}:${a.outcome}`) },
        'ai description failed on every provider — credit released',
      );

      throw new AppError(
        'AI_GENERATION_FAILED',
        'Could not write a description just now. Your credit has not been used — please try again.',
      );
    }

    const winner = result.attempts.find((a) => a.outcome === 'OK');

    await this.db
      .updateTable('ai_generation')
      .set({
        provider: winner?.provider ?? 'UNKNOWN',
        model: winner?.model ?? 'UNKNOWN',
        outcome: 'OK',
        generated_text: result.text,
        duration_ms: winner?.durationMs ?? null,
      })
      .where('id', '=', reservation.generationId)
      .execute();

    const remaining = Math.max(0, reservation.granted - reservation.usedAfter);

    log().info(
      { vendorId, provider: winner?.provider, remaining },
      'ai description generated',
    );

    return {
      description: result.text,
      /*
       * The balance AFTER this generation, so the board can update without a
       * second request — and so the button disables itself on the response that
       * spent the last credit rather than on the next page load.
       */
      granted: reservation.granted,
      used: reservation.usedAfter,
      remaining,
      /*
       * Which model wrote it. The kitchen does not need this, but a support
       * conversation about a strange sentence starts here, and it costs one
       * string.
       */
      provider: winner?.provider ?? null,
    };
  }
}
