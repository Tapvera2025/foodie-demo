/**
 * Whether a vendor may start taking orders, and if not, exactly what is missing.
 *
 * PURE. Takes a snapshot of the vendor's state, returns a verdict. No database,
 * so the rules can be exhaustively tested and — more importantly — shown to the
 * person doing the onboarding as a live checklist rather than discovered one
 * failed save at a time.
 *
 * WHY THIS IS A GATE AND NOT FORM VALIDATION
 *
 * Activating a vendor is the moment the platform starts accepting money on
 * their behalf. Every item below is something that, if missing, produces a
 * specific and expensive failure *after* a customer has already paid:
 *
 *   no settlement mode    the CHECK constraint rejects the row, but only once
 *                         somebody has tried to order
 *   no linked account     PLATFORM_COLLECT has nowhere to send the split, so
 *                         the platform holds funds it cannot forward — exactly
 *                         what an RBI-regulated payment aggregator must not do
 *   no menu               the stall shows as open and sells nothing
 *   no staff account      orders arrive at a kitchen that cannot see them, and
 *                         the escalation ladder fires on every single one
 *   no KYC                the aggregator freezes settlement later, when money
 *                         is already sitting in it
 *
 * Each is discovered at the worst possible moment. The gate moves the discovery
 * to onboarding, where it costs a phone call.
 */

export type SettlementMode = 'PLATFORM_COLLECT' | 'VENDOR_DIRECT';
export type VendorStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';

/** What onboarding has gathered so far. Mirrors the `vendor` row plus two counts. */
export interface VendorSnapshot {
  readonly status: VendorStatus;
  readonly name: string;
  readonly legalName: string | null;
  readonly settlementMode: SettlementMode | null;
  readonly pan: string | null;
  readonly gstin: string | null;
  readonly fssaiLicence: string | null;
  readonly bankAccountRef: string | null;
  readonly kycCompletedAt: Date | null;
  readonly providerLinkedAccountId: string | null;
  readonly availableMenuItemCount: number;
  readonly activeStaffCount: number;
}

export type BlockerCode =
  | 'LEGAL_NAME_MISSING'
  | 'SETTLEMENT_MODE_MISSING'
  | 'PAN_MISSING'
  | 'PAN_MALFORMED'
  | 'GSTIN_MALFORMED'
  | 'FSSAI_MISSING'
  | 'BANK_ACCOUNT_MISSING'
  | 'KYC_INCOMPLETE'
  | 'PROVIDER_ACCOUNT_MISSING'
  | 'MENU_EMPTY'
  | 'NO_STAFF_ACCOUNT';

export interface Blocker {
  readonly code: BlockerCode;
  /** Shown to whoever is onboarding. Says what to do, not what is wrong. */
  readonly message: string;
  readonly blocking: boolean;
}

/**
 * Structural checks only, and deliberately loose.
 *
 * These catch a transposed character or a phone number typed into the PAN box.
 * They do NOT prove the number is real or belongs to this vendor — only the
 * aggregator's KYC can do that, and pretending otherwise here would create
 * false confidence at precisely the point where confidence matters.
 */
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

export interface Readiness {
  readonly canActivate: boolean;
  readonly blockers: readonly Blocker[];
  readonly warnings: readonly Blocker[];
}

