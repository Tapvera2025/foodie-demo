/**
 * The one place that talks to the server.
 *
 * Errors arrive as { code, message, correlationId }. `ApiError` keeps the code
 * so screens can branch on it — VENDOR_CLOSED and ITEM_UNAVAILABLE need
 * different recovery paths, and parsing English out of `message` to tell them
 * apart is how copy changes become bugs.
 */

import { useSyncExternalStore } from 'react';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every request times out. There is no such thing as "still loading" forever.
 *
 * The first version had no timeout, the API was down, and the Vite proxy held
 * the socket open — so the scan screen showed a spinner indefinitely with no
 * way for the customer, or for us, to learn anything. A hung request is a
 * failed request that has not admitted it yet.
 *
 * Eight seconds: long enough for a slow phone on food-court wi-fi, short
 * enough that somebody standing at a table gets an answer.
 */
const TIMEOUT_MS = 8_000;

/**
 * The customer token, held in memory only.
 *
 * Not localStorage. An artifact running in this environment cannot use it, and
 * more importantly a token in localStorage survives the customer handing their
 * phone to a friend to look at the menu. A 30-day token belongs in a cookie the
 * page cannot read; until that lands, memory is the honest option and the
 * customer re-verifies on reload.
 *
 * `authToken` is written by the OTP screen and read here. One place, so no
 * screen has to remember to attach a header.
 */
let authToken: string | null = null;

/**
 * ============================================================================
 * THE TOKEN IS A SUBSCRIBABLE STORE, NOT A BARE VARIABLE
 * ============================================================================
 *
 * It was a bare variable, and the symptom was a 401 every four seconds, for
 * ever, on a screen nobody thought was broken:
 *
 *   GET /sessions/:id/orders  ->  401 TOKEN_INVALID
 *                                 "Verify your mobile number to continue."
 *
 * Three screens poll the customer's own orders, gated on `sessionId` alone —
 * and a session exists from the moment somebody scans, long before they have
 * verified a number. So every visitor who was merely browsing asked, twice a
 * minute per open screen, a question they had no right to ask, and the API log
 * filled with hundreds of identical auth failures that looked like an attack
 * or a broken guard rather than a client bug.
 *
 * Gating on `isAuthenticated()` alone would not have been enough. A plain
 * module variable is invisible to React: nothing re-renders when it changes, so
 * the queries would stay disabled after verification until something else
 * happened to re-render — which today is a `navigate(-1)` and tomorrow is a
 * bug nobody can reproduce.
 *
 * This is the same store shape the kitchen board and the console already use,
 * and for the same reason. `apps/kds/src/api.ts` carries the long version of
 * this argument: two sources of truth for "am I signed in" is what made that
 * board oscillate between its login and its queue.
 */
type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

export function setAuthToken(token: string | null): void {
  if (authToken === token) return; // Do not wake React for a no-op.
  authToken = token;
  for (const l of authListeners) l();
}

export const customerAuth = {
  /**
   * Must return a cached primitive, not a fresh computation.
   * `useSyncExternalStore` calls this on every render and compares by identity.
   */
  isSignedIn: (): boolean => authToken !== null,

  /**
   * The token itself, for the realtime handshake.
   *
   * `isSignedIn` is not enough there: a socket has to PRESENT the credential,
   * not merely know one exists. Kept beside it rather than exported as a bare
   * `getAuthToken()` so that the one place a caller can reach the raw token is
   * the same object that documents where it lives and why it is memory-only.
   *
   * Read at connect time and not captured: the socket reconnects on a token
   * change, so a stale closure would reconnect with the credential that just
   * stopped working.
   */
  token: (): string | null => authToken,

  subscribe(l: AuthListener): () => void {
    authListeners.add(l);
    return () => authListeners.delete(l);
  },
};

