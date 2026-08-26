/**
 * ============================================================================
 * THE SOCKET, AND WHY IT ONLY EVER CALLS `invalidateQueries`
 * ============================================================================
 *
 * PRD §11.4, stated as a rule rather than a preference:
 *
 *   "Socket events invalidate and trigger a re-fetch; they never write client
 *    state directly, because event ordering is not guaranteed and a client
 *    that derives state from event sequence will eventually be wrong."
 *
 * So this file contains no order state, no status, no reducer. An event
 * arrives, the matching query is marked stale, React Query refetches over
 * HTTP, and the server — which holds the only true answer — supplies it. The
 * server helps by sending payloads with no status in them, so there is nothing
 * here that COULD be rendered directly even by mistake.
 *
 * That also makes the socket disposable. If it never connects, every screen
 * still works: the fallback refetch below is slower, and nothing else differs.
 * Realtime is an accelerator over polling, not a dependency.
 *
 * ----------------------------------------------------------------------------
 * WHY THE FALLBACK POLL IS NOT "UNNECESSARY POLLING"
 * ----------------------------------------------------------------------------
 *
 * The hot polls this replaces ran every 3–4 seconds forever. What is left is a
 * refetch at `FALLBACK_MS`, and it is doing a different job:
 *
 *   - a socket can be silently dead. A phone that slept, a captive portal, a
 *     proxy that dropped an idle connection — in every one of those the client
 *     believes it is connected and receives nothing. There is no event for
 *     "you stopped getting events".
 *   - LISTEN/NOTIFY is not durable. An API instance restarting misses whatever
 *     was published while it was gone, and no replay exists.
 *
 * A customer standing at a counter must not be the mechanism that discovers
 * either. One request a minute per open screen is roughly a fortieth of what
 * this replaces, and it is the difference between a stale screen self-healing
 * and a stale screen staying stale.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

import { customerAuth } from './api';

/** Matches the server's `path` in realtime.gateway.ts. */
const PATH = '/realtime';

export const ORDER_CHANGED = 'order.changed';
export const CATALOG_CHANGED = 'catalog.changed';

/**
 * Insurance, not polling — WHILE THE SOCKET IS UP.
 *
 * 60s: long enough that it is not a poll in any meaningful sense, short enough
 * that a socket which has died without saying so is noticed inside the life of
 * one order.
 */
export const FALLBACK_MS = 60_000;

/**
 * ============================================================================
 * WHAT TO DO WHEN THERE IS NO SOCKET AT ALL
 * ============================================================================
 *
 * `FALLBACK_MS` was applied unconditionally, and that was a regression waiting
 * to happen. The old hot polls were 3–4 seconds; replacing them with 60 was
 * justified ONLY by "a socket will deliver it sooner". When the socket is not
 * connected, that justification is gone and the app is simply fifteen times
 * slower than it was before realtime existed.
 *
 * And it is not a hypothetical. The socket is down whenever the API has not
 * been restarted since the gateway was added, whenever a proxy declines the
 * upgrade, whenever the tab wakes from sleep before reconnection completes —
 * and the visible symptom is a customer watching "RECEIVED" for a minute after
 * their order was rejected. Nothing on screen would say why.
 *
 * A client cannot know that a CONNECTED socket has silently stopped
 * delivering. It absolutely can know that it has no connection at all. So that
 * case gets the old interval back, automatically, with no configuration and
 * nothing for anybody to notice or remember.
 */
export const DEGRADED_MS = 4_000;

/**
 * ONE socket for the whole app, not one per screen.
 *
 * Every screen that wants events wants the SAME events — the rooms are fixed
 * at handshake from the token, so a second connection would receive an
 * identical stream at twice the cost and hold a second server-side session.
 * The module-level singleton is what keeps "how many sockets exist" answerable.
 */
let socket: Socket | null = null;
let currentToken: string | null = null;

