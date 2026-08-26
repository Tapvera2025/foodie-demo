import { describe, it, expect } from 'vitest';

import {
  assessVendorReadiness,
  canTransitionVendor,
  type VendorSnapshot,
} from './vendor-onboarding.js';

/** A stall that has completed onboarding correctly. Each test breaks one thing. */
const ready: VendorSnapshot = {
  status: 'DRAFT',
  name: 'Spice Garden',
  legalName: 'Spice Garden Foods Private Limited',
  settlementMode: 'PLATFORM_COLLECT',
  pan: 'ABCDE1234F',
  gstin: '24ABCDE1234F1Z5',
  fssaiLicence: '11223344556677',
  bankAccountRef: 'ba_9f2c',
  kycCompletedAt: new Date('2026-08-01'),
  providerLinkedAccountId: 'acc_spice',
  availableMenuItemCount: 8,
  activeStaffCount: 2,
};

const codes = (v: VendorSnapshot): string[] =>
  assessVendorReadiness(v).blockers.map((b) => b.code);

describe('a fully onboarded vendor', () => {
  it('can activate', () => {
    expect(assessVendorReadiness(ready).canActivate).toBe(true);
    expect(assessVendorReadiness(ready).blockers).toEqual([]);
  });
});

describe('each missing piece blocks activation and says which', () => {
  const cases: [string, Partial<VendorSnapshot>, string][] = [
    ['no legal name', { legalName: null }, 'LEGAL_NAME_MISSING'],
    ['no settlement mode', { settlementMode: null }, 'SETTLEMENT_MODE_MISSING'],
    ['no PAN', { pan: null }, 'PAN_MISSING'],
    ['PAN typo', { pan: 'ABCD1234F' }, 'PAN_MALFORMED'],
    ['no FSSAI', { fssaiLicence: '  ' }, 'FSSAI_MISSING'],
    ['no bank account', { bankAccountRef: null }, 'BANK_ACCOUNT_MISSING'],
    ['KYC unconfirmed', { kycCompletedAt: null }, 'KYC_INCOMPLETE'],
    ['no linked account', { providerLinkedAccountId: null }, 'PROVIDER_ACCOUNT_MISSING'],
    ['no staff login', { activeStaffCount: 0 }, 'NO_STAFF_ACCOUNT'],
  ];

  for (const [name, patch, code] of cases) {
    it(`${name} → ${code}`, () => {
      const v = { ...ready, ...patch };
      expect(assessVendorReadiness(v).canActivate).toBe(false);
      expect(codes(v)).toContain(code);
    });
  }

  /**
   * An empty menu WARNS and does not block. This asserts the change rather than
   * dropping the case.
   *
   * Every other item in the gate is something only the platform can supply — a
   * licence, a settlement account, a KYC confirmation. A menu is the vendor's,
   * loaded from their own board, which they cannot reach until the stall is
   * live. Blocking on it deadlocked the common case.
   *
   * Both halves are asserted. A test that only checked `canActivate` would
   * still pass if somebody deleted the warning entirely, and silently losing
   * the sentence is how a stall goes live selling nothing with nobody warned.
   */
  it('an empty menu warns, and does not block', () => {
    const v = { ...ready, availableMenuItemCount: 0 };
    const r = assessVendorReadiness(v);

    expect(r.canActivate).toBe(true);
    expect(r.blockers.map((b) => b.code)).not.toContain('MENU_EMPTY');
    expect(r.warnings.map((b) => b.code)).toContain('MENU_EMPTY');
  });

  it('an empty menu still blocks nothing when combined with a real blocker', () => {
    // The warning must not become load-bearing: a stall with no menu AND no
    // PAN is refused for the PAN, and the reason given is the PAN.
    const v = { ...ready, availableMenuItemCount: 0, pan: null };
    const r = assessVendorReadiness(v);

    expect(r.canActivate).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(['PAN_MISSING']);
  });

  it('reports every problem at once, not one per save', () => {
    // The reason this is a pure assessment rather than a sequence of form
    // validations: an operator onboarding a stall over the phone needs the
    // whole list, not to discover the next gap after each attempt.
    const empty: VendorSnapshot = {
      status: 'DRAFT',
      name: 'New Stall',
      legalName: null,
      settlementMode: null,
      pan: null,
      gstin: null,
      fssaiLicence: null,
      bankAccountRef: null,
      kycCompletedAt: null,
      providerLinkedAccountId: null,
      availableMenuItemCount: 0,
      activeStaffCount: 0,
    };
    const r = assessVendorReadiness(empty);

    /**
     * The exact set, not `length >= 8`.
     *
     * The loose version passed while `MENU_EMPTY` was a blocker and would have
     * kept passing if a blocker were renamed, dropped, or silently duplicated —
     * it only ever asserted "several things are wrong", which was never in
     * doubt. Naming them means the next change to this gate has to say so here.
     *
     * `PROVIDER_ACCOUNT_MISSING` is absent on purpose: it only applies under
     * PLATFORM_COLLECT and the mode is unset. `MENU_EMPTY` is absent because it
     * is now a warning.
     */
    expect(r.blockers.map((b) => b.code).sort()).toEqual(
      [
        'BANK_ACCOUNT_MISSING',
        'FSSAI_MISSING',
        'KYC_INCOMPLETE',
        'LEGAL_NAME_MISSING',
        'NO_STAFF_ACCOUNT',
        'PAN_MISSING',
        'SETTLEMENT_MODE_MISSING',
      ].sort(),
    );

    expect(r.warnings.map((b) => b.code)).toEqual(['MENU_EMPTY']);
  });
});

describe('rules that depend on settlement mode', () => {
  it('VENDOR_DIRECT needs no linked account', () => {
    // The platform is not in that payment flow, so there is no split to send.
    const v = { ...ready, settlementMode: 'VENDOR_DIRECT' as const, providerLinkedAccountId: null };
    expect(codes(v)).not.toContain('PROVIDER_ACCOUNT_MISSING');
    expect(assessVendorReadiness(v).canActivate).toBe(true);
  });

  it('PLATFORM_COLLECT does', () => {
    const v = { ...ready, providerLinkedAccountId: null };
    expect(codes(v)).toContain('PROVIDER_ACCOUNT_MISSING');
  });
});

describe('GSTIN is optional but must be well-formed when given', () => {
  it('accepts a stall below the registration threshold', () => {
    // Demanding a GSTIN would exclude exactly the small vendors this product
    // is for.
    expect(assessVendorReadiness({ ...ready, gstin: null }).canActivate).toBe(true);
  });

  it('rejects a malformed one', () => {
    expect(codes({ ...ready, gstin: '24ABCDE' })).toContain('GSTIN_MALFORMED');
  });
});

describe('lifecycle transitions', () => {
  it('allows DRAFT to ACTIVE', () => {
    expect(canTransitionVendor('DRAFT', 'ACTIVE')).toBe(true);
  });

  it('allows suspend and un-suspend', () => {
    expect(canTransitionVendor('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionVendor('SUSPENDED', 'ACTIVE')).toBe(true);
  });

  it('refuses to reactivate a departed vendor', () => {
    // Their bank details, licence and menu have all had time to change.
    // Re-onboarding is cheap; paying the wrong account is not.
    expect(canTransitionVendor('INACTIVE', 'ACTIVE')).toBe(false);
  });

  it('refuses to skip DRAFT straight to SUSPENDED', () => {
    expect(canTransitionVendor('DRAFT', 'SUSPENDED')).toBe(false);
  });
});