/**
 * The session token, proving this browser owns its browse session.
 *
 * A different credential answering a different question from `authToken`, so it
 * travels in its own header. Before this existed the server resumed whatever
 * session was newest in the court, which meant every phone that scanned the
 * poster shared one — and inherited whoever had verified an OTP on it first.
 *
 * Unlike the customer token this IS persisted, alongside `sessionId` in the
 * cart store, because losing it on reload loses the basket. It grants far less:
 * ordering and order history both additionally require the customer token.
 */
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function isAuthenticated(): boolean {
  return authToken !== null;
}

/**
 * "Is this customer verified", as something React can watch.
 *
 * Every query that needs the customer token must be gated on THIS rather than
 * on `sessionId`. A session exists from the scan; the token exists only after
 * an OTP. Confusing the two is what produced a 401 every four seconds from
 * three separate screens.
 */
export function useIsSignedIn(): boolean {
  return useSyncExternalStore(
    customerAuth.subscribe,
    customerAuth.isSignedIn,
    customerAuth.isSignedIn,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    // Network-level: server down, DNS, timeout, offline. Distinguished from an
    // HTTP error because the recovery is different — retry, not fix your input.
    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    throw new ApiError(
      timedOut ? 'TIMEOUT' : 'NETWORK',
      timedOut
        ? 'The kitchen is taking a moment to answer.'
        : 'Cannot reach the server. Check your connection.',
      'none',
      0,
    );
  }

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const e = body as { code?: string; message?: string; correlationId?: string } | null;
    throw new ApiError(
      e?.code ?? 'UNKNOWN',
      e?.message ?? `Request failed (${res.status})`,
      e?.correlationId ?? res.headers.get('X-Correlation-Id') ?? 'unknown',
      res.status,
    );
  }
  return body as T;
}

export interface ScanResult {
  sessionId: string;
  /** Present it on the next scan to resume this session instead of opening one. */
  sessionToken: string;
  resumed: boolean;
  expiresAt: string;
  foodCourt: { id: string; name: string };
}

export interface VendorSummary {
  id: string;
  name: string;
  cuisine: string[];
  estimatedPrepMinutes: number;
  accepting: boolean;
  closedReason: string | null;
  /**
   * The card's photograph, or null.
   *
   * The stall's own cover if it has one, otherwise its first dish photo — the
   * server resolves that and the card does not care which it got. Null means
   * neither exists and the card draws a gradient from the name.
   */
  coverImageUrl: string | null;
  /** Square brand mark, over the cover's bottom-left. Null draws the initial. */
  logoUrl: string | null;
  /**
   * `HH:MM` in the COURT's timezone, and only when hours are why it is shut.
   *
   * Null for a stall that is open, and null for one that is paused or blocked —
   * those have a problem somebody is dealing with, and "opens at 5pm" would be
   * telling the customer to come back for something that will still be broken.
   */
  opensAt: string | null;
  /** Whether `opensAt` is later today or on a following day. */
  opensToday: boolean | null;
  /** Orders taken in the last seven days. The basis for the POPULAR badge. */
  recentOrders: number;
  /**
   * A typical spend, from the MEDIAN item price, rounded to ten rupees.
   *
   * The reference's "₹250 for one". Median rather than mean because one ₹900
   * thali on a menu of ₹120 dishes drags a mean somewhere nobody pays, and
   * rounded because it is an estimate rather than a quote.
   */
  typicalSpendPaise: number | null;
  /** The stall's own claim about its pricing. Applies no discount. */
  offerHeadline: string | null;
}

/** A stall's carousel banner. Marketing only — the checkout is unchanged. */
export interface Offer {
  vendorId: string;
  vendorName: string;
  imageUrl: string;
  /** Alt text, not a caption. An offer only in artwork is one nobody can hear. */
  headline: string;
}

/** A stall the court is leading with, and the reason it earned the slot. */
export interface Trending {
  vendorId: string;
  badge: 'POPULAR' | 'QUICKEST';
}

/**
 * A stall in a search result, and the dishes that put it there.
 *
 * `matches` is empty when the stall matched on its own name or cuisine rather
 * than on a dish — searching "wow" finds Wow Momo with nothing to list, and a
 * card claiming a dish match it does not have would be worse than none.
 */
