/**
 * Table QR tokens and print asset parameters.
 *
 * The QR code is the only entry point to the entire product. A code that will
 * not scan under food-court lighting, from a seated position, on a scratched
 * laminate, is a total failure of the product for that table — and it will be
 * blamed on the app.
 *
 * PRD CUS-QR-01, SEC-02. Interface Specs §5.
 */

import { randomBytes } from 'node:crypto';
import { AppError } from '../platform/errors.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 128 bits of entropy encoded base62 lands at 22 characters. */
export const QR_TOKEN_LENGTH = 22;
export const QR_TOKEN_ENTROPY_BITS = 128;

/**
 * An opaque, non-enumerable table token.
 *
 * PRD SEC-02: this is NOT derived from the table id. Sequential guessing must
 * yield nothing, and rate limiting makes trying pointless.
 */
export function generateQrToken(random: (n: number) => Buffer = randomBytes): string {
  // 16 bytes = 128 bits. Interpreted as a big integer and base62-encoded.
  let value = BigInt('0x' + random(16).toString('hex'));
  const base = BigInt(BASE62.length);
  let out = '';
  while (value > 0n) {
    out = BASE62[Number(value % base)] + out;
    value /= base;
  }
  return out.padStart(QR_TOKEN_LENGTH, '0').slice(-QR_TOKEN_LENGTH);
}

const TOKEN_RE = new RegExp(`^[0-9A-Za-z]{${QR_TOKEN_LENGTH}}$`);

export function isValidQrTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function assertValidQrTokenFormat(token: string): void {
  // Reject malformed tokens before touching the database — this is the most
  // exposed unauthenticated endpoint in the product.
  if (!isValidQrTokenFormat(token)) {
    throw new AppError('QR_INVALID', 'malformed token');
  }
}

export interface QrUrlParts {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Short host and a short path keep the encoded payload sparse, which keeps the
 * symbol at version 3–4 and the modules large enough to scan from a seated
 * arm's length. Interface Specs §5.1.
 */
export function buildQrUrl({ baseUrl, token }: QrUrlParts): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = `${trimmed}/t/${token}`;
  if (url.length > 60) {
    // Not fatal, but it pushes the QR to a higher version with smaller modules.
    // Worth knowing at generation time rather than at a table.
    throw new AppError(
      'QR_INVALID',
      `encoded URL is ${url.length} chars; keep it under 60 to stay at QR version 3-4`,
    );
  }
  return url;
}

/**
 * Generation parameters for the printed asset.
 *
 * Error correction is level H (30%), not the usual M. These live on tables and
 * will get grease, scratches and condensation; H tolerates a damaged corner.
 * Interface Specs §5.1, QRA-01.
 */
export const QR_ASSET = {
  errorCorrectionLevel: 'H',
  /** Minimum printed symbol size. Do not shrink to fit a design. QRA-02. */
  symbolSizeMm: 35,
  preferredSymbolSizeMm: 40,
  /** Four modules on all sides. The commonest cause of a code that will not scan. */
  quietZoneModules: 4,
  minModuleSizeMm: 0.8,
  /** Matte only. Gloss reflects overhead lighting straight into the camera. */
  finish: 'matte',
  foreground: '#000000',
  background: '#FFFFFF',
  /** H-level correction affords a small centred logo. Anything larger is a gamble. */
  maxLogoAreaRatio: 0.15,
} as const;
