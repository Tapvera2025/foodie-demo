/**
 * Console API client.
 *
 * Same auth-store shape as the kitchen board, and for the same reason: the 401
 * handler clears the token from inside a fetch, which React cannot observe. A
 * `localStorage.getItem` during render gave the KDS a board that flickered
 * between the sign-in form and the queue, and `useSyncExternalStore` over this
 * store is what fixed it. Repeating the pattern is cheaper than rediscovering
 * the bug.
 *
 * The KEY differs from the other two apps. All three run on localhost in
 * development and therefore share an origin — one key would mean signing into
 * the console signed you out of the kitchen.
 */

const TOKEN_KEY = 'foodcourt-admin-token';

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedToken: string | null = localStorage.getItem(TOKEN_KEY);

export type SignOutReason = 'EXPIRED' | 'MANUAL' | null;
let lastReason: SignOutReason = null;

function emit(): void {
  for (const l of listeners) l();
}

export const auth = {
  /** Cached, not a fresh read: `useSyncExternalStore` compares by identity. */
  get: (): string | null => cachedToken,

  set(t: string): void {
    cachedToken = t;
    lastReason = null;
    localStorage.setItem(TOKEN_KEY, t);
    emit();
  },

  clear(reason: Exclude<SignOutReason, null> = 'MANUAL'): void {
    if (cachedToken === null) return;
    cachedToken = null;
    lastReason = reason;
    localStorage.removeItem(TOKEN_KEY);
    emit();
  },

  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  reason: (): SignOutReason => lastReason,
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(auth.get() ? { Authorization: `Bearer ${auth.get()!}` } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the server.', 0);
  }

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const e = body as { code?: string; message?: string } | null;

    /**
     * 401 signs out. 403 does NOT.
     *
     * The distinction matters here more than on the kitchen board, because this
     * app authorises per act: `tenant.manage` for courts, `vendor.write` for
     * stalls. A console user without one of them gets a legitimate 403 on one
     * screen and works fine on the next. Clearing the token on 403 would log
     * somebody out for visiting a page they cannot use, and they would never
     * work out why.
     *
     * The server returns `TOKEN_INVALID` with a 401 for a permission failure,
     * which conflates the two — so the code is checked as well as the status.
     * A genuinely expired token has no `decide` reason attached to it.
     */
    if (res.status === 401 && !/cannot /i.test(e?.message ?? '')) {
      auth.clear('EXPIRED');
    }

    throw new ApiError(e?.code ?? 'UNKNOWN', e?.message ?? 'Request failed', res.status);
  }
  return body as T;
}

// ============================================================================
// Types — mirrors of the console repositories' return shapes
// ============================================================================

export type EntityStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
export type SettlementMode = 'PLATFORM_COLLECT' | 'VENDOR_DIRECT';

export interface CourtSummary {
  id: string;
  name: string;
  city: string;
  address: string | null;
  status: EntityStatus;
  hasQr: boolean;
  vendorCount: number;
  activeVendorCount: number;
  /** Money taken, food not collected. Excludes unpaid baskets — see the server. */
  liveOrderCount: number;
  createdAt: string;
}

export interface CourtDetail extends CourtSummary {
  timezone: string;
}

export interface Blocker {
  code: string;
  message: string;
  blocking: boolean;
}

export interface Readiness {
  canActivate: boolean;
  blockers: Blocker[];
  warnings: Blocker[];
}

export interface VendorSummary {
  id: string;
  foodCourtId: string;
  name: string;
  cuisine: string[];
  status: EntityStatus;
  estimatedPrepMinutes: number;
  blockerCount: number;
}

export interface VendorDetail extends VendorSummary {
  legalName: string | null;
  settlementMode: SettlementMode | null;
  pan: string | null;
  gstin: string | null;
  fssaiLicence: string | null;
  bankAccountRef: string | null;
  kycCompletedAt: string | null;
  providerLinkedAccountId: string | null;
  availableMenuItemCount: number;
  activeStaffCount: number;
  /** `{}` means no schedule, which the customer app reads as always open. */
  operatingHours: Record<string, { open: string; close: string }[]>;
  /** The platform's grant of a carousel slot. The artwork is the stall's. */
  offerUploadsEnabled: boolean;
  offerImageUrl: string | null;
  offerHeadline: string | null;
  readiness: Readiness;
}

export interface QrState {
  token: string | null;
  url: string | null;
  courtStatus: string;
  /** Token present AND court active. One answer, not two facts to reconcile. */
  scannable: boolean;
}

export type KitchenRole = 'VENDOR_OPERATOR' | 'VENDOR_OWNER';

