import { useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api, auth } from './api';
import { Login } from './Login';
import { Board } from './Board';
import { useFallbackInterval, ORDER_CHANGED, useRealtime } from './realtime';

/**
 * Signed in, or not. One source of truth.
 *
 * The token is the ONLY thing that decides which screen renders. An earlier
 * version combined a `signedIn` React state with a localStorage read and the
 * board query's `isError`, and the result flickered between the sign-in form
 * and the queue every few seconds:
 *
 *   - `auth.clear()` ran inside a fetch handler, which React could not observe,
 *     so `signedIn` stayed true and the query kept polling a dead token;
 *   - `isError` is false during a retry and true after retries are exhausted,
 *     and `refetchInterval` restarted that cycle every three seconds.
 *
 * The UI was faithfully rendering a state machine nobody meant to expose. A
 * cook watching that during service would reasonably conclude the whole system
 * was broken.
 */
export function App() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const token = useSyncExternalStore(auth.subscribe, auth.get, auth.get);
  const qc = useQueryClient();

  /*
   * ==========================================================================
   * THE BOARD IS PUSHED NOW, NOT PULLED
   * ==========================================================================
   *
   * `order.changed` is published inside the transaction that moved the order,
   * so a paid order reaches this tablet on the commit rather than up to three
   * seconds later — comfortably inside the five seconds PRD §16.1 asks for,
   * and without a tablet asking a question twenty times a minute for a whole
   * service.
   *
   * The stall's own room is joined from the staff token at handshake, so this
   * board hears about its own orders and cannot hear about anybody else's.
   * There is no subscribe message and no vendor id on the wire — see
   * `src/realtime/rooms.ts`.
   *
   * `FALLBACK_MS` is 15s here rather than the customer app's 60s. The reason
   * is in `realtime.ts`: a silently dead socket on this screen means a stall
   * that has been paid and does not know it.
   */
  useRealtime(ORDER_CHANGED, [['board']], token !== null);

  const board = useQuery({
    queryKey: ['board'],
    queryFn: () => api.board(),
    // The query simply does not exist while signed out. No polling, no error
    // state to accidentally render against.
    enabled: token !== null,
    refetchInterval: fallbackMs,
  });

  if (token === null) {
    return (
      <Login
        reason={auth.reason()}
        onSignedIn={() => {
          // Drop anything cached under the previous token. Without this the
          // board flashes the last stall's tickets for one frame after a
          // different cook signs in — which at a shared tablet is somebody
          // else's queue.
          qc.clear();
        }}
      />
    );
  }

  return <Board query={board} onSignOut={() => auth.clear('MANUAL')} />;
}