/*
 * A tiny external store, so React can re-render when the connection changes.
 *
 * `socket.connected` is a mutable property on an object React knows nothing
 * about, so reading it during render would give a value that never updates.
 * `useSyncExternalStore` is the supported way to subscribe to exactly this
 * kind of thing, and `connected` is a boolean primitive so the identity
 * comparison it does is correct without memoisation.
 */
const connectionListeners = new Set<() => void>();
let connected = false;

function setConnected(next: boolean): void {
  if (connected === next) return; // Do not wake React for a no-op.
  connected = next;
  for (const l of connectionListeners) l();
}

/**
 * Is realtime actually working right now?
 *
 * Screens use it to choose their refetch interval: `FALLBACK_MS` while the
 * socket is up, `DEGRADED_MS` when it is not. That keeps the app exactly as
 * responsive as it was before realtime existed on the days realtime is broken.
 */
export function useRealtimeConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      connectionListeners.add(l);
      return () => connectionListeners.delete(l);
    },
    () => connected,
    // Server snapshot. There is no socket during SSR or the first paint.
    () => false,
  );
}

/** The interval a query should poll at, given the state of the socket. */
export function useFallbackInterval(): number {
  return useRealtimeConnected() ? FALLBACK_MS : DEGRADED_MS;
}

function ensureSocket(token: string | null): Socket | null {
  if (token === null) {
    socket?.disconnect();
    socket = null;
    currentToken = null;
    setConnected(false);
    return null;
  }

  // A changed token is a different principal — or the same one after
  // re-verifying. Either way the open connection was authenticated with a
  // credential that no longer applies, and the server assigned its rooms from
  // that credential at handshake. Reconnecting is the only way those rooms get
  // recomputed.
  if (socket && currentToken !== token) {
    socket.disconnect();
    socket = null;
  }

  if (!socket) {
    currentToken = token;
    socket = io({
      path: PATH,
      // `auth`, not a query string: a token in a query string ends up in
      // access logs, Referer headers and any proxy that records URLs.
      auth: { token },
      transports: ['websocket', 'polling'],
      // socket.io's own reconnection, which handles the common case — a phone
      // waking up, a tunnel flapping — without any code here.
      reconnection: true,
      reconnectionDelayMax: 10_000,
    });

    /*
     * Bound once, on the socket rather than per subscription. `connect_error`
     * is the one that matters most here: it is what fires when the server has
     * no `/realtime` gateway — an API that has not been restarted since it was
     * added — and without this the app would sit on the slow interval blaming
     * nothing.
     */
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
  }

  return socket;
}

/**
 * Subscribe the given query keys to a realtime event.
 *
 * `keys` is the list to invalidate. Passing the keys rather than a callback is
 * deliberate: it makes every subscription a declaration of "these queries
 * depend on this event", which is greppable, and it removes the temptation to
 * do something other than invalidate in the handler.
 */
export function useRealtime(
  event: string,
  keys: readonly (readonly unknown[])[],
  enabled = true,
): void {
  const qc = useQueryClient();
  // Stringified so the effect's dependency is a value rather than a fresh
  // array identity on every render, which would tear the listener down and
  // rebuild it constantly.
  const keySignature = JSON.stringify(keys);

  useEffect(() => {
    if (!enabled) return;

    const s = ensureSocket(customerAuth.token());
    if (!s) return;

    const handler = (): void => {
      for (const key of JSON.parse(keySignature) as unknown[][]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    };

    s.on(event, handler);

    /*
     * Also refetch on every (re)connect.
     *
     * The gap between losing a connection and regaining it is exactly when
     * events are missed, and the client cannot know what it missed. Refetching
     * on connect closes that window without needing to.
     */
    s.on('connect', handler);

    return () => {
      s.off(event, handler);
      s.off('connect', handler);
      // The socket itself is NOT disconnected here. It is shared, and one
      // screen unmounting must not cut off the others.
    };
  }, [event, keySignature, enabled, qc]);
}

/** Only for sign-out. Screens must never call this — see the singleton note. */
export function closeRealtime(): void {
  socket?.disconnect();
  socket = null;
  currentToken = null;
  setConnected(false);
}