/**
 * Why an order needs a human, worst first.
 *
 * Mirrors `Attention` in `src/console/order.repository.ts`. Duplicated as a
 * union rather than shared, because these are separate builds — and the
 * conformance suite checks the client reads every field the server sends.
 */
export type Attention =
  | 'PAYMENT_ORPHANED'
  | 'RECONCILIATION'
  | 'DISPATCH_FAILED'
  | 'STALL_SILENT'
  | 'UNCOLLECTED'
  | 'SLOW'
  | 'OK';

export interface LiveOrder {
  orderId: string;
  orderNumber: string;
  status: string;
  vendorId: string;
  vendorName: string;
  customerName: string | null;
  totalPayablePaise: number;
  placedAt: string;
  ageSeconds: number;
  paymentStatus: string | null;
  /** AUTHORIZED or CAPTURED — money the platform is actually holding. */
  moneyHeld: boolean;
  attention: Attention;
  diagnosis: string;
  /** Whether cancelling returns money as well as stopping the order. */
  cancelRefunds: boolean;
}

/** One row of the offer queue, across every court. */
export interface OfferSlotRow {
  id: string;
  name: string;
  status: EntityStatus;
  foodCourtId: string;
  foodCourtName: string;
  enabled: boolean;
  /** Granted but with no artwork uploaded — a slot doing nothing. */
  filled: boolean;
  headline: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  /**
   * On a customer's screen RIGHT NOW.
   *
   * Distinct from `enabled && filled`, which is only two of the four conditions
   * the carousel applies — the stall also has to be accepting orders. Two
   * booleans rather than one because the console needs to distinguish "not
   * configured" from "configured and currently shut", and those get different
   * sentences and different actions.
   */
  showingNow: boolean;
  /** Why not, when the configuration is complete. Null when it IS showing. */
  notShowingReason: string | null;
}

export interface StaffAccount {
  userId: string;
  email: string;
  displayName: string;
  role: KitchenRole;
  active: boolean;
  createdAt: string;
}

/** What a CSV import would do, or did. Mirrors `ImportPlan`. */
export interface ImportPlan {
  categoriesCreated: number;
  itemsCreated: string[];
  itemsUpdated: string[];
  itemsDiscontinued: string[];
  itemsReactivated: string[];
  priceChanges: { item: string; fromPaise: number; toPaise: number }[];
}

export interface LoginResult {
  token: string;
  user: { id: string; displayName: string; roles: { role: string; vendorId: string | null }[] };
}

/** The patch shape. `null` clears, absent leaves alone — see the controller. */
export interface VendorPatch {
  /**
   * Day -> windows. Replaces the whole schedule rather than merging it.
   *
   * Merging would make "we no longer open on Sundays" unexpressible — a partial
   * patch has no way to send an absence, so Sunday would survive every attempt
   * to remove it.
   */
  operatingHours?: Record<string, { open: string; close: string }[]>;
  offerUploadsEnabled?: boolean;
  name?: string;
  cuisine?: string[];
  estimatedPrepMinutes?: number;
  legalName?: string | null;
  settlementMode?: SettlementMode | null;
  pan?: string | null;
  gstin?: string | null;
  fssaiLicence?: string | null;
  bankAccountRef?: string | null;
  providerLinkedAccountId?: string | null;
  kycCompleted?: boolean;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  // ---- courts
  courts: () => request<{ courts: CourtSummary[] }>('/console/food-courts'),

  court: (id: string) => request<CourtDetail>(`/console/food-courts/${id}`),

  createCourt: (body: { name: string; city: string; address?: string }) =>
    request<CourtDetail>('/console/food-courts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateCourt: (id: string, body: { name?: string; city?: string; address?: string | null }) =>
    request<CourtDetail>(`/console/food-courts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  setCourtStatus: (id: string, status: EntityStatus, reason: string) =>
    request<CourtDetail>(`/console/food-courts/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    }),

  // ---- the venue QR
  qr: (courtId: string) => request<QrState>(`/console/food-courts/${courtId}/qr`),

  issueQr: (courtId: string, reason: string, replace: boolean) =>
    request<QrState>(`/console/food-courts/${courtId}/qr`, {
      method: 'POST',
      body: JSON.stringify({ reason, replace }),
    }),