export interface VendorSearchResult extends VendorSummary {
  matches: { id: string; name: string; pricePaise: number; orderable: boolean }[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  taxRateBps: number;
  dietaryFlags: string[];
  /** Null until a vendor uploads one. The menu renders a generated tile. */
  imageUrl: string | null;
  available: boolean;
  /**
   * A copy key, not a sentence. The server decides WHY an item cannot be
   * ordered; the client decides how to say it. Sold-out and out-of-stock
   * deliberately collapse to one key — that difference is the vendor's
   * business, not the diner's.
   */
  unavailableReason: string | null;
  /**
   * Top three by units sold at this stall in the last seven days.
   *
   * A boolean rather than a count, because the THRESHOLD is a product decision
   * and belongs in one place. Shipping `soldLast7Days` would mean every screen
   * inventing its own cut-off, and the customer app and the console disagreeing
   * about which dishes are selling.
   */
  bestseller: boolean;
  /**
   * The STALL's own recommendation, set from the kitchen board. Capped at
   * three per stall by the server.
   *
   * Deliberately a different field from `bestseller`, and the two must keep
   * different labels in the UI. One is measured from units sold and cannot be
   * edited by anybody; this one is a cook's opinion. Collapsing them would
   * make the measured badge unfalsifiable, which is the whole reason it was
   * computed rather than typed in.
   */
  mustTry: boolean;
}

export interface MenuResponse {
  vendorId: string;
  /**
   * The stall's own header, so the menu screen does not depend on the cart
   * store having been populated. A customer opening a menu URL directly gets
   * the same header as one who arrived through the stall list.
   */
  vendor: {
    name: string;
    cuisine: string[];
    estimatedPrepMinutes: number;
    accepting: boolean;
    closedReason: string | null;
    /** The banner. Stall cover if set, else a dish photo, else null. */
    coverImageUrl: string | null;
    /** Square brand mark over the banner's lower edge. Null draws the initial. */
    logoUrl: string | null;
    /** `HH:MM` in the court's timezone, only when hours are why it is shut. */
    opensAt: string | null;
    opensToday: boolean | null;
    /**
     * `HH:MM` when the current open stretch ends, for "Closes 11:30 pm".
     *
     * Null for a shut stall and null for one with no schedule at all. A counter
     * that has never said when it stops should render as "Open now" with
     * nothing after it, not as a made-up deadline.
     */
    closesAt: string | null;
    /** Whether that clock time lands after midnight. */
    closesTomorrow: boolean | null;
    /** Median item price, rounded to ten rupees. An estimate, not a quote. */
    typicalSpendPaise: number | null;
  };
  categories: { id: string; name: string; items: MenuItem[] }[];
}

/**
 * A dish this session asked to be told about.
 *
 * `restocked` is the server's answer, not the client's guess. The menu the
 * client holds can be a minute old; this comes from a sweep that recomputed
 * availability against live stock.
 */
export interface StockWatch {
  id: string;
  menuItemId: string;
  itemName: string;
  vendorId: string;
  vendorName: string;
  restocked: boolean;
  /** Whether this session has already been shown the good news. */
  seen: boolean;
}

export interface QuoteResult {
  subtotalPaise: number;
  foodTaxPaise: number;
  customerFeePaise: number;
  customerFeeTaxPaise: number;
  totalPayablePaise: number;
}

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  status: string;
  totalPayablePaise: number;
  replayed: boolean;
}

