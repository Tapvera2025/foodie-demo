/**
 * KDS API client.
 *
 * The token lives in localStorage. That is a real tradeoff: an httpOnly cookie
 * would be safer against XSS, but the KDS is a separate origin from the API in
 * development and would need CSRF handling. A mounted kitchen tablet running
 * one pinned app is a very different threat model from a customer's phone —
 * the realistic risk is the tablet walking out of the building, which is why
 * tokens are short-lived and revocable per user rather than per stall.
 */

const TOKEN_KEY = 'foodcourt-kds-token';

/**
 * The token, as a subscribable store rather than a localStorage read.
 *
 * WHY THIS IS NOT JUST `localStorage.getItem`
 *
 * It was, and the board flickered between the sign-in form and the queue every
 * few seconds. The cause is worth writing down because it is a trap, not a typo.
 *
 * There were two sources of truth for "is this cook signed in": a `signedIn`
 * React state in App, and a `localStorage` read performed during render. The
 * 401 handler below cleared the token as a side effect inside `request()` —
 * something React has no way to observe. So `signedIn` stayed `true` after the
 * token was gone, the board query kept polling on a dead token, and the render
 * condition mixed that stale state with a query's `isError`.
 *
 * `isError` is not a stable boolean. With `retry: 1` it goes FALSE during the
 * retry and TRUE once retries are exhausted, and `refetchInterval` restarts
 * that cycle every three seconds. The UI was faithfully following a state
 * machine nobody meant to render.
 *
 * `useSyncExternalStore` over this store gives React one source of truth that
 * updates when the token actually changes — including from inside a fetch
 * handler — so a signed-out board stops polling instead of oscillating.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let cachedToken: string | null = localStorage.getItem(TOKEN_KEY);

/** Why the last sign-out happened, so the form can say something useful. */
export type SignOutReason = 'EXPIRED' | 'MANUAL' | null;
let lastReason: SignOutReason = null;

function emit(): void {
  for (const l of listeners) l();
}

export const auth = {
  /**
   * Must return a cached value, not a fresh read. `useSyncExternalStore` calls
   * this on every render and compares by identity; hitting localStorage each
   * time is both slower and, for anything but a primitive, an infinite loop.
   */
  get: (): string | null => cachedToken,

  set(t: string): void {
    cachedToken = t;
    lastReason = null;
    localStorage.setItem(TOKEN_KEY, t);
    emit();
  },

  clear(reason: Exclude<SignOutReason, null> = 'MANUAL'): void {
    if (cachedToken === null) return; // Already out; do not re-notify.
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
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the server.', 0);
  }

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const e = body as { code?: string; message?: string } | null;
    // An expired token must drop the cook back to login rather than showing a
    // board that silently stops updating — a frozen queue during service is
    // worse than an obvious sign-in prompt.
    //
    // `clear('EXPIRED')` notifies React, so the board query is disabled on the
    // next render and stops polling a token that will never work again. The
    // previous version cleared localStorage and told nobody, which left the
    // query running for ever against a dead credential.
    if (res.status === 401) auth.clear('EXPIRED');
    throw new ApiError(e?.code ?? 'UNKNOWN', e?.message ?? 'Request failed', res.status);
  }
  return body as T;
}

export interface Ticket {
  orderId: string;
  orderNumber: string;
  /**
   * The customer's first name, if they gave one. Null for most orders.
   *
   * Only the name — never the phone number. A kitchen tablet is a screen
   * several people can see, and the stall has no reason to hold a number.
   */
  customerName: string | null;
  status: string;
  placedAt: string;
  acknowledgedAt: string | null;
  readyAt: string | null;
  totalPayablePaise: number;
  items: { name: string; quantity: number; instructions: string | null }[];
}

export interface LoginResult {
  token: string;
  user: { id: string; displayName: string; roles: { role: string; vendorId: string | null }[] };
}

export const REJECTION_REASONS = [
  ['ITEM_OUT_OF_STOCK', 'Item out of stock'],
  ['KITCHEN_OVERLOADED', 'Kitchen overloaded'],
  ['EQUIPMENT_FAILURE', 'Equipment failure'],
  ['INGREDIENT_UNAVAILABLE', 'Ingredient unavailable'],
  ['VENDOR_CLOSING', 'Closing now'],
  ['CUSTOMER_REQUEST', 'Customer asked'],
  ['OTHER', 'Something else'],
] as const;

export type Availability = 'AVAILABLE' | 'SOLD_OUT' | 'TEMPORARILY_UNAVAILABLE';

