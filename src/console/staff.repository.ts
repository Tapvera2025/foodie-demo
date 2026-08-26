/**
 * Kitchen logins, issued and revoked by the platform.
 *
 * WHY THIS IS NOT THE VENDOR'S JOB
 *
 * PRD §13.1 states it and the reason is worth repeating here, where the code
 * is: the account is a credential to a system that moves money on the vendor's
 * behalf, so issuing it is the same kind of act as approving them, and belongs
 * to the same people. It also keeps the audit trail honest — a departed cook is
 * removed by somebody with a reason to do it, rather than by whoever still
 * knows the password.
 *
 * The cost is that adding a second cook is a support request. At pilot scale
 * that is cheaper than a permissions UI nobody has asked for.
 *
 * THIS EXISTS BECAUSE THE GATE POINTED AT NOTHING
 *
 * `NO_STAFF_ACCOUNT` has been a blocker since the activation gate was written,
 * and until now the only way to clear it was an INSERT by hand. A checklist item
 * that names a problem and offers no way to fix it is a worse failure than not
 * checking: it stops onboarding dead and looks like a broken console.
 */

import type { Kysely } from 'kysely';

import { assertPasswordAcceptable, hashPassword } from '../identity/password.js';
import { buildAuditEntry } from '../platform/audit.js';
import { AuditRepository } from '../platform/audit.repository.js';
import { AppError } from '../platform/errors.js';
import type { Database } from '../platform/schema.js';

/**
 * The two roles a kitchen account can hold.
 *
 * `VENDOR_OPERATOR` is a cook: the board, and the four transitions on it.
 * `VENDOR_OWNER` adds menu writes and the vendor's own profile.
 *
 * `MANAGER`, `PLATFORM_OPS` and the rest are deliberately not offered. This
 * endpoint creates accounts scoped to one stall; a platform role scoped to a
 * vendor is a contradiction, and offering it in a dropdown is how somebody ends
 * up with one.
 */
export const KITCHEN_ROLES = ['VENDOR_OPERATOR', 'VENDOR_OWNER'] as const;
export type KitchenRole = (typeof KITCHEN_ROLES)[number];

export interface StaffAccount {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: KitchenRole;
  readonly active: boolean;
  readonly createdAt: Date;
}

