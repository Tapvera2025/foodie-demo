/**
 * Staff login. Interface Specifications §2.
 *
 * Per-user accounts, not one shared login per stall. A kitchen genuinely does
 * share one tablet, so the temptation is a single "Spice Garden" account — but
 * then every rejection and every refund in the audit log is attributed to a
 * password on a sticky note, and revoking one departed cook means changing the
 * credential for everybody. Individual accounts keep both of those workable.
 */

import { Body, Controller, Inject, Post } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { authKeys } from './keys.js';
import { burnVerificationTime, verifyPassword } from './password.js';
import { issueToken, TOKEN_TTL_SECONDS, type StaffRoleClaim } from './tokens.js';

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export const STAFF_AUDIENCE = 'foodcourt-staff';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  @Post('login')
  async login(@Body() body: unknown): Promise<unknown> {
    const { email, password } = LoginBody.parse(body);

    const user = await this.db
      .selectFrom('platform_user')
      .select(['id', 'display_name', 'password_hash', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();

    // Identical failure for "no such user", "wrong password" and "suspended
    // but wrong password". Anything else turns this endpoint into an
    // account-existence oracle, and the list of who works where is the first
    // thing a phishing campaign needs.
    if (!user) {
      await burnVerificationTime();
      throw new AppError('INVALID_CREDENTIALS', 'That email and password do not match.');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      log().warn({ event: 'login_failed', userId: user.id }, 'bad password');
      throw new AppError('INVALID_CREDENTIALS', 'That email and password do not match.');
    }

    // Checked only AFTER the password verifies. Telling an attacker "this
    // account is suspended" before they prove they own it confirms it exists.
    if (user.status !== 'ACTIVE') {
      throw new AppError('ACCOUNT_SUSPENDED', 'This account is not active. Speak to your manager.');
    }

    const assignments = await this.db
      .selectFrom('user_role_assignment')
      .select(['role', 'food_court_id', 'vendor_id'])
      .where('user_id', '=', user.id)
      .where('status', '=', 'ACTIVE')
      .execute();

    if (assignments.length === 0) {
      // An account with no role can do nothing, so a token would be a token
      // for nothing. Fail here rather than issue one and 403 every request.
      throw new AppError('ACCOUNT_SUSPENDED', 'This account has no role assigned yet.');
    }

    const roles: StaffRoleClaim[] = assignments.map((a) => ({
      role: a.role,
      ...(a.food_court_id ? { fc: a.food_court_id } : {}),
      ...(a.vendor_id ? { vnd: a.vendor_id } : {}),
    }));

    const token = await issueToken(
      authKeys(),
      { typ: 'staff', sub: user.id, rol: roles, ver: 1 },
      { audience: STAFF_AUDIENCE },
    );

    log().info({ event: 'login_succeeded', userId: user.id }, 'staff signed in');

    return {
      token,
      expiresInSeconds: TOKEN_TTL_SECONDS.staff,
      user: {
        id: user.id,
        displayName: user.display_name,
        roles: roles.map((r) => ({ role: r.role, vendorId: r.vnd ?? null, foodCourtId: r.fc ?? null })),
      },
    };
  }
}
