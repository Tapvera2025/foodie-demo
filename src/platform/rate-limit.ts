/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * PRD §16.3 listed "nothing is rate-limited today" as a gap. The OTP send
 * endpoint is where that stops being a gap and becomes a bill: it is
 * unauthenticated and every call spends money on an SMS.
 *
 * WHY NOT AN IN-MEMORY MAP
 *
 * Because it is correct on one replica and silently wrong on two. Each process
 * counts its own share, the effective limit multiplies by the replica count,
 * and nothing errors — you find out from the invoice. That is precisely the
 * failure mode PRD §2.2 names, in the one place where it costs cash.
 *
 * WHY NOT REDIS
 *
 * REDIS_URL is configured and no Redis client is installed. "Use Redis" today
 * means writing the Map above and calling it Redis. When a client is genuinely
 * wired, this becomes the fallback that keeps the guarantee true during the
 * switch, rather than the thing deleted first.
 *
 * WHY FIXED WINDOW AND NOT SLIDING
 *
 * A fixed window allows up to 2n requests across a boundary. For "5 OTPs an
 * hour" that means a possible 10 in a pathological two minutes, which is
 * tolerable and understandable. A sliding window costs a sorted set or a second
 * table, and this limit does not need to be tight — it needs to exist.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { AppError } from './errors.js';
import type { Database } from './schema.js';

export interface LimitRule {
  /** Distinguishes 'otp.send' from 'qr.resolve' in the same table. */
  readonly name: string;
  readonly max: number;
  readonly windowSeconds: number;
}

export interface LimitDecision {
  readonly allowed: boolean;
  readonly hits: number;
  readonly max: number;
  readonly retryAfterSeconds: number;
}

/** Start of the window containing `now`, aligned so every replica agrees. */
export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Count one hit and say whether it is allowed.
 *
 * The increment and the read are ONE statement. A SELECT followed by an UPDATE
 * races, and the race is two requests arriving together — which is what an
 * abuser sends. `ON CONFLICT ... DO UPDATE ... RETURNING` makes the counter and
 * the answer the same operation.
 *
 * Note the hit is recorded even when it is refused. Someone hammering a limited
 * endpoint should not get their allowance back by being refused; otherwise the
 * limit caps successes rather than attempts, and attempts are what cost.
 */
export async function consume(
  db: Kysely<Database>,
  rule: LimitRule,
  subject: string,
  now = new Date(),
): Promise<LimitDecision> {
  const bucket = `${rule.name}:${subject}`;
  const start = windowStart(now, rule.windowSeconds);

  const result = await sql<{ hits: number }>`
    INSERT INTO rate_limit_counter (bucket, window_start, hits)
    VALUES (${bucket}, ${start}, 1)
    ON CONFLICT (bucket, window_start)
    DO UPDATE SET hits = rate_limit_counter.hits + 1, updated_at = now()
    RETURNING hits
  `.execute(db);

  const hits = result.rows[0]?.hits ?? 1;
  const elapsed = Math.floor((now.getTime() - start.getTime()) / 1000);

  return {
    allowed: hits <= rule.max,
    hits,
    max: rule.max,
    retryAfterSeconds: Math.max(1, rule.windowSeconds - elapsed),
  };
}

/**
 * Consume and throw if refused.
 *
 * The error message deliberately does not say which limit was hit or how many
 * are left. Telling someone "3 of 5 used" turns the limiter into a meter they
 * can pace against.
 */
export async function enforce(
  db: Kysely<Database>,
  rule: LimitRule,
  subject: string,
  now = new Date(),
): Promise<void> {
  const decision = await consume(db, rule, subject, now);
  if (!decision.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Try again shortly.', {
      retryAfterSeconds: String(decision.retryAfterSeconds),
    });
  }
}

/**
 * Delete windows that can no longer be current.
 *
 * Called by the sweeper. Two windows of slack rather than one, so a job that
 * runs slightly early cannot delete the window requests are landing in.
 */
export async function sweepExpired(
  db: Kysely<Database>,
  olderThanSeconds = 7200,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanSeconds * 1000);
  const result = await db
    .deleteFrom('rate_limit_counter')
    .where('window_start', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