  revokeQr: (courtId: string, reason: string) =>
    request<QrState>(`/console/food-courts/${courtId}/qr/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // ---- stalls
  vendors: (courtId: string) =>
    request<{ vendors: VendorSummary[] }>(`/console/food-courts/${courtId}/vendors`),

  createVendor: (courtId: string, body: { name: string; cuisine?: string[] }) =>
    request<VendorDetail>(`/console/food-courts/${courtId}/vendors`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  vendor: (id: string) => request<VendorDetail>(`/console/vendors/${id}`),

  /**
   * Just the verdict, cheap enough to poll.
   *
   * Deliberately NOT `vendor()` on an interval. Two of the eleven blockers are
   * cleared outside this console — a menu arrives by CSV import, a kitchen
   * login by SQL — so the checklist has to be able to notice a change nobody
   * made here.
   *
   * Polling the full vendor detail instead would look simpler and would reset
   * the onboarding form under whoever is typing in it, every ten seconds. This
   * response touches no field the form owns.
   */
  readiness: (id: string) =>
    request<{
      status: EntityStatus;
      canActivate: boolean;
      blockers: Blocker[];
      warnings: Blocker[];
      availableMenuItemCount: number;
      activeStaffCount: number;
    }>(`/console/vendors/${id}/readiness`),

  updateVendor: (id: string, body: VendorPatch) =>
    request<VendorDetail>(`/console/vendors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  setVendorStatus: (id: string, status: EntityStatus, reason: string) =>
    request<VendorDetail>(`/console/vendors/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason }),
    }),

  // ---- kitchen logins
  staff: (vendorId: string) =>
    request<{ staff: StaffAccount[] }>(`/console/vendors/${vendorId}/staff`),

  /**
   * The password comes back in this response and is not recoverable after it.
   *
   * `platform_user` stores a scrypt hash and there is no reset flow yet, so the
   * caller must show it once and say so. Deliberately not persisted anywhere on
   * the client either — no localStorage, no query cache beyond the mutation's
   * own result.
   */
  createStaff: (
    vendorId: string,
    body: { email: string; displayName: string; role: KitchenRole; password?: string },
  ) =>
    request<{ account: StaffAccount; password: string; generated: boolean }>(
      `/console/vendors/${vendorId}/staff`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // ---- offer slots
  offerSlots: () => request<{ stalls: OfferSlotRow[] }>('/console/offer-slots'),

  /**
   * Grant, decline or withdraw. Which of the three it is depends on the state
   * the server finds, so the client sends only the answer.
   */
  setOfferSlot: (vendorId: string, enabled: boolean) =>
    request<{ enabled: boolean; declined: boolean }>(
      `/console/vendors/${vendorId}/offer-slot`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),

  // ---- live orders
  /**
   * Every order in a court with money against it and nothing collected.
   *
   * The `attention` and `diagnosis` fields are computed server-side. The
   * console renders them and does not second-guess them: "stuck" is a claim
   * about money and time that must mean the same thing here, in the worker,
   * and in the audit log somebody reads six weeks later.
   */
  liveOrders: (courtId: string) =>
    request<{ orders: LiveOrder[] }>(`/console/food-courts/${courtId}/orders`),

  forceCancelOrder: (courtId: string, orderId: string, reason: string) =>
    request<{ orderNumber: string; status: string; refundStarted: boolean }>(
      `/console/food-courts/${courtId}/orders/${orderId}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /**
   * A new password for an existing login.
   *
   * No body — the password is always generated server-side. A reset happens
   * under pressure, with a cook waiting, which is exactly when somebody types
   * `kitchen123`. Removing the choice removes the outcome.
   *
   * The response is the ONLY place the password exists. Same rule as creation:
   * not cached, not stored, not re-fetchable.
   */
  resetStaffPassword: (vendorId: string, userId: string) =>
    request<{ account: StaffAccount; password: string }>(
      `/console/vendors/${vendorId}/staff/${userId}/reset-password`,
      { method: 'POST' },
    ),

  revokeStaff: (vendorId: string, userId: string, reason: string) =>
    request<{ staff: StaffAccount[] }>(`/console/vendors/${vendorId}/staff/${userId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // ---- menu
  /**
   * `dryRun` reports what WOULD change and writes nothing.
   *
   * The interesting line in the response is almost always the price changes, so
   * the console runs a dry run first and shows it before anything is applied.
   * Replacing a vendor's live menu is not an action to take on a spreadsheet
   * nobody has read back.
   */
  importMenu: (vendorId: string, csv: string, dryRun: boolean) =>
    request<{ dryRun: boolean; applied: boolean } & ImportPlan>(
      `/console/vendors/${vendorId}/menu/import?dryRun=${dryRun ? 'true' : 'false'}`,
      { method: 'POST', body: JSON.stringify({ csv }) },
    ),
};