export class StaffRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.audit = new AuditRepository(db);
  }

  /**
   * Everyone who can sign in to this stall's board.
   *
   * Revoked accounts are listed too, greyed rather than hidden. "Who used to
   * have access" is the question somebody asks after an incident, and a list
   * that silently drops them cannot answer it.
   */
  async list(vendorId: string): Promise<StaffAccount[]> {
    const rows = await this.db
      .selectFrom('user_role_assignment as ura')
      .innerJoin('platform_user as pu', 'pu.id', 'ura.user_id')
      .where('ura.vendor_id', '=', vendorId)
      .where('ura.role', 'in', KITCHEN_ROLES)
      .select([
        'pu.id as user_id',
        'pu.email',
        'pu.display_name',
        'pu.status as user_status',
        'ura.role',
        'ura.status as assignment_status',
        'pu.created_at',
      ])
      .orderBy('pu.created_at', 'asc')
      .execute();

    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email ?? '',
      displayName: r.display_name,
      role: r.role as KitchenRole,
      // BOTH must be active. A live assignment on a suspended user cannot sign
      // in, so counting it would let a stall pass the gate with no working
      // login — the exact failure the gate exists to prevent.
      active: r.user_status === 'ACTIVE' && r.assignment_status === 'ACTIVE',
      createdAt: r.created_at,
    }));
  }

  /**
   * Issue a login.
   *
   * THE PASSWORD IS RETURNED ONCE AND NEVER STORED IN PLAINTEXT.
   *
   * `password_hash` is scrypt. There is no "show password" later and no reset
   * flow yet, so the console must display it at creation and say plainly that
   * it will not be shown again. Generating it server-side rather than asking
   * the operator to invent one avoids the predictable outcome where every stall
   * in the court shares `kitchen123`.
   */
  async create(
    vendorId: string,
    input: { email: string; displayName: string; role: KitchenRole; password: string },
  ): Promise<{ account: StaffAccount; password: string }> {
    const vendor = await this.db
      .selectFrom('vendor')
      .select(['id', 'food_court_id', 'status'])
      .where('id', '=', vendorId)
      .executeTakeFirst();

    if (!vendor) throw new AppError('QR_INVALID', 'No such stall.');
    if (vendor.status === 'INACTIVE') {
      throw new AppError('INVALID_TRANSITION', 'That stall has closed. It cannot be given logins.');
    }

    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('OPTION_RULE_VIOLATION', 'That does not look like an email address.');
    }
    if (displayName.length < 2) {
      throw new AppError('OPTION_RULE_VIOLATION', 'Give the person a name — it appears on the board.');
    }

    assertPasswordAcceptable(input.password);

    // `platform_user.email` is CITEXT, so this compares case-insensitively and
    // the check matches what the unique index would enforce.
    const existing = await this.db
      .selectFrom('platform_user')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (existing) {
      /*
       * The message names the way OUT, because there are two of them and
       * neither is obvious from here.
       *
       * "Already has an account" used to be the whole message, and it is a dead
       * end for the commonest case by far: the password was forgotten. The
       * operator's instinct is to make a second login, this refuses, and there
       * is nothing else on the screen to try. Before `resetPassword` existed
       * the real answer was an UPDATE typed into psql.
       */
      throw new AppError(
        'CROSS_VENDOR_CART',
        `${email} already has an account. One person, one login. ` +
          `If they forgot the password, use Reset on their row instead — ` +
          `if they need access to this stall as well, assign the existing account.`,
      );
    }

    const password_hash = await hashPassword(input.password);

    const userId = await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('platform_user')
        .values({ email, display_name: displayName, password_hash, status: 'ACTIVE' })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('user_role_assignment')
        .values({
          user_id: user.id,
          role: input.role,
          vendor_id: vendorId,
          // Scoped to the court as well as the stall. `decide` reads both, and
          // an assignment with a vendor but no court cannot answer a
          // court-scoped question about itself.
          food_court_id: vendor.food_court_id,
          status: 'ACTIVE',
        })
        .execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'user.invited',
          entity: 'platform_user',
          entityId: user.id,
          foodCourtId: vendor.food_court_id,
          vendorId,
          // The email and role, never the password or its hash. `redact` would
          // catch a field called `password`; not putting it here is better.
          afterValue: { email, displayName, role: input.role },
        }),
        trx,
      );

      await this.audit.write(
        buildAuditEntry({
          action: 'role.assigned',
          entity: 'user_role_assignment',
          entityId: user.id,
          foodCourtId: vendor.food_court_id,
          vendorId,
          afterValue: { role: input.role },
        }),
        trx,
      );

      return user.id;
    });

    const account = (await this.list(vendorId)).find((a) => a.userId === userId);
    if (!account) throw new AppError('INTERNAL', 'The account was created but could not be read back.');

    return { account, password: input.password };
  }

  /**
   * Issue a new password for an existing login.
   *
   * ==========================================================================
   * WHY THIS HAD TO EXIST
   * ==========================================================================
   *
   * `create` returns the password once and stores only a scrypt hash, which is
   * correct — a recoverable password means one database leak hands over every
   * kitchen account in every court, and it means the platform can silently
   * impersonate a vendor.
   *
   * But "shown once" is only defensible if there is a way to issue another one,
   * and there was not. The dead end was worse than it looks, because the
   * obvious workaround is also closed:
   *
   *   revoke, then create again  →  `revoke` deliberately does not delete the
   *                                 `platform_user` row (audit_log and every
   *                                 acknowledged order reference it), so the
   *                                 email still exists and `create` refuses it
   *                                 with "one person, one login"
   *
   * So a cook who forgot their password could not be let back in from the
   * console at all. The recovery was an UPDATE typed into psql by hand — on the
   * password column, in production, under time pressure during a lunch rush.
   * That is how a stall ends up sharing one login, or how somebody sets every
   * hash to the same known value.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO
   *
   * It does not un-revoke. A suspended account stays suspended and this throws:
   * revoking is a decision somebody made for a reason, and quietly reversing it
   * because a password was reset would turn an access control into an
   * inconvenience. Reinstating is a separate act and should look like one.
   */
  async resetPassword(
    vendorId: string,
    userId: string,
    password: string,
  ): Promise<{ account: StaffAccount; password: string }> {
    const assignment = await this.db
      .selectFrom('user_role_assignment as ura')
      .innerJoin('vendor as v', 'v.id', 'ura.vendor_id')
      .innerJoin('platform_user as u', 'u.id', 'ura.user_id')
      .where('ura.vendor_id', '=', vendorId)
      .where('ura.user_id', '=', userId)
      .where('ura.role', 'in', KITCHEN_ROLES)
      .select(['ura.id as assignmentId', 'ura.status as roleStatus', 'u.status as userStatus', 'v.food_court_id'])
      .executeTakeFirst();

    if (!assignment) {
      throw new AppError('QR_INVALID', 'That account does not have access to this stall.');
    }

    // Scoped to THIS stall's assignment, so a platform operator cannot reset the
    // password of somebody who merely happens to share an email domain — the
    // join above is the authorisation, not a convenience.
    if (assignment.roleStatus !== 'ACTIVE' || assignment.userStatus !== 'ACTIVE') {
      throw new AppError(
        'INVALID_TRANSITION',
        'That login is revoked. Reinstating access is a separate decision from resetting a password.',
      );
    }

    const password_hash = await hashPassword(password);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('platform_user')
        .set({ password_hash })
        .where('id', '=', userId)
        .execute();

      await this.audit.write(
        buildAuditEntry({
          action: 'user.password_reset',
          entity: 'platform_user',
          entityId: userId,
          foodCourtId: assignment.food_court_id,
          vendorId,
          /*
           * No password, no hash, and no before-value.
           *
           * `redact` would catch a field named `password`, but the rule here is
           * simpler and does not depend on a helper being right: the audit row
           * records THAT a reset happened and who did it. The secret is not
           * part of that fact, and an audit log is read by more people than a
           * password store ever should be.
           */
          afterValue: { reset: true },
        }),
        trx,
      );
    });

    const account = (await this.list(vendorId)).find((a) => a.userId === userId);
    if (!account) throw new AppError('INTERNAL', 'The password was reset but the account could not be read back.');

    return { account, password };
  }

  /**
   * Revoke access.
   *
   * Suspends the USER, not just the assignment, and does not delete either.
   * `audit_log` and every order this person acknowledged reference the user id;
   * a deleted row turns "who accepted this order" into a dangling key on
   * exactly the records an investigation would start from.
   */
  async revoke(vendorId: string, userId: string, reason: string): Promise<StaffAccount[]> {
    const assignment = await this.db
      .selectFrom('user_role_assignment as ura')
      .innerJoin('vendor as v', 'v.id', 'ura.vendor_id')
      .where('ura.vendor_id', '=', vendorId)
      .where('ura.user_id', '=', userId)
      .where('ura.role', 'in', KITCHEN_ROLES)
      .select(['ura.id', 'ura.role', 'v.food_court_id'])
      .executeTakeFirst();

    if (!assignment) {
      throw new AppError('QR_INVALID', 'That account does not have access to this stall.');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('user_role_assignment')
        .set({ status: 'INACTIVE' })
        .where('id', '=', assignment.id)
        .execute();

      /**
       * Suspend the person too, but ONLY if this was their last live role.
       *
       * Someone can legitimately hold a role at two stalls. Suspending the user
       * on the first revoke would lock them out of the second, which reads as a
       * bug and gets worked around by re-activating the user — quietly undoing
       * the revoke that was actually wanted.
       */
      const remaining = await trx
        .selectFrom('user_role_assignment')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();

      if (!remaining) {
        await trx
          .updateTable('platform_user')
          .set({ status: 'SUSPENDED' })
          .where('id', '=', userId)
          .execute();
      }

      await this.audit.write(
        buildAuditEntry({
          action: 'role.revoked',
          entity: 'user_role_assignment',
          entityId: userId,
          foodCourtId: assignment.food_court_id,
          vendorId,
          beforeValue: { role: assignment.role, status: 'ACTIVE' },
          afterValue: {
            status: 'INACTIVE',
            reason,
            userSuspended: !remaining,
          },
        }),
        trx,
      );
    });

    return this.list(vendorId);
  }
}

