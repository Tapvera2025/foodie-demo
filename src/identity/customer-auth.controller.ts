/**
 * Customer authentication by mobile OTP.
 *
 * DR-0001 and PRD §11.2. Two endpoints, both unauthenticated, both rate
 * limited — the first of those facts is why the second is not optional.
 *
 *   POST /auth/otp/request   send a code
 *   POST /auth/otp/verify    exchange a code for a customer token
 *
 * The prompt appears at add-to-cart. Browsing stays anonymous; committing does
 * not. The session id does NOT change on authentication, because the cart hangs
 * off the session and rotating the id at exactly the moment the customer added
 * their first item is how the cart disappears.
 */

import { Body, Controller, Get, Inject, Ip, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { currentCorrelationId } from '../platform/correlation.js';
import { config } from '../platform/config.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { enforce, type LimitRule } from '../platform/rate-limit.js';
import type { Database } from '../platform/schema.js';
import { authKeys } from './keys.js';
import {
  ConsoleOtpChannel,
  createOtpChannel,
  generateOtp,
  hashOtp,
  maskPhone,
  normalisePhone,
  verifyOtp,
  type OtpChannel,
} from './otp.js';
import { issueToken, TOKEN_TTL_SECONDS } from './tokens.js';
import { CUSTOMER_AUDIENCE } from './customer.guard.js';
import {
  SessionGuard,
  sessionOf,
  type RequestWithSession,
} from './session.guard.js';

/**
 * Re-exported from the guard, which is where it now lives. Keeping the name
 * here means existing imports of `CUSTOMER_AUDIENCE` from this controller
 * still resolve, without the guard having to import a controller to get it.
 */
export { CUSTOMER_AUDIENCE };

/**
 * NOTE WHAT IS NOT HERE: `sessionId`.
 *
 * Both endpoints used to take one from the request body and attach the
 * verified customer to whatever session it named. Since a session id was, at
 * the time, a bare UUID that anybody could hold, that let a caller bind their
 * own phone number to somebody else's browse session — and, with the session
 * sharing this release also fixes, to the session of every other customer in
 * the hall.
 *
 * The session now comes from the signed token on the request, so a caller can
 * only ever attach a phone to a session they were themselves issued.
 */
const RequestBody = z.object({
  phone: z.string().min(6).max(20),
});

const VerifyBody = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().regex(/^\d{6}$/, 'A code is six digits'),
  /**
   * THE NAME ARRIVES WITH THE CODE, NOT WITH THE REQUEST.
   *
   * It is typed on the same screen as the phone number, one step earlier, and
   * the client holds it until now. That is deliberate: persisting a name at
   * `/request` would let anyone write a name against any phone number they can
   * type, with no proof they hold it. Somebody could set a stranger's name to
   * anything, and the stranger would see it on their own profile.
   *
   * Sending it here means the name lands in the same transaction that proves
   * the phone — it cannot be stored without the code being right.
   */
  /**
   * REQUIRED. The kitchen has nothing else to call.
   *
   * This was `.optional()`, and the client mirrored it by sending `undefined`
   * for a blank field. The result was a verified customer with no display name,
   * and the failure surfaced two screens later at the counter: the KDS ticket
   * carries the customer's name and NEVER their phone — a kitchen tablet is a
   * screen several people can see — so a nameless order is one the staff cannot
   * announce.
   *
   * Enforced here rather than only in the form, because a validation rule that
   * lives in one client is a rule the next client does not have.
   */
  name: z.string().trim().min(1).max(80),
});

@Controller('api/v1/auth/otp')
export class CustomerAuthController {
  private readonly channel: OtpChannel;

  constructor(@Inject(DB) private readonly db: Kysely<Database>) {
    // Constructed once, at boot. `createOtpChannel` throws for a channel that
    // is not actually available, so a misconfigured deployment fails to start
    // rather than accepting orders it can never authenticate.
    this.channel = createOtpChannel(config().OTP_CHANNEL, config().NODE_ENV);
  }

  /**
   * The pepper for the OTP MAC.
   *
   * Derived from AUTH_SIGNING_SEED rather than being its own setting: one more
   * secret is one more thing to forget to set, and a forgotten one here would
   * either crash at the first OTP or, worse, default to something in the source
   * history. The prefix keeps it from being the same value as the token key.
   */
  private pepper(): string {
    return `otp:${config().AUTH_SIGNING_SEED}`;
  }

  private get perPhone(): LimitRule {
    return { name: 'otp.send.phone', max: config().OTP_SEND_PER_PHONE_PER_HOUR, windowSeconds: 3600 };
  }

  private get perIp(): LimitRule {
    return { name: 'otp.send.ip', max: config().OTP_SEND_PER_IP_PER_HOUR, windowSeconds: 3600 };
  }

