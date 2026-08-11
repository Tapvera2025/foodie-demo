/**
 * Configuration. Validated with Zod at boot; the process must not start with an
 * invalid config.
 *
 * Inventory: TDD §14. Infra & Ops §2.2.
 */

import { z } from 'zod';

const boolFromString = z.enum(['true', 'false']).transform((v) => v === 'true');

const intFromString = (min: number, max: number): z.ZodNumber =>
  z.coerce.number().int().min(min).max(max);

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromString(1, 65535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /**
   * THIS FIELD HAS NO DEFAULT, DELIBERATELY.
   *
   * If GST s.9(5) applies, the platform is the e-commerce operator liable for
   * tax on the restaurant service and must RETAIN the food GST rather than
   * settle it to the vendor (PRD §4.7, TDD §4.1 line 14).
   *
   * A boolean that silently defaults to `false` is how a platform overpays every
   * vendor by ~5% of order value against a ~3% commission — roughly ₹52,800 per
   * court per month of unrecoverable leakage.
   *
   * If you are here because a test or a deploy failed with
   * "TAX_SECTION_9_5_APPLIES: Required", set the value explicitly. Do not add a
   * default to make the error go away.
   */
  TAX_SECTION_9_5_APPLIES: boolFromString,

  TAX_FOOD_GST_BPS: intFromString(0, 10000).default(500),
  TAX_FEE_GST_BPS: intFromString(0, 10000).default(1800),

  PAYMENTS_PROVIDER: z.enum(['razorpay-route', 'vendor-direct', 'stub']).default('stub'),
  PAYMENTS_SPLIT_TIMING: z.enum(['ON_CAPTURE', 'ON_ACKNOWLEDGED']).default('ON_ACKNOWLEDGED'),

  // Dispatch escalation ladder, seconds (PRD §11.4).
  DISPATCH_LADDER_STEP1_SECONDS: intFromString(1, 3600).default(15),
  DISPATCH_LADDER_STEP2_SECONDS: intFromString(1, 3600).default(45),
  DISPATCH_LADDER_STEP3_SECONDS: intFromString(1, 3600).default(90),
  DISPATCH_LADDER_STEP4_SECONDS: intFromString(1, 3600).default(180),

  // Vendor device liveness (PRD KDS-HB-01/02).
  DEVICE_HEARTBEAT_INTERVAL_SECONDS: intFromString(1, 300).default(15),
  DEVICE_OFFLINE_THRESHOLD_SECONDS: intFromString(1, 3600).default(60),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(issues);
  }

  const cfg = parsed.data;

  // Ladder steps must be strictly increasing, or an escalation can fire out of
  // order and block a vendor before the first retry has been attempted.
  const ladder = [
    cfg.DISPATCH_LADDER_STEP1_SECONDS,
    cfg.DISPATCH_LADDER_STEP2_SECONDS,
    cfg.DISPATCH_LADDER_STEP3_SECONDS,
    cfg.DISPATCH_LADDER_STEP4_SECONDS,
  ];
  for (let i = 1; i < ladder.length; i++) {
    const prev = ladder[i - 1] as number;
    const cur = ladder[i] as number;
    if (cur <= prev) {
      throw new ConfigError([
        `DISPATCH_LADDER steps must strictly increase, got [${ladder.join(', ')}]`,
      ]);
    }
  }

  return cfg;
}

let cached: Config | undefined;

export function config(): Config {
  if (cached === undefined) cached = loadConfig();
  return cached;
}

/** Test-only. Resets the memoised config. */
export function __resetConfigForTests(): void {
  cached = undefined;
}
