/**
 * The Ed25519 keypair that signs staff and session tokens.
 *
 * Derived deterministically from a 32-byte seed so that every process in a
 * deployment — API, worker, a second replica — signs and verifies with the
 * same key without needing a shared key store. Generating a fresh keypair per
 * process would silently invalidate every token issued by any other one, and
 * the symptom is intermittent 401s that vanish when you restart, which is
 * about the worst bug shape there is.
 *
 * Interface Specifications §2.
 */

import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';

import { config } from '../platform/config.js';
import type { Keys } from './tokens.js';

/**
 * Node has no "Ed25519 key from raw seed" API, so the seed is wrapped in the
 * fixed PKCS#8 preamble for Ed25519 and imported as DER. The bytes are the
 * ASN.1 header for `PrivateKeyInfo { version 0, algorithm id-Ed25519,
 * privateKey OCTET STRING (32) }` — constant for every Ed25519 key.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new Error(`AUTH_SIGNING_SEED must decode to exactly 32 bytes, got ${seed.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

let cached: Keys | undefined;

export function authKeys(): Keys {
  if (cached) return cached;

  const cfg = config();
  const seedB64 = cfg.AUTH_SIGNING_SEED;

  const seed = Buffer.from(seedB64, 'base64');
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = createPublicKey(privateKey);

  cached = { privateKey, publicKey };
  return cached;
}

/** For `.env.example` and the setup docs. Not called at runtime. */
export function generateSeed(): string {
  return randomBytes(32).toString('base64');
}

/** Tests mutate config between cases; without this they share a stale key. */
export function __resetKeysForTests(): void {
  cached = undefined;
}
