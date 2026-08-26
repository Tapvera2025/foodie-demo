import type { StockAlert } from './api';
/**
 * Kitchen notifications: a sound and a banner.
 *
 * A KITCHEN IS NOT A PHONE, AND THE ORDER OF THESE TWO MATTERS
 *
 * A cook is facing a hob, not the tablet. A visual toast on a screen nobody is
 * looking at is decoration. The ALERT is the sound; the banner is what explains
 * it once they turn round. So the sound fires first and unconditionally, and
 * the banner is what survives long enough to be read.
 *
 * WHY THE SOUND IS SYNTHESISED AND NOT AN MP3
 *
 * No asset to ship, no fetch that can fail, no 404 that silently removes the
 * only alert in a kitchen. Two short square-wave beeps through the Web Audio
 * API — deliberately not a pleasant chime, because it has to cut through an
 * extractor fan.
 *
 * BROWSERS BLOCK AUDIO UNTIL A GESTURE, AND THAT IS A REAL HAZARD HERE
 *
 * Autoplay policy means `AudioContext` starts suspended until the user
 * interacts. On a tablet that was pinned to this page at 6am and not touched
 * since, the first new order would beep at nobody. So the context is resumed on
 * the first interaction of the session — signing in counts — and the board
 * warns if it is still suspended, because "the alert is muted" is exactly the
 * kind of failure that is invisible until an order is missed.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

let ctx: AudioContext | null = null;

/**
 * ============================================================================
 * WHY THE MUTED BANNER KEPT COMING BACK
 * ============================================================================
 *
 * Two bugs, and the first one explains why the second was never noticed.
 *
 * 1. NOTHING EVER UNLOCKED IT ON A SIGNED-IN BOARD.
 *
 *    `unlockAudio()` lived in the login form's submit handler, which is the one
 *    gesture guaranteed to happen on a tablet that then sits untouched for
 *    hours. Correct — except a mounted kitchen tablet is ALREADY signed in.
 *    The token is in localStorage, the login screen never renders, the handler
 *    never runs, and the AudioContext is created suspended by the board's first
 *    `audioBlocked()` call. Which is to say: the normal state of the device this
 *    was written for was the one state it did not cover.
 *
 * 2. THE STATE WAS NOT REACTIVE.
 *
 *    `audioBlocked()` read `ctx.state` during render, and `resume()` is async
 *    with nothing re-rendering when it settles. So tapping the banner did work
 *    and looked like it had not — the banner stayed until the next three-second
 *    poll happened to re-render. People tap again. And again.
 *
 * Both are fixed by making this a store: `statechange` is an event the
 * AudioContext already emits, so React can watch the real thing rather than
 * sampling it. And the unlock is now bound to the FIRST INTERACTION WITH THE
 * PAGE, whatever it is, rather than to one specific form nobody signed in
 * through.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

/** Cached, because `useSyncExternalStore` compares this by identity. */
let blocked = false;

function emit(): void {
  for (const l of listeners) l();
}

function refresh(): void {
  const next = ctx !== null && ctx.state === 'suspended';
  if (next === blocked) return;
  blocked = next;
  emit();
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx === null) {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    // The context tells us when it resumes or gets suspended again — Chrome
    // will re-suspend a backgrounded tab, so this is not a one-way trip.
    ctx.addEventListener('statechange', refresh);
    refresh();
  }
  return ctx;
}

/** Call from any real user gesture. Safe to call repeatedly. */
export function unlockAudio(): void {
  const a = audio();
  if (a && a.state === 'suspended') {
    // `refresh` also runs on `statechange`; this covers the browser that
    // resolves the promise without firing the event.
    void a.resume().then(refresh, refresh);
  }
}

/**
 * Unlock on the first interaction with the page, whatever it is.
 *
 * The autoplay policy wants *a* gesture, not a particular one. Tying it to the
 * login form meant an already-signed-in tablet — the normal case — never
 * unlocked at all. `once: true` so this costs nothing after the first touch,
 * and `capture` so it fires even if something calls `stopPropagation`.
 */