export interface MenuItem {
  id: string;
  name: string;
  pricePaise: number;
  status: string;
  availability: Availability;
  inventoryMode: string;
  availableFrom: string | null;
  imageUrl: string | null;
  dailyStock: number | null;
  consumed: number | null;
  remaining: number | null;
  /**
   * This stall recommends the dish. Capped at three per stall by the server.
   *
   * NOT the "Bestseller" badge the customer app also shows — that one is
   * computed from units sold and no kitchen can set it. Two different claims,
   * deliberately kept apart.
   */
  mustTry: boolean;
  /** What the CUSTOMER sees, after all three of PRD §6's concepts are resolved. */
  orderable: boolean;
  reason: string | null;
}

export interface StallStatus {
  name: string;
  vendorStatus: string;
  /**
   * Whether this account holds `menu.write` — owner yes, cook no.
   *
   * Server-computed. A rendering hint only: every write endpoint checks the
   * permission again, so a client that ignored this would get a 403 rather
   * than an edit.
   */
  canEditMenu: boolean;
  pausedUntil: string | null;
  pausedMinutesLeft: number;
  /** Set by the escalation ladder, not by the kitchen. Not clearable here. */
  dispatchBlocked: boolean;
  /**
   * The stall's own banner, or null.
   *
   * Null is the normal state until somebody uploads one — the column has
   * existed since migration 12 with nothing able to write it. The customer's
   * stall page renders a generated band in its place.
   */
  coverImageUrl: string | null;
  acceptingOrders: boolean;
  /**
   * The customer-app carousel slot.
   *
   * GRANTED by the platform, FILLED by this stall. Sent even when false so the
   * board can explain the absence — a missing control gets asked about, a
   * disabled one with a sentence does not.
   */
  offerUploadsEnabled: boolean;
  offerImageUrl: string | null;
  offerHeadline: string | null;
  /**
   * Four states, not two. `requestedAt` set means waiting; `decidedAt` set with
   * no `requestedAt` and no grant means the office said no. Collapsing those is
   * what makes a stall ask every week into what feels like silence.
   */
  offerSlotRequestedAt: string | null;
  offerSlotDecidedAt: string | null;
}

export type Dietary = 'VEG' | 'NON_VEG' | 'EGG' | 'JAIN';

export interface ItemDraft {
  name: string;
  category: string;
  priceRupees: number;
  description?: string;
  dietary?: Dietary;
  /** A URL. There is no object storage yet, so nothing uploads bytes. */
  imageUrl?: string | null;
}

/** An item that has run out, or is close to it. `OUT` means zero, on its own. */
export interface StockAlert {
  itemId: string;
  name: string;
  remaining: number;
  kind: 'OUT' | 'LOW';
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  board: () => request<{ vendor: { id: string; name: string }; orders: Ticket[] }>('/kds/orders'),

  /**
   * Tells the server this tablet is awake.
   *
   * Customer-facing availability is derived from the freshness of this call, so
   * a stall whose tablet slept stops appearing orderable rather than continuing
   * to take money for tickets nobody can see. It also returns whether the stall
   * has been blocked for not acknowledging — the customer is never told that,
   * but the kitchen must be.
   */
  heartbeat: () =>
    request<{
      at: string;
      acceptingOrders: boolean;
      blockedReason: string | null;
      /**
       * What has run out and what is about to, for TRACKED items only.
       *
       * On the HEARTBEAT rather than the board because the heartbeat fires
       * whichever tab is open — an alert that only arrives on the Orders tab
       * arrives for a problem the cook is already looking at.
       */
      stockAlerts: StockAlert[];
    }>('/kds/heartbeat', { method: 'POST' }),

  advance: (orderId: string, action: 'accept' | 'ready' | 'collect') =>
    request<{ status: string }>(`/kds/orders/${orderId}/${action}`, { method: 'POST' }),

