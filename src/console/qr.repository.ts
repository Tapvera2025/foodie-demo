/**
 * The court QR — issue, revoke, replace.
 *
 * WHY THIS IS NOT A SIDE EFFECT OF CREATING A COURT
 *
 * The token IS the venue credential. §2.1: one QR per venue, not per table, and
 * it is the only thing establishing that a customer is standing in the place
 * they are ordering from. A credential created silently alongside something
 * else is one nobody remembers issuing, so this is a separate act with its own
 * audit row — the same argument §13.1 makes.
 *
 * The cost of that separation was a real trap, which is what this file closes:
 * a console-created court is ACTIVE with no token, meaning the platform
 * recognises the venue and **no customer can enter it**. The court list says
 * so, and until now there was no way to act on it.
 *
 * REVOCATION HAS TO BE IMMEDIATE, AND IT IS
 *
 * §13.1: a poster that has left the building is the only way this credential
 * leaks. `GET qr/:token` looks the token up on `food_court.qr_token`, so
 * clearing that column stops it resolving on the very next request — no cache,
 * no TTL, no deploy. Sessions already opened keep working, which is correct:
 * the people holding them are inside the building and mid-order.
 */

import { randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';

import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';
import { buildQrUrl, generateQrToken } from '../tenancy/qr.js';

export interface QrState {
  readonly token: string | null;
  /** The full URL a phone camera would open. Null when there is no token. */
  readonly url: string | null;
  readonly courtStatus: string;
  /**
   * Whether a customer scanning right now would get in.
   *
   * Both conditions, stated as one answer. A token on a suspended court
   * resolves to `QR_INVALID` exactly like no token at all, and a console that
   * showed "QR: issued" next to "Court: on hold" would be telling the truth in
   * a way that answers the wrong question.
   */
  readonly scannable: boolean;
}

export class QrRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  private async load(courtId: string): Promise<{ id: string; qr_token: string | null; status: string; name: string }> {
    const row = await this.db
      .selectFrom('food_court')
      .select(['id', 'qr_token', 'status', 'name'])
      .where('id', '=', courtId)
      .executeTakeFirst();

    if (!row) throw new AppError('QR_INVALID', 'No such food court.');
    return row;
  }

  private state(row: { qr_token: string | null; status: string }, baseUrl: string): QrState {
    return {
      token: row.qr_token,
      url: row.qr_token ? buildQrUrl({ baseUrl, token: row.qr_token }) : null,
      courtStatus: row.status,
      scannable: row.qr_token !== null && row.status === 'ACTIVE',
    };
  }

  async get(courtId: string, baseUrl: string): Promise<QrState> {
    return this.state(await this.load(courtId), baseUrl);
  }

  /**
   * Issue a token, or replace the one there.
   *
   * REPLACING IS DESTRUCTIVE AND THE CALLER MUST SAY IT MEANT TO.
   *
   * Every poster and stall-front sticker in the venue carries the old token.
   * Rotating it makes all of them dead paper at once, which is occasionally
   * exactly right — a code photographed and posted online — and otherwise a
   * disaster somebody caused by clicking a button twice. So a court that
   * already has a token requires `replace: true`, and the endpoint requires a
   * reason on top of that.
   */
  async issue(
    courtId: string,
    baseUrl: string,
    opts: { replace: boolean; reason: string },
  ): Promise<QrState> {
    const court = await this.load(courtId);

    if (court.status === 'INACTIVE') {
      throw new AppError('INVALID_TRANSITION', 'That court is closed. A QR would resolve to nothing.');
    }

    if (court.qr_token && !opts.replace) {
      throw new AppError(
        'CROSS_VENDOR_CART',
        'This court already has a QR code. Replacing it makes every printed poster in the venue stop working — confirm that is what you want.',
      );
    }

    const token = generateQrToken(randomBytes);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('food_court')
        .set({ qr_token: token })
        .where('id', '=', courtId)
        .execute();

      await this.audit.write(
        buildAuditEntry({
          action: court.qr_token ? 'table.qr.reassigned' : 'table.qr.generated',
          entity: 'food_court',
          entityId: courtId,
          foodCourtId: courtId,
          // The OLD token is recorded, the new one is not. An audit row is the
          // right place to answer "which code stopped working and when"; it is
          // the wrong place to keep a live venue credential in readable form.
          ...(court.qr_token ? { beforeValue: { token: court.qr_token } } : {}),
          afterValue: { replaced: Boolean(court.qr_token), reason: opts.reason },
        }),
        trx,
      );
    });

    return this.state({ qr_token: token, status: court.status }, baseUrl);
  }

  /**
   * Revoke, leaving the court live.
   *
   * Deliberately NOT the same as suspending the court. Suspension says "this
   * venue is closed"; revocation says "the code on the posters is compromised
   * and nobody should be able to use it while we reprint". The stalls stay
   * configured, the orders in flight stay in flight, and the only thing that
   * stops is new arrivals.
   */
  async revoke(courtId: string, reason: string): Promise<QrState> {
    const court = await this.load(courtId);

    if (!court.qr_token) {
      throw new AppError('INVALID_TRANSITION', 'This court has no QR code to revoke.');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('food_court')
        .set({ qr_token: null })
        .where('id', '=', courtId)
        .execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'table.qr.deactivated',
          entity: 'food_court',
          entityId: courtId,
          foodCourtId: courtId,
          beforeValue: { token: court.qr_token },
          afterValue: { token: null, reason },
        }),
        trx,
      );
    });

    return this.state({ qr_token: null, status: court.status }, '');
  }
}