export function armAudioUnlock(): () => void {
  const opts = { once: true, capture: true } as const;
  const go = (): void => unlockAudio();

  window.addEventListener('pointerdown', go, opts);
  window.addEventListener('keydown', go, opts);
  // Creating the context now is what makes the banner appear at all on a board
  // nobody has touched — without it `ctx` is null and `blocked` stays false.
  audio();

  return () => {
    window.removeEventListener('pointerdown', go, opts);
    window.removeEventListener('keydown', go, opts);
  };
}

export const audioState = {
  isBlocked: (): boolean => blocked,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The muted state, as something React watches rather than samples. */
export function useAudioBlocked(): boolean {
  return useSyncExternalStore(audioState.subscribe, audioState.isBlocked, audioState.isBlocked);
}

/**
 * Two beeps, 880Hz then 1320Hz.
 *
 * A rising pair reads as "something arrived" rather than "something is wrong" —
 * a falling pair is the universal error sound and would make every new order
 * feel like a problem.
 */
export function alertNewOrder(): void {
  const a = audio();
  if (!a || a.state === 'suspended') return;

  const now = a.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;

    // A hard start and stop on a square wave clicks audibly. The short ramp is
    // not polish, it is the difference between a beep and a pop.
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
    gain.gain.setValueAtTime(0.25, t + 0.12);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);

    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}

// =============================================================================
// The diff
// =============================================================================

export interface KitchenNotice {
  id: number;
  title: string;
  body?: string;
  tone: 'new' | 'info' | 'bad';
}

export interface WatchedTicket {
  orderId: string;
  orderNumber: string;
  status: string;
}

const UNACCEPTED = new Set(['PAYMENT_CONFIRMED', 'DISPATCHED']);

let noticeId = 1;

/**
 * Watches the board and raises a notice — plus a sound — when a ticket arrives.
 *
 * As with the customer app, the first snapshot is silent. A cook signing in to
 * a board with four tickets on it does not need four alerts for orders that
 * arrived while they were making tea.
 */
/**
 * How long a notice stays before clearing itself.
 *
 * IT AUTO-DISMISSES, AND NOTHING IS LOST WHEN IT DOES.
 *
 * The notice is not the record of the order — the TICKET is, and it is on the
 * board pulsing, with the New count up beside the filters. This is only "that
 * arrived while you were turned away", and a message saying so is stale a
 * minute later.
 *
 * Requiring a tap made it worse than useless during a rush: three arrivals in
 * two minutes left three slabs stacked over the queue until somebody had a free
 * hand, which is precisely when nobody does.
 *
 * Twelve seconds — long enough to turn round, wipe your hands and read it.
 */
const NOTICE_MS = 12_000;

