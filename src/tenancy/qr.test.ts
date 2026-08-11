import { describe, it, expect } from 'vitest';
import {
  generateQrToken,
  isValidQrTokenFormat,
  assertValidQrTokenFormat,
  buildQrUrl,
  QR_TOKEN_LENGTH,
  QR_ASSET,
} from './qr.js';
import { AppError } from '../platform/errors.js';

describe('QR token generation (SEC-02)', () => {
  it('is 22 characters of base62', () => {
    const t = generateQrToken();
    expect(t).toHaveLength(QR_TOKEN_LENGTH);
    expect(isValidQrTokenFormat(t)).toBe(true);
  });

  it('is not derived from anything guessable', () => {
    // 10,000 tokens, zero collisions, and no visible structure.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateQrToken());
    expect(seen.size).toBe(10_000);
  });

  it('uses the full alphabet rather than a narrow slice', () => {
    // A weak encoder that only ever emitted digits would still pass the format
    // check, so assert the character distribution is actually wide.
    const chars = new Set<string>();
    for (let i = 0; i < 500; i++) for (const c of generateQrToken()) chars.add(c);
    expect(chars.size).toBeGreaterThan(50);
  });

  it('pads deterministically for small random values', () => {
    const tiny = (): Buffer => Buffer.alloc(16, 0);
    expect(generateQrToken(tiny)).toBe('0'.repeat(QR_TOKEN_LENGTH));
  });

  it('never exceeds the fixed length for the largest possible value', () => {
    const maxed = (): Buffer => Buffer.alloc(16, 0xff);
    expect(generateQrToken(maxed)).toHaveLength(QR_TOKEN_LENGTH);
  });
});

describe('token format validation', () => {
  it('rejects malformed tokens before touching the database', () => {
    // The most exposed unauthenticated endpoint in the product.
    for (const bad of [
      '',
      'short',
      'a'.repeat(23),
      'has-a-dash-in-it-abcdef',
      '../../etc/passwd',
    ]) {
      expect(isValidQrTokenFormat(bad)).toBe(false);
      expect(() => assertValidQrTokenFormat(bad)).toThrow(AppError);
    }
  });

  it('throws QR_INVALID, which the client maps to the recovery screen', () => {
    try {
      assertValidQrTokenFormat('nope');
    } catch (e) {
      expect((e as AppError).code).toBe('QR_INVALID');
      expect((e as AppError).httpStatus).toBe(404);
    }
  });
});

describe('QR URL', () => {
  it('builds a short URL that keeps the symbol at a low version', () => {
    const url = buildQrUrl({ baseUrl: 'https://tapvera.app', token: generateQrToken() });
    expect(url).toMatch(/^https:\/\/tapvera\.app\/t\/[0-9A-Za-z]{22}$/);
    expect(url.length).toBeLessThanOrEqual(60);
  });

  it('tolerates a trailing slash on the base url', () => {
    const url = buildQrUrl({ baseUrl: 'https://tapvera.app/', token: 'A'.repeat(22) });
    expect(url).toBe(`https://tapvera.app/t/${'A'.repeat(22)}`);
  });

  it('complains at generation time if the host is too long', () => {
    // Better to find this now than at a table, where it means smaller modules
    // and a code that will not scan in bad light.
    expect(() =>
      buildQrUrl({
        baseUrl: 'https://ordering.foodcourt.tapveratechnologies.example.com',
        token: 'A'.repeat(22),
      }),
    ).toThrow(AppError);
  });
});

describe('print asset parameters (QRA-01, QRA-02)', () => {
  it('uses error correction level H, not the usual M', () => {
    // These live on tables and get grease, scratches and condensation.
    expect(QR_ASSET.errorCorrectionLevel).toBe('H');
  });

  it('will not print smaller than 35mm', () => {
    expect(QR_ASSET.symbolSizeMm).toBeGreaterThanOrEqual(35);
  });

  it('keeps a four-module quiet zone', () => {
    expect(QR_ASSET.quietZoneModules).toBe(4);
  });

  it('is matte, because gloss reflects overhead lighting into the camera', () => {
    expect(QR_ASSET.finish).toBe('matte');
  });
});
