import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TAX_SECTION_9_5_APPLIES: 'true',
  // 32 bytes, base64. Added to ConfigSchema without a default, deliberately —
  // and this fixture was not updated with it, so three cases in this file have
  // been failing on every clean checkout since. Exactly the drift the tax flag
  // above is designed to cause loudly rather than quietly.
  AUTH_SIGNING_SEED: 'TfLK3O5RF6lg6We08OCyWPb5IHs0ZfeiDG4NMfneTjY=',
};

describe('loadConfig()', () => {
  it('loads a valid config', () => {
    const c = loadConfig(valid as NodeJS.ProcessEnv);
    expect(c.TAX_SECTION_9_5_APPLIES).toBe(true);
    expect(c.PORT).toBe(3000);
    expect(c.TAX_FOOD_GST_BPS).toBe(500);
    expect(c.PAYMENTS_SPLIT_TIMING).toBe('ON_ACKNOWLEDGED');
  });

  /**
   * The single most important test in this file.
   *
   * PRD §4.7 / TDD §14: if s.9(5) applies, the platform must retain the food GST
   * rather than settle it to the vendor. A boolean defaulting to false is how a
   * platform overpays every vendor by ~5% of order value against a ~3%
   * commission. The application must refuse to start.
   */
  it('REFUSES to load without an explicit tax determination', () => {
    const { TAX_SECTION_9_5_APPLIES: _omitted, ...withoutTax } = valid;
    expect(() => loadConfig(withoutTax as NodeJS.ProcessEnv)).toThrow(ConfigError);

    try {
      loadConfig(withoutTax as NodeJS.ProcessEnv);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join()).toContain('TAX_SECTION_9_5_APPLIES');
    }
  });

  it('rejects a non-boolean tax determination rather than coercing it', () => {
    // "yes", "1" and "" must all fail. Coercion here would defeat the point.
    for (const bad of ['yes', '1', '', 'TRUE', 'maybe']) {
      expect(() =>
        loadConfig({ ...valid, TAX_SECTION_9_5_APPLIES: bad } as NodeJS.ProcessEnv),
      ).toThrow(ConfigError);
    }
  });

  it('accepts an explicit false', () => {
    const c = loadConfig({ ...valid, TAX_SECTION_9_5_APPLIES: 'false' } as NodeJS.ProcessEnv);
    expect(c.TAX_SECTION_9_5_APPLIES).toBe(false);
  });

  it('requires the database and redis urls', () => {
    const { DATABASE_URL: _d, ...noDb } = valid;
    expect(() => loadConfig(noDb as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  /**
   * The QR base URL, which is the one value that gets laminated.
   *
   * A wrong `DATABASE_URL` stops the process and somebody fixes it. A
   * `PWA_BASE_URL` of `localhost` starts cleanly, serves every request
   * correctly, and encodes a dead address into every poster in the court —
   * discovered by a customer holding a phone, days after the print run.
   */
  it('defaults the QR base url, and validates its shape', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv).PWA_BASE_URL).toBe('http://localhost:5173');

    for (const bad of ['not-a-url', 'localhost:5173', '/t', '']) {
      expect(() =>
        loadConfig({ ...valid, PWA_BASE_URL: bad } as NodeJS.ProcessEnv),
      ).toThrow(ConfigError);
    }
  });

  it('REFUSES a loopback QR base url in production', () => {
    for (const loopback of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://0.0.0.0:5173',
      'http://[::1]:5173',
    ]) {
      expect(() =>
        loadConfig({
          ...valid,
          NODE_ENV: 'production',
          PWA_BASE_URL: loopback,
        } as NodeJS.ProcessEnv),
      ).toThrow(ConfigError);
    }
  });

  /**
   * The default is a loopback address, so production with the variable UNSET
   * must fail too — otherwise the refusal above only catches the deployment
   * that tried, and misses the one that forgot.
   */
  it('REFUSES production with the QR base url left unset', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('accepts a real origin in production', () => {
    const c = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      PWA_BASE_URL: 'https://order.example.com',
    } as NodeJS.ProcessEnv);
    expect(c.PWA_BASE_URL).toBe('https://order.example.com');
  });

  /**
   * Counter identity without a counter.
   *
   * The mode drops the OTP gate on the promise that a cashier and a card
   * machine stand between an order and its food. Pointed at a remote
   * aggregator there is no cashier, nobody is present, and the product has
   * simply stopped asking who is buying — with nothing in the logs to say so.
   */
  it('REFUSES counter identity unless payments settle at a POS terminal', () => {
    for (const provider of ['stub', 'cashfree', 'razorpay-route', 'vendor-direct']) {
      expect(() =>
        loadConfig({
          ...valid,
          ORDER_IDENTITY_MODE: 'counter',
          PAYMENTS_PROVIDER: provider,
        } as NodeJS.ProcessEnv),
      ).toThrow(ConfigError);
    }
  });

  it('accepts counter identity alongside a POS terminal', () => {
    const c = loadConfig({
      ...valid,
      ORDER_IDENTITY_MODE: 'counter',
      PAYMENTS_PROVIDER: 'pos',
    } as NodeJS.ProcessEnv);
    expect(c.ORDER_IDENTITY_MODE).toBe('counter');
  });

  /**
   * The default is the one that matters here. Every deployment that has never
   * heard of this setting must keep requiring an OTP.
   */
  it('defaults to requiring a verified mobile number', () => {
    expect(loadConfig(valid as NodeJS.ProcessEnv).ORDER_IDENTITY_MODE).toBe('otp');
  });

  it('rejects an unknown identity mode rather than falling back', () => {
    for (const bad of ['none', 'anonymous', 'OTP', '']) {
      expect(() =>
        loadConfig({ ...valid, ORDER_IDENTITY_MODE: bad } as NodeJS.ProcessEnv),
      ).toThrow(ConfigError);
    }
  });

  it('rejects a non-increasing escalation ladder', () => {
    // A ladder that fires out of order can block a vendor before the first
    // redispatch has even been attempted. PRD §11.4.
    expect(() =>
      loadConfig({
        ...valid,
        DISPATCH_LADDER_STEP2_SECONDS: '10',
        DISPATCH_LADDER_STEP1_SECONDS: '15',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('accepts a custom but valid ladder', () => {
    const c = loadConfig({
      ...valid,
      DISPATCH_LADDER_STEP1_SECONDS: '10',
      DISPATCH_LADDER_STEP2_SECONDS: '30',
      DISPATCH_LADDER_STEP3_SECONDS: '60',
      DISPATCH_LADDER_STEP4_SECONDS: '120',
    } as NodeJS.ProcessEnv);
    expect(c.DISPATCH_LADDER_STEP4_SECONDS).toBe(120);
  });

  it('rejects an out-of-range gst rate', () => {
    expect(() => loadConfig({ ...valid, TAX_FOOD_GST_BPS: '20000' } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    );
  });
});
