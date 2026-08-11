import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from 'jose';
import {
  ALG,
  issueToken,
  verifyToken,
  generatePairingCode,
  TOKEN_TTL_SECONDS,
  type Keys,
  type DeviceClaims,
  type SessionClaims,
  type StaffClaims,
} from './tokens.js';
import { AppError } from '../platform/errors.js';

let keys: Keys;
let otherKeys: Keys;

beforeAll(async () => {
  const k = await generateKeyPair(ALG);
  keys = { privateKey: k.privateKey, publicKey: k.publicKey };
  const o = await generateKeyPair(ALG);
  otherKeys = { privateKey: o.privateKey, publicKey: o.publicKey };
});

const session: SessionClaims = {
  typ: 'session',
  sub: 'sess-1',
  fc: 'court-a',
  tbl: 'table-a12',
  cus: null,
};

const device: DeviceClaims = {
  typ: 'device',
  sub: 'dev-1',
  vnd: 'vendor-a1',
  fc: 'court-a',
  knd: 'KDS_TABLET',
  ver: 3,
};

const staff: StaffClaims = {
  typ: 'staff',
  sub: 'usr-1',
  rol: [{ role: 'MANAGER', fc: 'court-a' }],
  ver: 7,
};

describe('token round trip', () => {
  it('issues and verifies a session token', async () => {
    const t = await issueToken(keys, session, { audience: 'customer-pwa' });
    const claims = (await verifyToken(keys, t, {
      audience: 'customer-pwa',
      expectType: 'session',
    })) as SessionClaims;
    expect(claims.fc).toBe('court-a');
    expect(claims.tbl).toBe('table-a12');
    expect(claims.cus).toBeNull();
  });

  it('carries no PII in a session token', async () => {
    // Interface Specs §2.1 — deliberately anonymous.
    const t = await issueToken(keys, session, { audience: 'customer-pwa' });
    const body = JSON.parse(Buffer.from(t.split('.')[1] as string, 'base64url').toString());
    for (const forbidden of ['phone', 'name', 'email', 'payerReference']) {
      expect(body[forbidden]).toBeUndefined();
    }
  });
});

describe('a token is not accepted outside its purpose', () => {
  it('rejects a device token on a staff endpoint even though we signed it', async () => {
    const t = await issueToken(keys, device, { audience: 'kds' });
    await expect(
      verifyToken(keys, t, { audience: 'kds', expectType: 'staff' }),
    ).rejects.toMatchObject({ code: 'TOKEN_WRONG_TYPE' });
  });

  it('rejects a token issued for a different audience', async () => {
    const t = await issueToken(keys, device, { audience: 'kds' });
    await expect(
      verifyToken(keys, t, { audience: 'admin-console', expectType: 'device' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a token signed by someone else', async () => {
    const forged = await issueToken(otherKeys, staff, { audience: 'admin-console' });
    await expect(
      verifyToken(keys, forged, { audience: 'admin-console', expectType: 'staff' }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects a tampered payload', async () => {
    const t = await issueToken(keys, device, { audience: 'kds' });
    const [h, p, s] = t.split('.');
    const body = JSON.parse(Buffer.from(p as string, 'base64url').toString());
    body.vnd = 'vendor-somebody-else';
    const tampered = `${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`;
    await expect(
      verifyToken(keys, tampered, { audience: 'kds', expectType: 'device' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('revocation by token_version (AUTH-05)', () => {
  it('accepts a token whose version matches the current one', async () => {
    const t = await issueToken(keys, device, { audience: 'kds' });
    await expect(
      verifyToken(keys, t, { audience: 'kds', expectType: 'device', currentVersion: 3 }),
    ).resolves.toBeDefined();
  });

  it('rejects every issued token once the version is bumped', async () => {
    // Deactivating a device must stop it without a distributed blocklist.
    const t = await issueToken(keys, device, { audience: 'kds' });
    await expect(
      verifyToken(keys, t, { audience: 'kds', expectType: 'device', currentVersion: 4 }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('revokes staff tokens the same way', async () => {
    const t = await issueToken(keys, staff, { audience: 'admin-console' });
    await expect(
      verifyToken(keys, t, { audience: 'admin-console', expectType: 'staff', currentVersion: 8 }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('expiry', () => {
  it('rejects an expired token', async () => {
    const longAgo = new Date(Date.now() - (TOKEN_TTL_SECONDS.staff + 3600) * 1000);
    const t = await issueToken(keys, staff, { audience: 'admin-console', now: longAgo });
    await expect(
      verifyToken(keys, t, { audience: 'admin-console', expectType: 'staff' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('uses the lifetimes from Interface Specs §2', () => {
    expect(TOKEN_TTL_SECONDS.session).toBe(4 * 60 * 60);
    expect(TOKEN_TTL_SECONDS.device).toBe(30 * 24 * 60 * 60);
    expect(TOKEN_TTL_SECONDS.staff).toBe(30 * 60);
  });
});

describe('pairing codes (AUTH-03)', () => {
  it('is 8 characters', () => {
    expect(generatePairingCode()).toHaveLength(8);
  });

  it('omits characters that are misread off a printed sheet', () => {
    // No I, O, 0 or 1 — this is read aloud in a kitchen.
    for (let i = 0; i < 300; i++) {
      expect(generatePairingCode()).not.toMatch(/[IO01]/);
    }
  });

  it('does not repeat in practice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generatePairingCode());
    expect(seen.size).toBeGreaterThan(1990);
  });
});