export function assessVendorReadiness(v: VendorSnapshot): Readiness {
  const found: Blocker[] = [];
  const add = (code: BlockerCode, message: string, blocking = true): void => {
    found.push({ code, message, blocking });
  };

  if (!v.legalName?.trim()) {
    // The trading name is what the customer sees; the legal name is what goes
    // on the invoice and in the aggregator's records. They differ often enough
    // that assuming otherwise causes a settlement mismatch.
    add('LEGAL_NAME_MISSING', 'Add the registered legal name, as it appears on the PAN.');
  }

  if (!v.settlementMode) {
    add(
      'SETTLEMENT_MODE_MISSING',
      'Choose how this stall is paid: platform-collected with a split, or direct to the vendor.',
    );
  }

  if (!v.pan?.trim()) {
    add('PAN_MISSING', 'Add the PAN. Settlement cannot be set up without it.');
  } else if (!PAN.test(v.pan.trim().toUpperCase())) {
    add('PAN_MALFORMED', 'That PAN does not look right — it should read like ABCDE1234F.');
  }

  // GSTIN is optional. A stall below the registration threshold legitimately
  // has none, and demanding one would exclude exactly the small vendors this
  // product exists to serve. If supplied, it must at least be shaped correctly.
  if (v.gstin?.trim() && !GSTIN.test(v.gstin.trim().toUpperCase())) {
    add('GSTIN_MALFORMED', 'That GSTIN does not look right — it should be 15 characters.');
  }

  if (!v.fssaiLicence?.trim()) {
    // Statutory for anyone selling food in India, and the food court operator
    // carries reputational risk for every stall on their floor.
    add('FSSAI_MISSING', 'Add the FSSAI licence number. Required to sell food.');
  }

  if (!v.bankAccountRef?.trim()) {
    add('BANK_ACCOUNT_MISSING', 'Add the settlement bank account.');
  }

  if (!v.kycCompletedAt) {
    add(
      'KYC_INCOMPLETE',
      'The payment provider has not confirmed KYC yet. Settlement stays frozen until it does.',
    );
  }

  // Only PLATFORM_COLLECT needs a linked account: under VENDOR_DIRECT the money
  // never touches the platform, so there is nothing to split.
  if (v.settlementMode === 'PLATFORM_COLLECT' && !v.providerLinkedAccountId?.trim()) {
    add(
      'PROVIDER_ACCOUNT_MISSING',
      'Create the linked account with the payment provider. Without it the platform collects money it cannot forward.',
    );
  }

  if (v.availableMenuItemCount === 0) {
    /**
     * A WARNING, NOT A BLOCKER — and this one changed direction.
     *
     * It blocked activation originally, on the reasoning that a stall with no
     * menu shows as open and sells nothing. That reasoning is still true; what
     * changed is who can fix it and when.
     *
     * The menu is now the VENDOR'S to load, from the Menu tab on their own
     * board, and they cannot reach that board until the stall is live and they
     * have a login. Blocking activation on it therefore created a deadlock in
     * the common case: the platform onboards the business, and then waits,
     * holding activation, for a spreadsheet from somebody who cannot yet sign
     * in to upload it.
     *
     * Everything else in this gate is something the PLATFORM must have — a
     * licence, a settlement account, a KYC confirmation — and none of it can be
     * supplied by the vendor later. A menu can. That is the line.
     *
     * The consequence is not hidden: it is reported as a warning, the console
     * shows warnings next to the blockers, and `availableMenuItemCount` is on
     * the readiness response so the number is visible whether or not anyone
     * reads the sentence.
     */
    add(
      'MENU_EMPTY',
      'No items on the menu yet. The stall can go live, but customers will see it open with nothing to order until the vendor adds their menu.',
      false,
    );
  }

  if (v.activeStaffCount === 0) {
    add(
      'NO_STAFF_ACCOUNT',
      'Create at least one staff login, or orders arrive at a kitchen that cannot see them.',
    );
  }

  const blockers = found.filter((b) => b.blocking);
  const warnings = found.filter((b) => !b.blocking);

  return { canActivate: blockers.length === 0, blockers, warnings };
}

/**
 * Which transitions the vendor lifecycle permits.
 *
 * Narrow on purpose. In particular there is no INACTIVE -> ACTIVE: a stall that
 * left the court and came back should be re-onboarded, because in the meantime
 * its bank details, licence and menu have all had time to change. Silently
 * reusing stale settlement details is how money reaches the wrong account.
 */
const ALLOWED: Readonly<Record<VendorStatus, readonly VendorStatus[]>> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['SUSPENDED', 'INACTIVE'],
  // Suspension is reversible — it covers a temporary problem such as a hygiene
  // issue or a settlement dispute, not departure.
  SUSPENDED: ['ACTIVE', 'INACTIVE'],
  INACTIVE: [],
};

export function canTransitionVendor(from: VendorStatus, to: VendorStatus): boolean {
  return ALLOWED[from].includes(to);
}