/**
 * A password somebody has to read off a screen and type into a tablet.
 *
 * Four words from a small list, not a random string. `correct-horse-battery`
 * survives being read aloud across a kitchen and typed with wet hands;
 * `xK9#mP2$` does not, and the predictable result is a sticky note on the
 * tablet — which is a worse outcome than the weaker password.
 *
 * The list deliberately avoids characters that look alike in the console's
 * monospace face and words that could read as instructions.
 */
const WORDS = [
  'amber', 'anchor', 'basil', 'bright', 'canvas', 'cedar', 'cinder', 'clover',
  'copper', 'cotton', 'ember', 'falcon', 'garnet', 'ginger', 'harbour', 'indigo',
  'jasmine', 'kettle', 'lantern', 'linen', 'maple', 'marble', 'meadow', 'nutmeg',
  'olive', 'orchard', 'pebble', 'pepper', 'quartz', 'ribbon', 'saffron', 'sienna',
  'silver', 'summit', 'thistle', 'timber', 'velvet', 'walnut', 'willow', 'zinc',
] as const;

export function generatePassword(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  // Four words from 40 is ~21 bits, which is weak on its own — the length floor
  // is what carries this. `assertPasswordAcceptable` requires 12 characters and
  // four of these always clear it; the digits push it further without adding a
  // character class rule NIST advises against.
  const words = [...bytes].slice(0, 3).map((b) => WORDS[b % WORDS.length]);
  const digits = String(100 + (bytes[3]! % 900));
  return `${words.join('-')}-${digits}`;
}