export interface OrderView {
  orderId: string;
  orderNumber: string;
  status: string;
  /** So the tracking screen can offer "add more from this stall". */
  vendorId: string;
  vendorName: string;
  /**
   * The stall's cover photo, or null if it has never uploaded one.
   *
   * Read live from `vendor.cover_image_url` rather than snapshotted onto the
   * order — a stall changing its photo should change what its old orders show,
   * because the photo is how you recognise the counter you are walking to, not
   * a term of the sale.
   */
  vendorImageUrl: string | null;
  estimatedPrepMinutes: number;
  placedAt: string;
  readyAt: string | null;
  rejectionReason: string | null;
  /**
   * The PAYMENT's state, which the order's status does not imply.
   *
   * Only a signed webhook advances an order, so a captured payment and a
   * `PAYMENT_PENDING` order coexist routinely while the callback is in flight.
   * `paymentSecured` is the one to branch on: it means the money is authorised
   * or captured, whatever the order says.
   */
  paymentStatus: string | null;
  paymentSecured: boolean;
  /**
   * The live refund, when there is one. Null when nothing has been refunded.
   *
   * `status` walks REQUESTED -> PENDING -> SUCCEEDED (or FAILED), and
   * `settledAt` is set only when the provider confirms the money actually
   * landed. Both are needed: "we have started your refund" and "your refund is
   * in your account" are different sentences and a customer is waiting for the
   * second one.
   */
  refund: {
    status: string;
    amountPaise: number;
    startedAt: string;
    settledAt: string | null;
  } | null;
  /**
   * `name` and `lineTotalPaise` come from the order's own snapshot and cannot
   * change. `imageUrl` is joined live from the menu item and is null for an
   * external item, a deleted dish, or a dish with no photo — `FoodTile` draws
   * its deterministic gradient for all three.
   */
  items: {
    name: string;
    quantity: number;
    lineTotalPaise: number;
    imageUrl: string | null;
  }[];
  totals: QuoteResult;
}

/** A row in the "your orders" strip. Deliberately lighter than OrderView. */
export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  status: string;
  vendorId: string;
  vendorName: string;
  estimatedPrepMinutes: number;
  totalPayablePaise: number;
  placedAt: string;
}

export interface OrderLine {
  menuItemId: string;
  quantity: number;
}

