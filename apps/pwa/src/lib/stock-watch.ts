/**
 * "Tell me when it is back", on the client.
 *
 * ============================================================================
 * WHY THIS IS ONE HOOK AND NOT A BUTTON THAT CALLS AN ENDPOINT
 * ============================================================================
 *
 * The watch has to be readable from two places that never render together: the
 * dish row, which needs to know whether THIS item is being watched so the
 * button can say "Cancel" instead of "Tell me", and the app shell, which needs
 * to announce anything that came back regardless of which screen is open. A
 * diner who tapped the button on a stall menu and then wandered back to the
 * court list must still be told.
 *
 * So the list is a single query, cached under one key, and both consumers read
 * it. React Query does the sharing; nothing here holds its own copy.
 *
 * ============================================================================
 * DELIVERY, HONESTLY
 * ============================================================================
 *
 * Nothing here reaches a closed tab. Every remote tier in the API's notify
 * module is a documented stub — no socket layer, no VAPID keys — so this
 * delivers through a poll: a toast while the app is open, and the same banner
 * waiting when they come back to it. The server records `seen_at` so the second
 * visit does not re-announce what the first one showed.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { api, useIsSignedIn, type StockWatch } from './api';
import { useCart } from './cart';

const KEY = ['stock-watches'];

/**
 * Twenty seconds, not four.
 *
 * The order poll runs at four because a customer standing at a counter is
 * waiting on it. Nobody is standing still waiting for a dish to come back —
 * they are browsing, or they have put the phone away — and a five-times-faster
 * poll would spend five times the battery and five times the data to shave
 * sixteen seconds off news that is not urgent.
 */
const POLL_MS = 20_000;

/** Everything this session is waiting on. Shared by every consumer. */
export function useStockWatches(): { watches: StockWatch[]; loading: boolean } {
  const sessionId = useCart((s) => s.sessionId);

  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.stockWatches(),
    /*
     * Gated on the SESSION only, unlike the order poll which also needs a
     * verified customer. That is the point of the feature — see the controller.
     * Without a session there is nobody to attribute a watch to, so the query
     * would 401 on every tick for a browser that has not scanned anything.
     */
    enabled: Boolean(sessionId),
    refetchInterval: POLL_MS,
    // A tab left open in a pocket should not poll. The moment it comes back to
    // the front React Query refetches, which is exactly when the answer matters.
    refetchIntervalInBackground: false,
  });

  return { watches: q.data?.watches ?? [], loading: q.isLoading };
}

/** Whether one dish is being watched, and the two buttons that change that. */
export function useWatchItem(menuItemId: string): {
  watching: boolean;
  toggle: () => void;
  pending: boolean;
  error: string | null;
} {
  const qc = useQueryClient();
  const { watches } = useStockWatches();
  const watching = watches.some((w) => w.menuItemId === menuItemId && !w.restocked);

  const mutation = useMutation({
    mutationFn: () =>
      watching ? api.unwatchItem(menuItemId) : api.watchItem(menuItemId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });

  return {
    watching,
    toggle: () => mutation.mutate(),
    pending: mutation.isPending,
    /*
     * The SERVER's sentence, not a generic one.
     *
     * Every refusal here is a real answer worth reading — "that one is
     * available right now", "it is not sold out, it goes on sale later today" —
     * and replacing them with "Something went wrong" would turn four useful
     * messages into one useless one.
     */
    error: mutation.error ? String((mutation.error as Error).message) : null,
  };
}

/**
 * Announce anything that came back, once.
 *
 * Mounted at the app shell so it fires on whichever screen is open. The
 * dedupe is the SERVER's `seen` flag rather than a ref: a ref lives as long as
 * the tab, and the whole promise of the feature is that closing the tab does
 * not lose the news.
 *
 * `inFlight` is a local guard against a different problem — the poll firing
 * again before the seen-marking round trip returns, which would announce the
 * same dish twice within one second. It is a debounce, not the dedupe.
 */
export function useRestockAnnouncements(
  announce: (watch: StockWatch) => void,
): void {
  const qc = useQueryClient();
  const { watches } = useStockWatches();
  const signedIn = useIsSignedIn();
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    const fresh = watches.filter(
      (w) => w.restocked && !w.seen && !inFlight.current.has(w.id),
    );
    if (fresh.length === 0) return;

    for (const w of fresh) {
      inFlight.current.add(w.id);
      announce(w);
    }

    void api
      .markWatchesSeen(fresh.map((w) => w.id))
      .then(() => qc.invalidateQueries({ queryKey: KEY }))
      .catch(() => {
        // The mark failed, so the server still thinks these are unseen and will
        // offer them again on the next poll. Releasing the guard is what lets
        // that retry happen — swallowing it would mean a dish announced into a
        // dropped connection is never announced again.
        for (const w of fresh) inFlight.current.delete(w.id);
      });
  }, [watches, announce, qc, signedIn]);
}