  reject: (orderId: string, reason: string, note?: string) =>
    request<{ status: string }>(`/kds/orders/${orderId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, ...(note ? { note } : {}) }),
    }),

  // ---- the menu, from the kitchen's side
  items: () => request<{ serviceDate: string; items: MenuItem[] }>('/vendor/items'),

  /**
   * Mark an item available, sold out, or off for a while.
   *
   * `availableFrom` is only meaningful for the last of those. The server
   * clears it on the way back to AVAILABLE — a database CHECK refuses AVAILABLE
   * with a future return time, so this is not defensive, it is required.
   */
  setAvailability: (itemId: string, availability: Availability, availableFrom?: string) =>
    request<{ itemId: string; name: string; availability: Availability }>(
      `/vendor/items/${itemId}/availability`,
      {
        method: 'PUT',
        body: JSON.stringify({ availability, ...(availableFrom ? { availableFrom } : {}) }),
      },
    ),

  /**
   * Recommend this dish to customers, or stop recommending it.
   *
   * The server caps a stall at three and refuses the fourth with
   * `MUST_TRY_LIMIT_REACHED`. It answers with `remaining` so the board can say
   * how many picks are left without asking again — and so the count shown is
   * the server's, not one this client tried to keep in step.
   */
  setMustTry: (itemId: string, mustTry: boolean) =>
    request<{ itemId: string; name: string; mustTry: boolean; remaining: number; limit: number }>(
      `/vendor/items/${itemId}/must-try`,
      { method: 'PUT', body: JSON.stringify({ mustTry }) },
    ),

  /**
   * Today's count. Setting one switches the item to TRACKED.
   *
   * Nothing is decremented client-side, or server-side either — remaining is
   * computed from confirmed orders, so this number and the orders against it
   * cannot drift apart.
   */
  setStock: (itemId: string, dailyStock: number, note?: string) =>
    request<{ itemId: string; dailyStock: number; remaining: number }>(
      `/vendor/items/${itemId}/stock`,
      { method: 'PUT', body: JSON.stringify({ dailyStock, ...(note ? { note } : {}) }) },
    ),

  // ---- the stall
  stallStatus: () => request<StallStatus>('/vendor/status'),

  /**
   * Authorise one image upload.
   *
   * Returns a signature, not a URL. The browser then sends the file straight to
   * the storage provider — this call is where the permission check happens, and
   * the signature is the token proving it passed.
   */
  signUpload: (kind: 'dish' | 'stall-cover' | 'stall-logo' | 'offer') =>
    request<{ uploadUrl: string; fields: Record<string, string>; maxBytes: number; accept: string[] }>(
      '/vendor/uploads/sign',
      { method: 'POST', body: JSON.stringify({ kind }) },
    ),

  /** Ask the platform for a carousel slot. Idempotent — two taps, one request. */
  requestOfferSlot: () =>
    request<{ requested: boolean }>('/vendor/offer/request', { method: 'POST' }),

  /**
   * The stall's carousel artwork. `imageUrl: null` clears both fields.
   *
   * The headline is the image's ALT TEXT and the database refuses an image
   * without one — an offer that exists only as artwork is invisible to a screen
   * reader and to anybody whose image never loaded.
   */
  /**
   * The stall's identity banner.
   *
   * No headline, unlike the offer. This is a photograph of a shop, not a claim
   * about one — and the stall's name is already beside it in text, so there is
   * nothing for alt text to say that is not already said.
   */
  setCover: (imageUrl: string | null) =>
    request<{ coverImageUrl: string | null }>('/vendor/cover', {
      method: 'PUT',
      body: JSON.stringify({ imageUrl }),
    }),

  setOffer: (imageUrl: string | null, headline: string) =>
    request<{ offerImageUrl: string | null; offerHeadline: string | null }>('/vendor/offer', {
      method: 'PUT',
      body: JSON.stringify({ imageUrl, headline }),
    }),

  /** `minutes: 0` resumes. See the note on `PauseBody` for why a pause has a length. */
  pause: (minutes: number, reason?: string) =>
    request<{ pausedUntil: string | null; acceptingOrders: boolean }>('/vendor/pause', {
      method: 'POST',
      body: JSON.stringify({ minutes, ...(reason ? { reason } : {}) }),
    }),

  // ---- editing the menu. `menu.write`, so owner-only.
  categories: () =>
    request<{ categories: { id: string; name: string }[] }>('/vendor/menu/categories'),

  /** Price in RUPEES — the server converts once, to integer paise. */
  createItem: (draft: ItemDraft) =>
    request<{ id: string; name: string; pricePaise: number }>('/vendor/menu/items', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),

  updateItem: (itemId: string, patch: Partial<ItemDraft> & { dietary?: Dietary | null }) =>
    request<{ id: string; name: string; pricePaise: number }>(`/vendor/menu/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** Marks INACTIVE, never deletes — order history references the row. */
  discontinueItem: (itemId: string) =>
    request<{ id: string; status: string }>(`/vendor/menu/items/${itemId}`, { method: 'DELETE' }),

  // ---- AI descriptions. Metered; see src/catalog/describe.controller.ts.

  /**
   * How many generations this stall has left, and whether the server can do it
   * at all.
   *
   * `configured` and `remaining` answer to different people. No credits is the
   * stall's problem and the fix is to call the platform; nothing configured is
   * the operator's, and telling an owner to ask for more credits when the real
   * cause is an unset environment variable sends them on an errand that cannot
   * work.
   */
  describeCredits: () =>
    request<{ granted: number; used: number; remaining: number; configured: boolean }>(
      '/vendor/menu/describe/credits',
    ),

  /**
   * Spend one credit and get a sentence back.
   *
   * Returns the balance AFTER the spend, so the button can disable itself on
   * the response that used the last one rather than on the next page load.
   */
  describe: (input: {
    dishName: string;
    categoryName?: string | null;
    dietaryFlags?: string[];
    menuItemId?: string | null;
  }) =>
    request<{
      description: string;
      granted: number;
      used: number;
      remaining: number;
      provider: string | null;
    }>('/vendor/menu/describe', { method: 'POST', body: JSON.stringify(input) }),
};