export interface OtpRequested {
  sentTo: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface OtpVerified {
  token: string;
  expiresInSeconds: number;
  /**
   * The phone is MASKED and the name is not.
   *
   * The mask exists so a glance at somebody's profile over their shoulder does
   * not read out their number. A first name is what they chose to be called,
   * and hiding it would serve nobody.
   *
   * `name` is null for a customer who never gave one, and stays whatever it was
   * for a returning customer who did not send one this time.
   */
  customer: { id: string; phone: string; name: string | null };
}

export interface PaymentIntent {
  paymentId: string;
  providerOrderRef: string;
  amountPaise: number;
  expiresAt: string;
  checkoutPayload: Record<string, unknown>;
  created: boolean;
}

export const api = {
  scan: (token: string) => request<ScanResult>(`/qr/${token}`),

  // The session is taken from the signed token on the request, not from a
  // field the caller chooses. Passing one was how a phone number could be
  // attached to somebody else's session.
  requestOtp: (phone: string) =>
    request<OtpRequested>('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  /**
   * The name travels with the CODE, not with the request.
   *
   * It is typed on the previous step and held in component state until here.
   * Sending it at `/request` would let anyone write a name against any phone
   * number they can type, with no proof they hold it — so it lands in the same
   * transaction that proves the phone, or not at all.
   */
  /**
   * `name` is REQUIRED, and the type says so.
   *
   * It used to be `name?: string`, which is how the caller ended up passing
   * `name.trim() || undefined` — a blank field silently became a customer with
   * no name, and the counter had nothing to call at collection. The server
   * rejects a missing name now; this signature is what stops a caller from
   * constructing that request in the first place.
   */
  verifyOtp: (phone: string, code: string, name: string) =>
    request<OtpVerified>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code, name }),
    }),

  paymentIntent: (orderId: string) =>
    request<PaymentIntent>(`/orders/${orderId}/payment-intent`, { method: 'POST' }),

  /**
   * Asks the SERVER what the payment did — the server then asks the provider.
   *
   * Deliberately takes no argument describing the outcome. There is nothing
   * this client could say about whether a payment succeeded that the server
   * would believe, so there is nothing for it to send. PRD §9 case B.
   */
  paymentStatus: (orderId: string) =>
    request<{ paymentStatus: string | null }>(`/orders/${orderId}/payment`),

  /**
   * Development only. The code that was just issued.
   *
   * A separate endpoint rather than a field on the send response — a
   * production route that returns the OTP under an environment check is one
   * refactor away from leaking every code to every caller.
   */
  latestOtp: () =>
    request<{ code: string | null; phone: string | null; issuedAt: string | null }>(
      '/auth/otp/dev/latest',
    ),

  /** Development only. Stands in for the provider, not for the customer. */
  simulatePayment: (orderId: string) =>
    request<{ simulated: boolean; outcome: string; orderStatus?: string }>(
      `/dev/orders/${orderId}/simulate-payment`,
      { method: 'POST' },
    ),

  // ---- "tell me when it is back" --------------------------------------------
  //
  // Session-scoped, so an anonymous scanner can use it. See the controller: a
  // diner who found the momos sold out ninety seconds after scanning a poster
  // has no account, and requiring one would lose every one of them.
  stockWatches: () => request<{ watches: StockWatch[] }>('/stock-watch'),

  watchItem: (menuItemId: string) =>
    request<{ id: string; watching: boolean }>(`/stock-watch/${menuItemId}`, { method: 'POST' }),

  unwatchItem: (menuItemId: string) =>
    request<{ watching: boolean }>(`/stock-watch/${menuItemId}`, { method: 'DELETE' }),

  markWatchesSeen: (ids: string[]) =>
    request<{ seen: number }>(`/stock-watch/seen/${ids.join(',')}`, { method: 'POST' }),

  vendors: (foodCourtId: string) =>
    request<{
      vendors: VendorSummary[];
      trending: Trending[];
      offers: Offer[];
      /**
       * Built from this court's own cuisines and menu categories, each with a
       * photograph of a dish that is genuinely in it. `imageUrl` is null when
       * nothing in the court carrying that label has a photo.
       */
      categories: {
        label: string;
        imageUrl: string | null;
        /**
         * The stalls this chip selects, decided by the server.
         *
         * Not derivable here. A chip can come from a stall's cuisine tag or
         * from the name of a menu section, and the stall list carries only the
         * first — so the client matching `label` against `cuisine` silently
         * dropped every chip of the second kind. The server does the join
         * anyway to build the chips; this is that same pass telling us what it
         * found instead of making us guess.
         */
        vendorIds: string[];
      }[];
    }>(`/food-courts/${foodCourtId}/vendors`),

  /**
   * Search the court by dish, stall name or cuisine.
   *
   * Server-side because the client only holds the stall list — it has never
   * seen a single menu, so "which stalls sell momos" is a question it cannot
   * answer locally no matter how clever the filter.
   */
  searchCourt: (foodCourtId: string, q: string) =>
    request<{ term: string; vendors: VendorSearchResult[] }>(
      `/food-courts/${foodCourtId}/search?q=${encodeURIComponent(q)}`,
    ),

  menu: (vendorId: string) => request<MenuResponse>(`/vendors/${vendorId}/menu`),

  quote: (vendorId: string, lines: OrderLine[]) =>
    request<QuoteResult>('/checkout/validate', {
      method: 'POST',
      body: JSON.stringify({ vendorId, lines }),
    }),

  placeOrder: (vendorId: string, lines: OrderLine[], idempotencyKey: string) =>
    request<PlacedOrder>('/orders', {
      method: 'POST',
      // The SAME key must be sent on every retry, so it is generated once when
      // the customer opens checkout and reused — not generated here, where a
      // retry would produce a new one and a second order.
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ vendorId, lines }),
    }),

  order: (orderId: string) => request<OrderView>(`/orders/${orderId}`),

  /**
   * Accept the cancellation the escalation ladder offered.
   *
   * The server decides whether a refund follows; this says nothing about money,
   * because the client is not the authority on any of it (PRD §7.4).
   */
  cancelOrder: (orderId: string) =>
    request<{ status: string; changed: boolean; refundStarting: boolean }>(
      `/orders/${orderId}/cancel`,
      { method: 'POST' },
    ),

  /** Every order in this session. The way back to something already cooking. */
  sessionOrders: (sessionId: string) =>
    request<{ orders: OrderSummary[] }>(`/sessions/${sessionId}/orders`),
};