export function useKitchenNotifications(
  tickets: readonly WatchedTicket[] | undefined,
  /**
   * What has run out, from the heartbeat. Optional so the hook still works on
   * a board rendered before the first heartbeat has landed.
   */
  stock?: readonly StockAlert[] | undefined,
): {
  notices: KitchenNotice[];
  dismiss: (id: number) => void;
} {
  const [notices, setNotices] = useState<KitchenNotice[]>([]);
  const seen = useRef<Map<string, string> | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /**
   * What each item's alert state was on the previous heartbeat.
   *
   * The heartbeat re-reports the same alert every fifteen seconds for as long
   * as the item is out — correctly, because it is a snapshot rather than an
   * event stream. Announcing a snapshot is how a kitchen gets four toasts a
   * minute about a dish that ran out at eleven, so only a CHANGE is announced.
   *
   * `null` on the first pass, which suppresses the whole initial set: a board
   * opening in the middle of a shift would otherwise shout about everything
   * that was already out before anybody sat down.
   */
  const stockSeen = useRef<Map<string, 'OUT' | 'LOW'> | null>(null);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setNotices((n) => n.filter((x) => x.id !== id));
  }, []);

  // Every pending timer, cleared on unmount. A `setState` after the component
  // is gone is a React warning, and on a board that switches tabs constantly it
  // would be a steady drip of them.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (!tickets) return;

    if (seen.current === null) {
      seen.current = new Map(tickets.map((t) => [t.orderId, t.status]));
      return;
    }

    const arrivals: KitchenNotice[] = [];

    for (const t of tickets) {
      const previous = seen.current.get(t.orderId);
      seen.current.set(t.orderId, t.status);

      // A ticket that was not on the board a moment ago and needs accepting.
      // Deliberately keyed on ABSENCE rather than on a status change, because
      // an order arrives already in PAYMENT_CONFIRMED — there is no prior
      // state on this board to have changed from.
      if (previous === undefined && UNACCEPTED.has(t.status)) {
        arrivals.push({
          id: noticeId++,
          title: `New order ${t.orderNumber}`,
          body: 'Accept it to start cooking.',
          tone: 'new',
        });
      }
    }

    // Tickets that left the board entirely — collected, or rejected elsewhere.
    for (const id of [...seen.current.keys()]) {
      if (!tickets.some((t) => t.orderId === id)) seen.current.delete(id);
    }

    if (arrivals.length > 0) {
      alertNewOrder();
      setNotices((n) => [...n.slice(-2), ...arrivals]);

      for (const a of arrivals) {
        timers.current.set(
          a.id,
          setTimeout(() => dismiss(a.id), NOTICE_MS),
        );
      }
    }
  }, [tickets, dismiss]);

  /**
   * ==========================================================================
   * RAN OUT, AND RUNNING LOW
   * ==========================================================================
   *
   * A separate effect from the ticket one, because the two have different
   * sources and different cadences — the board polls every three seconds, the
   * heartbeat every fifteen — and folding them together would re-run the whole
   * ticket diff five times per stock check.
   *
   * ESCALATION ONLY. `LOW` then `OUT` announces twice, which is right: they are
   * different facts and the second is worse. `OUT` then `LOW` — which happens
   * the moment somebody tops the count back up — announces nothing, because
   * "you have three left" is not news to whoever just added them.
   */
  useEffect(() => {
    if (!stock) return;

    if (stockSeen.current === null) {
      stockSeen.current = new Map(stock.map((a) => [a.itemId, a.kind]));
      return;
    }

    const fresh: KitchenNotice[] = [];

    for (const a of stock) {
      const previous = stockSeen.current.get(a.itemId);
      stockSeen.current.set(a.itemId, a.kind);

      if (previous === a.kind) continue;
      // LOW after OUT is a top-up, not a warning. See above.
      if (previous === 'OUT' && a.kind === 'LOW') continue;

      fresh.push(
        a.kind === 'OUT'
          ? {
              id: noticeId++,
              title: `${a.name} has run out`,
              body: 'Customers can no longer order it. Add stock to put it back.',
              tone: 'bad',
            }
          : {
              id: noticeId++,
              // The NUMBER, not the word. "Running low" cannot be acted on;
              // "2 left" is a decision about whether to start another batch.
              title: `${a.name}: ${a.remaining} left`,
              body: 'Still selling. Add more before it runs out.',
              tone: 'info',
            },
      );
    }

    // An item that dropped off the list entirely is back above its threshold.
    // Forgetting it means the next time it runs low it is news again.
    for (const id of [...stockSeen.current.keys()]) {
      if (!stock.some((a) => a.itemId === id)) stockSeen.current.delete(id);
    }

    if (fresh.length === 0) return;

    // The sound is for an item that is GONE. A low warning that makes the same
    // noise as a new order teaches the kitchen to ignore the noise.
    if (fresh.some((n) => n.tone === 'bad')) alertNewOrder();

    setNotices((n) => [...n.slice(-2), ...fresh]);
    for (const f of fresh) {
      timers.current.set(
        f.id,
        setTimeout(() => dismiss(f.id), NOTICE_MS),
      );
    }
  }, [stock, dismiss]);

  return { notices, dismiss };
}
