/**
 * Cart draft and session. Client state ONLY.
 *
 * What lives here: which items the customer tapped, and which table they are
 * sitting at. What does NOT live here: any price, any total, any order status.
 * Those are server-owned, and a copy of server state in a client store is a
 * copy that will be stale at the worst moment.
 *
 * The single-vendor rule is enforced here as UX and by the server as truth.
 * Switching stalls clears the basket, because an order belongs to one kitchen.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { setSessionToken } from './api';

export interface DraftLine {
  menuItemId: string;
  name: string;
  pricePaise: number;
  quantity: number;
  /**
   * The dish photograph, CARRIED WITH THE LINE.
   *
   * Checkout has no menu. It renders from this store alone — that is the whole
   * point of the store, and it is what makes the basket survive a reload and a
   * verification round trip. So a field that is not here cannot be shown there,
   * and the photo was not here: every line at checkout drew the generated
   * gradient tile, on the one screen where the customer is confirming what they
   * are about to pay for.
   *
   * Optional, and that is deliberate rather than lazy. Baskets persisted before
   * this field existed are still in people's browsers; `undefined` reads as "no
   * photo" and renders exactly what those lines rendered yesterday, instead of
   * throwing on a shape that does not match.
   */
  imageUrl?: string | null;
}

interface CartState {
  sessionId: string | null;
  /**
   * Proves this browser owns `sessionId`.
   *
   * Persisted with it, because a reload that loses this loses the basket — the
   * server would open a fresh session rather than resuming. It is not a
   * substitute for identity: ordering and order history both additionally
   * require the customer token, which is deliberately memory-only.
   */
  sessionToken: string | null;
  foodCourtId: string | null;
  foodCourtName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  lines: DraftLine[];
  /**
   * Generated once when checkout opens and reused for every retry of that
   * order. Regenerating per attempt would defeat the whole mechanism.
   */
  idempotencyKey: string | null;
  /**
   * The masked phone from verification, for the profile header.
   *
   * MASKED, not the real number. The client never needs the full value again —
   * the server has it, and every request is authenticated by the token rather
   * than the number. Storing "+91 ***** 43210" means a persisted store that
   * leaks nothing useful if someone reads it.
   */
  customerPhone: string | null;
  /**
   * What to call the customer. Optional — nobody is required to give it.
   *
   * Held beside the masked phone because they are set together, at the one
   * moment this app asks for anything about a person, and read together on the
   * profile screen.
   */
  customerName: string | null;

  startSession: (s: {
    sessionId: string;
    sessionToken: string;
    foodCourtId: string;
    foodCourtName: string;
  }) => void;
  setVendor: (id: string, name: string) => void;
  add: (item: {
    id: string;
    name: string;
    pricePaise: number;
    imageUrl?: string | null;
  }) => void;
  setQuantity: (menuItemId: string, quantity: number) => void;
  clearLines: () => void;
  beginCheckout: () => string;
  endCheckout: () => void;
  /** Discard a checkout key the server will no longer accept. */
  resetCheckoutKey: () => void;
  setCustomerIdentity: (masked: string, name: string | null) => void;
}

