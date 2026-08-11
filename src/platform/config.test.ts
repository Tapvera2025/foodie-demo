import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TAX_SECTION_9_5_APPLIES: 'true',
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