  @Post('request')
  @UseGuards(SessionGuard)
  async request(
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: RequestWithSession,
  ): Promise<unknown> {
    const { phone: raw } = RequestBody.parse(body);
    const { sessionId } = sessionOf(req);
    const phone = normalisePhone(raw);
    const cfg = config();

    // Both limits, and the IP one first. A single number being hammered is one
    // victim; a single source hammering many numbers is the expensive attack,
    // and it is the one that never trips a per-number limit.
    await enforce(this.db, this.perIp, ip || 'unknown');
    await enforce(this.db, this.perPhone, phone);

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + cfg.OTP_TTL_SECONDS * 1000);

    await this.db.transaction().execute(async (trx) => {
      // Retire any live code first. The partial unique index enforces at most
      // one live code per number, so this is not politeness — the insert below
      // fails without it. Requesting a second code must invalidate the first,
      // or both work and the window in which an overheard code is useful
      // doubles with every resend.
      await trx
        .updateTable('customer_otp')
        .set({ superseded_at: new Date() })
        .where('phone', '=', phone)
        .where('consumed_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute();

      await trx
        .insertInto('customer_otp')
        .values({
          phone,
          code_hash: hashOtp(code, phone, this.pepper()),
          app_session_id: sessionId,
          channel: this.channel.name,
          max_attempts: cfg.OTP_MAX_VERIFY_ATTEMPTS,
          expires_at: expiresAt,
          correlation_id: currentCorrelationId(),
        })
        .execute();
    });

    // Delivery AFTER the row is committed. The reverse order can deliver a code
    // that was never stored, and the customer would be typing a valid-looking
    // number at an endpoint that has never heard of it.
    try {
      await this.channel.send({
        phone,
        code,
        ttlSeconds: cfg.OTP_TTL_SECONDS,
        correlationId: currentCorrelationId(),
      });
      await this.db
        .updateTable('customer_otp')
        .set({ dispatched_at: new Date() })
        .where('phone', '=', phone)
        .where('consumed_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute();
    } catch (e) {
      await this.db
        .updateTable('customer_otp')
        .set({ dispatch_error: (e as Error).message })
        .where('phone', '=', phone)
        .where('consumed_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute();
      throw new AppError('INTERNAL', 'We could not send a code just now. Try again shortly.');
    }

    log().info({ event: 'otp_requested', phone: maskPhone(phone) }, 'otp sent');

    return {
      sentTo: maskPhone(phone),
      expiresInSeconds: cfg.OTP_TTL_SECONDS,
      // Told plainly so the client can show a real countdown rather than
      // guessing, and so a resend button knows when to become enabled.
      resendAfterSeconds: 30,
    };
  }

  @Post('verify')
  @UseGuards(SessionGuard)
  async verify(
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: RequestWithSession,
  ): Promise<unknown> {
    const { phone: raw, code, name } = VerifyBody.parse(body);
    const { sessionId } = sessionOf(req);
    const phone = normalisePhone(raw);

    // Verify is limited too. Attempt-counting on the record stops brute force
    // against one code; this stops someone cycling through fresh codes to get
    // fresh attempt budgets.
    await enforce(this.db, { name: 'otp.verify.ip', max: 60, windowSeconds: 3600 }, ip || 'unknown');

    const result = await this.db.transaction().execute(async (trx) => {
      const record = await trx
        .selectFrom('customer_otp')
        .select(['id', 'code_hash', 'attempts', 'max_attempts', 'expires_at', 'consumed_at', 'superseded_at'])
        .where('phone', '=', phone)
        .where('consumed_at', 'is', null)
        .where('superseded_at', 'is', null)
        // FOR UPDATE: two simultaneous guesses must not each read attempts=4
        // and each decide they have one left.
        .forUpdate()
        .executeTakeFirst();

      if (!record) {
        throw new AppError('INVALID_CREDENTIALS', 'That code is not valid. Request a new one.');
      }

      const verdict = verifyOtp(
        {
          codeHash: record.code_hash,
          attempts: record.attempts,
          maxAttempts: record.max_attempts,
          expiresAt: record.expires_at,
          consumedAt: record.consumed_at,
          supersededAt: record.superseded_at,
        },
        code,
        phone,
        this.pepper(),
        new Date(),
      );

      if (!verdict.ok) {
        // The attempt is counted even for an expired code. Not counting it
        // would let an attacker probe indefinitely against stale records.
        await trx
          .updateTable('customer_otp')
          .set({ attempts: record.attempts + 1 })
          .where('id', '=', record.id)
          .execute();

        // One message for every failure reason. "That code has expired" versus
        // "that code is wrong" tells someone guessing which of their two
        // problems to solve.
        throw new AppError('INVALID_CREDENTIALS', 'That code is not valid. Request a new one.');
      }

      await trx
        .updateTable('customer_otp')
        .set({ consumed_at: new Date(), attempts: record.attempts + 1 })
        .where('id', '=', record.id)
        .execute();

      // Upsert the customer. A returning diner authenticates against the row
      // they already have, which is what makes order history work at all.
      const existing = await trx
        .selectFrom('customer')
        .select(['id', 'token_version'])
        .where('phone', '=', phone)
        .executeTakeFirst();

      const customer =
        existing ??
        (await trx
          .insertInto('customer')
          .values({
            phone,
            phone_verified_at: new Date(),
            ...(name ? { display_name: name } : {}),
          })
          .returning(['id', 'token_version'])
          .executeTakeFirstOrThrow());

      /**
       * A SUPPLIED NAME OVERWRITES; AN OMITTED ONE DOES NOT CLEAR.
       *
       * Since the schema above made `name` required, the second half of that
       * sentence describes a case this endpoint no longer accepts — and the
       * guard stays anyway. It is one `&&` standing between a future schema
       * relaxation and silently deleting the name a returning customer set last
       * month, and the cost of keeping it is nothing.
       *
       * The first half is live and load-bearing: somebody correcting a typo on
       * their second visit sees the correction stick, because a name that
       * arrives wins.
       *
       * There is still no way to CLEAR a name from this endpoint, which is
       * correct — it is a field the customer can only ever set, and removing it
       * belongs to a profile screen that does not exist yet.
       */
      await trx
        .updateTable('customer')
        .set({
          last_seen_at: new Date(),
          phone_verified_at: new Date(),
          ...(name ? { display_name: name } : {}),
        })
        .where('id', '=', customer.id)
        .execute();

      // Attach to the browse session WITHOUT rotating its id (DR-0001 §3). The
      // cart hangs off this session and the customer is mid-add-to-cart.
      await trx
        .updateTable('app_session')
        .set({ customer_id: customer.id })
        .where('id', '=', sessionId)
        // The session must still be live. Attaching an identity to an expired
        // row would produce a customer who is authenticated and cannot order,
        // with nothing saying why.
        .where('expires_at', '>', new Date())
        .execute();

      /**
       * Read the name back rather than echoing what was sent.
       *
       * A returning customer who sent nothing this time still has a name, and
       * the client needs it to greet them. Echoing the request would show a
       * blank profile to somebody the platform knows perfectly well.
       */
      const saved = await trx
        .selectFrom('customer')
        .select('display_name')
        .where('id', '=', customer.id)
        .executeTakeFirstOrThrow();

      return { ...customer, displayName: saved.display_name };
    });

    const token = await issueToken(
      authKeys(),
      { typ: 'customer', sub: result.id, ver: result.token_version },
      { audience: CUSTOMER_AUDIENCE },
    );

    log().info({ event: 'otp_verified', customerId: result.id }, 'customer authenticated');

    return {
      token,
      expiresInSeconds: TOKEN_TTL_SECONDS.customer,
      // The phone is MASKED and the name is not. The mask exists so a shoulder
      // glance at somebody's profile does not read out their number; a first
      // name is what they chose to be called and hiding it would serve nobody.
      customer: { id: result.id, phone: maskPhone(phone), name: result.displayName },
    };
  }

  /**
   * DEVELOPMENT ONLY. Shows the code that was just issued.
   *
   * WHY THIS IS A SEPARATE ENDPOINT AND NOT A FIELD ON `/request`
   *
   * Adding `code` to the send response under an `if (dev)` would mean the
   * production endpoint has a shape that only differs by an environment check —
   * one refactor away from leaking every OTP to every caller. A separate route
   * that does not exist in production cannot do that: `/request` returns the
   * same thing everywhere, and this either 404s or is not reachable at all.
   *
   * The same reasoning as `dev/courts` and `dev/orders/:id/simulate-payment`.
   * Development shortcuts get their own doors.
   *
   * The code comes from the channel's memory, not the database — `code_hash` is
   * an HMAC and the plaintext is never stored, which is correct and is exactly
   * why this hook has to exist.
   */
  @Get('dev/latest')
  latest(): unknown {
    if (config().NODE_ENV === 'production') throw new AppError('QR_INVALID', 'Not found');

    const last = ConsoleOtpChannel.lastIssued;
    if (!last) return { code: null, phone: null, issuedAt: null };

    // A code older than its own TTL is not the one being typed. Returning it
    // would send somebody chasing a code that has already expired.
    const ageSeconds = (Date.now() - last.at.getTime()) / 1000;
    if (ageSeconds > config().OTP_TTL_SECONDS) {
      return { code: null, phone: null, issuedAt: null };
    }

    return {
      code: last.code,
      phone: maskPhone(last.phone),
      issuedAt: last.at.toISOString(),
    };
  }
}
