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
  /**
   * 32 bytes, base64. Signs every staff and session token.
   *
   * No default, for the same reason as the tax flag: a fallback here means
   * every deployment that forgets to set it shares a key that is in the source
   * history, and anyone who has read the repo can mint a SUPER_ADMIN token.
   * Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  AUTH_SIGNING_SEED: z
    .string()
    .min(43)
    /**
     * The length that matters is the DECODED one.
     *
     * `.min(43)` measured the base64 string. A 43-character string that decodes
     * to 38 bytes passed validation, passed `/readyz`, and then threw an
     * unhandled 500 from `privateKeyFromSeed` on the first customer OTP verify
     * — the first request that actually needed to sign something. Ed25519 wants
     * exactly 32 bytes and the boot check should ask the same question the key
     * constructor does.
     */
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message:
        'must be exactly 32 bytes when base64-decoded. Generate one with:\n' +
        '      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    }),

  TAX_SECTION_9_5_APPLIES: boolFromString,

  TAX_FOOD_GST_BPS: intFromString(0, 10000).default(500),
  TAX_FEE_GST_BPS: intFromString(0, 10000).default(1800),

  PAYMENTS_PROVIDER: z
    .enum(['cashfree', 'razorpay-route', 'vendor-direct', 'stub'])
    .default('stub'),

  /**
   * ==========================================================================
   * CASHFREE
   * ==========================================================================
   *
   * Optional, like the AI keys and for the same reason: a developer working on
   * the menu must be able to boot the API without holding live payment
   * credentials. `PAYMENTS_PROVIDER=stub` is the default and needs none of
   * this. Selecting `cashfree` without them fails at startup with a sentence
   * naming the missing variable, which is better than a 401 at checkout.
   *
   * NEITHER SECRET LEAVES THIS PROCESS. `CASHFREE_SECRET_KEY` signs
   * server-to-server calls and verifies inbound webhook signatures; the browser
   * receives only a `payment_session_id`, which is single-use and scoped to one
   * order. The app id is not secret but is kept beside the secret so both come
   * from one place.
   */
  CASHFREE_APP_ID: z.string().min(1).optional(),
  CASHFREE_SECRET_KEY: z.string().min(1).optional(),

  /**
   * `sandbox` or `production`, and it is its own variable rather than being
   * inferred from NODE_ENV.
   *
   * Inferring it is a one-character mistake away from taking real money in a
   * staging environment. Cashfree issues DIFFERENT credentials per environment,
   * so a mismatch between key and base URL fails loudly — but only if the two
   * are chosen together, which is what this makes explicit.
   */
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  /**
   * The dated API version Cashfree pins behaviour to. Sent on every request.
   *
   * Explicit and overridable because Cashfree ships breaking changes behind new
   * dates, and the alternative — whatever their default is this quarter — means
   * the integration can change under a deploy that touched nothing.
   */
  CASHFREE_API_VERSION: z.string().min(8).default('2023-08-01'),

  /**
   * Where CASHFREE sends webhooks. Server to server, so it must be an
   * absolute, publicly reachable https URL — Cashfree cannot reach `localhost`
   * and local webhook testing needs a tunnel.
   *
   * Absent, `notify_url` is omitted and no webhook ever arrives; the server
   * then learns outcomes only by polling `getStatus`, which is slower but
   * never wrong.
   *
   * THIS USED TO GATE `return_url` TOO, and that was a real bug: with no
   * tunnel the order was created with no return URL at all, and Cashfree's v3
   * checkout refuses to render without one. Local payments failed with
   * "Something went wrong" while the session itself was perfectly valid. The
   * two URLs are followed by different parties and have different
   * requirements — see `CASHFREE_RETURN_BASE_URL`.
   */
  CASHFREE_PUBLIC_BASE_URL: z.string().url().optional(),

  /**
   * Where the CUSTOMER'S BROWSER returns after paying.
   *
   * Only has to be reachable from the customer's own device, so unlike the
   * webhook URL this is satisfied by `http://localhost:5173` in development —
   * no tunnel, no public hostname.
   *
   * Optional here and defaulted in `provider.factory.ts`, which is the one
   * place that knows both `NODE_ENV` and how the provider is assembled. In
   * production it should be the customer app's real origin; leaving it unset
   * there falls back to `CASHFREE_PUBLIC_BASE_URL`, which is correct because
   * the apps are served same-origin with the API.
   */
  CASHFREE_RETURN_BASE_URL: z.string().url().optional(),
  PAYMENTS_SPLIT_TIMING: z.enum(['ON_CAPTURE', 'ON_ACKNOWLEDGED']).default('ON_ACKNOWLEDGED'),

  /**
   * Verifies inbound webhook signatures.
   *
   * Has a development default, unlike AUTH_SIGNING_SEED, because it only needs
   * to match the stub — which is not a real provider and cannot move money. The
   * production check is elsewhere: `payment.module.ts` refuses to construct the
   * stub provider at all when NODE_ENV is production, so a deployment that
   * forgot to set this cannot reach the code that would use the default.
   */
  PAYMENTS_WEBHOOK_SECRET: z.string().min(8).default('stub-secret'),

  /**
   * Where one-time codes go.
   *
   * `console` prints them to the log and is the only channel available until
   * DLT registration completes — PRD §19 decision 1, the item that blocks
   * orders entirely. It refuses to run in production; see src/identity/otp.ts.
   */
  OTP_CHANNEL: z.enum(['console', 'sms', 'whatsapp']).default('console'),
  OTP_TTL_SECONDS: intFromString(30, 900).default(300),
  OTP_MAX_VERIFY_ATTEMPTS: intFromString(1, 10).default(5),
  /** Per phone number, per window. An SMS costs money and this is unauthenticated. */
  OTP_SEND_PER_PHONE_PER_HOUR: intFromString(1, 100).default(5),
  OTP_SEND_PER_IP_PER_HOUR: intFromString(1, 1000).default(20),

  // Dispatch escalation ladder, seconds (PRD §11.4).
  DISPATCH_LADDER_STEP1_SECONDS: intFromString(1, 3600).default(15),
  DISPATCH_LADDER_STEP2_SECONDS: intFromString(1, 3600).default(45),
  DISPATCH_LADDER_STEP3_SECONDS: intFromString(1, 3600).default(90),
  DISPATCH_LADDER_STEP4_SECONDS: intFromString(1, 3600).default(180),

  /**
   * Where a stuck order wakes somebody up.
   *
   * E.164, and OPTIONAL on purpose. An unset value must not stop the platform
   * booting — but it also must not silently mean "no alerting". With this
   * empty, every ops tier records a SKIPPED row saying there was nobody to
   * send to, which is the difference between knowing nobody was called and
   * assuming somebody was.
   *
   * Nobody from the platform is in the building any more; this is the only
   * channel by which a stall that has gone quiet reaches a human.
   */
  OPS_ONCALL_PHONE: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, as +919876543210')
    .optional(),

  /**
   * Image storage. Cloudinary today, a local server later.
   *
   * ALL THREE OPTIONAL, and that is deliberate in both directions. A missing
   * key must not stop the platform booting — orders, payments and the kitchen
   * board have nothing to do with photographs, and refusing to start over a
   * decorative feature would be the config equivalent of a broken window.
   *
   * But absent must not silently mean "uploads work differently either". With
   * these unset the storage port is `UnconfiguredStorage`, which refuses every
   * signature with a message naming the variables — so the failure lands on
   * whoever can fix it rather than on a vendor whose button does nothing.
   *
   * THE SECRET IS SIGNING MATERIAL AND NEVER LEAVES THIS PROCESS. It is used to
   * sign uploads the browser then performs directly; it is not sent to the
   * client, not logged, and not in any response.
   */
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),

  /**
   * ==========================================================================
   * AI DISH DESCRIPTIONS
   * ==========================================================================
   *
   * Both keys are OPTIONAL, and the feature is off when neither is set. A
   * required key would mean a developer cannot start the API without holding a
   * paid credential for a feature they are not touching — and the failure would
   * arrive as a config parse error at boot, which is the least informative
   * place for it. Absent keys instead produce one clear error at the point of
   * use, on the one screen that has the button.
   *
   * NEITHER KEY LEAVES THIS PROCESS. They authenticate a server-to-server call;
   * they are not sent to the kitchen board, not returned in any response, and
   * not logged. `describeStatus()` reports which providers are CONFIGURED as
   * booleans, which is all any client needs to know.
   *
   * Two providers because one is a single point of failure on a screen a
   * kitchen owner is standing at. Grok answers first; NVIDIA's Nemotron via
   * OpenRouter answers when it does not.
   */
  XAI_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),

  /**
   * Overridable model strings, because the model a provider recommends changes
   * faster than a deploy cycle and pinning them in code makes a routine swap a
   * code review.
   */
  /*
   * `grok-4.6`, checked against x.ai's live model list rather than recalled.
   *
   * Two earlier guesses here were wrong in the same way: `grok-3-mini` and
   * `grok-4-fast-non-reasoning` are both names from before x.ai's 15 May model
   * retirement. A retired model name is a 404 on every call, and the only
   * symptom a kitchen would see is the button quietly falling through to the
   * fallback for ever — with the primary's failure buried in the ledger.
   *
   * The bare name is an ALIAS to the latest stable release, which is what x.ai
   * recommends for callers who want fixes without a redeploy. Pin
   * `<model>-<date>` here if a specific release is ever needed.
   */
  XAI_MODEL: z.string().min(1).default('grok-4.6'),
  /*
   * Verified against OpenRouter's live model list, not guessed. The first
   * version of this line said `nvidia/nemotron-nano-9b-v2`, which does not
   * exist — every fallback call would have 404'd, and the only symptom would
   * have been "the button does not work" on the day Grok was down.
   *
   * There is also a `:free` variant of this slug. Not the default: a free tier
   * is rate-limited and deprioritised, which is the wrong shape for the request
   * that only runs when the primary has already failed.
   */
  OPENROUTER_MODEL: z.string().min(1).default('nvidia/nemotron-3.5-lightning'),

  /**
   * A hard ceiling on how long a kitchen owner stares at a spinner.
   *
   * Twelve seconds is generous for a 40-word completion and short enough that
   * the fallback still has room to answer inside a request the browser has not
   * given up on. It bounds EACH provider, not the pair.
   */
  AI_DESCRIPTION_TIMEOUT_MS: intFromString(1000, 60_000).default(12_000),

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