const itemCount = (lines: DraftLine[]): number => lines.reduce((n, l) => n + l.quantity, 0);

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      sessionToken: null,
      foodCourtId: null,
      foodCourtName: null,
      vendorId: null,
      vendorName: null,
      lines: [],
      idempotencyKey: null,
      customerPhone: null,
      customerName: null,

      startSession: (s) => {
        // The api module holds the live copy; this store holds the durable one.
        setSessionToken(s.sessionToken);
        set((prev) =>
          // Same session resumed: keep the basket. A customer who backgrounded
          // the tab and rescanned should not lose their order.
          prev.sessionId === s.sessionId
            ? { ...s }
            : { ...s, vendorId: null, vendorName: null, lines: [], idempotencyKey: null },
        );
      },

      setVendor: (id, name) =>
        set((prev) =>
          prev.vendorId === id
            ? { vendorId: id, vendorName: name }
            : // Different stall — the basket cannot survive, because an order
              // has exactly one vendor. Screens warn before calling this.
              { vendorId: id, vendorName: name, lines: [] },
        ),

      add: (item) =>
        set((prev) => {
          const existing = prev.lines.find((l) => l.menuItemId === item.id);
          if (existing) {
            return {
              lines: prev.lines.map((l) =>
                l.menuItemId === item.id
                  ? {
                      ...l,
                      quantity: Math.min(50, l.quantity + 1),
                      // Backfill for a line added before this field existed.
                      // `??` not `||`: an explicit null from the menu means the
                      // dish genuinely has no photograph, and re-asking every
                      // time would be pointless.
                      imageUrl: l.imageUrl ?? item.imageUrl ?? null,
                    }
                  : l,
              ),
            };
          }
          return {
            lines: [
              ...prev.lines,
              {
                menuItemId: item.id,
                name: item.name,
                pricePaise: item.pricePaise,
                quantity: 1,
                imageUrl: item.imageUrl ?? null,
              },
            ],
          };
        }),

      setQuantity: (menuItemId, quantity) =>
        set((prev) => ({
          lines:
            quantity <= 0
              ? prev.lines.filter((l) => l.menuItemId !== menuItemId)
              : prev.lines.map((l) =>
                  l.menuItemId === menuItemId ? { ...l, quantity: Math.min(50, quantity) } : l,
                ),
        })),

      clearLines: () => set({ lines: [], idempotencyKey: null }),

      beginCheckout: () => {
        const existing = get().idempotencyKey;
        if (existing) return existing;
        const key = crypto.randomUUID();
        set({ idempotencyKey: key });
        return key;
      },

      endCheckout: () => set({ lines: [], idempotencyKey: null }),

      /**
       * Throw away a checkout key that can no longer be honoured.
       *
       * `idempotencyKey` is persisted, and `endCheckout` clears it only on
       * SUCCESS — correctly, because surviving a failure is the entire point of
       * an idempotency key: the retry must reach the same order rather than
       * place a second one.
       *
       * There is one case where that is wrong. If the server refuses the key as
       * belonging to somebody else, no retry can ever succeed: every attempt
       * replays the same refusal, and the basket is bricked until the customer
       * clears their browser storage — which nobody will do.
       *
       * That state is reachable by an ordinary sequence. The key lives in
       * localStorage and the customer token lives in memory, so "checkout
       * failed, reload, verify again" leaves a key from the previous identity.
       *
       * The LINES ARE KEPT. The customer still wants the food; only the receipt
       * number for an order they cannot claim is discarded.
       */
      resetCheckoutKey: () => set({ idempotencyKey: null }),

      setCustomerIdentity: (masked, name) =>
        set((prev) => ({
          // Both in one write. Two setters would allow a render between them
          // where the phone is known and the name is not, which the profile
          // header would show as a greeting with a blank in it.
          customerPhone: masked,
          customerName: name,

          /*
           * ================================================================
           * A DIFFERENT PERSON DOES NOT INHERIT THE LAST ONE'S CHECKOUT KEY
           * ================================================================
           *
           * `idempotencyKey` is persisted and survives a failed checkout on
           * purpose — a retry must reach the same order rather than place a
           * second one. It must NOT survive a change of customer.
           *
           * The sequence that proved it: two phones verified in one browser
           * six minutes apart. `app_session.customer_id` moved to the second
           * person, the first person's order kept the first customer, and the
           * second person's checkout replayed the first person's key. The
           * server refused it — correctly, that order is not theirs — and the
           * basket was stuck on a key no retry could ever redeem.
           *
           * Comparing MASKED phones is enough: they differ whenever the real
           * numbers do, and the store deliberately never holds the real one.
           *
           * The LINES ARE KEPT. Somebody who just verified on this device
           * wants the food in the basket; only the receipt number for an order
           * they cannot claim is discarded.
           */
          idempotencyKey:
            prev.customerPhone !== null && prev.customerPhone !== masked
              ? null
              : prev.idempotencyKey,
        })),
    }),
    {
      name: 'foodcourt-cart',
      /**
       * Push the restored session token back into the api module on reload.
       *
       * Without this the store remembers the session and every request forgets
       * to prove it owns one, so the first call after a refresh opens a new
       * session and silently orphans the basket.
       */
      onRehydrateStorage: () => (state) => {
        if (state?.sessionToken) setSessionToken(state.sessionToken);
      },
      // Survives a reload, a backgrounded tab, and the browser killing the page
      // while the customer talks to a friend. Nothing here is sensitive: item
      // ids, names and a session id scoped to one table for four hours.
      partialize: (s) => ({
        sessionId: s.sessionId,
        sessionToken: s.sessionToken,
        foodCourtId: s.foodCourtId,
        foodCourtName: s.foodCourtName,
        vendorId: s.vendorId,
        vendorName: s.vendorName,
        lines: s.lines,
        idempotencyKey: s.idempotencyKey,
        customerPhone: s.customerPhone,
        customerName: s.customerName,
      }),
    },
  ),
);

export const useCartCount = (): number => useCart((s) => itemCount(s.lines));
