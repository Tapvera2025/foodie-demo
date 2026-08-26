/**
 * A media query, as React state.
 *
 * ============================================================================
 * WHY THIS EXISTS RATHER THAN `md:hidden` AND A SECOND COPY
 * ============================================================================
 *
 * Most responsive differences in this app are CSS, and should stay that way —
 * showing one thing below `md` and another above is one class, no JavaScript,
 * and no hydration mismatch.
 *
 * It stops working the moment the two variants must not both exist. The search
 * field is the case: a permanently-open box is right on a phone, where it gets
 * its own full-width row, and wrong on a desktop, where it becomes a wide
 * bright rectangle across the most valuable strip of the screen. Rendering both
 * and hiding one puts TWO `<input>` elements in the document with the same
 * purpose, which means:
 *
 *   - a screen reader announces the search box twice
 *   - focus can land in the hidden one via the keyboard
 *   - the caret position, IME state and text selection are per-element, so
 *     rotating a tablet across the breakpoint loses whatever was half-typed
 *
 * One element whose BEHAVIOUR changes has none of those problems.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, for the same
 * reason the theme and the auth stores use it: the value lives outside React,
 * and a `useState` copy is a second source of truth that renders one frame
 * stale on every change.
 */

import { useSyncExternalStore } from 'react';

/**
 * Matchers are cached per query string.
 *
 * `useSyncExternalStore` compares the snapshot by identity and re-subscribes
 * when `subscribe` changes. Building a new `MediaQueryList` on every render
 * would tear down and rebuild the listener on every render, which is both a
 * leak and an infinite loop waiting for a dependency array to be edited wrong.
 */
const cache = new Map<string, MediaQueryList>();

function matcher(query: string): MediaQueryList | null {
  // Guarded for the same reason `initTheme` is: this module is imported by
  // code that could one day be server-rendered, and `matchMedia` does not
  // exist there.
  if (typeof window === 'undefined' || !window.matchMedia) return null;

  let m = cache.get(query);
  if (!m) {
    m = window.matchMedia(query);
    cache.set(query, m);
  }
  return m;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matcher(query);
      if (!m) return () => {};
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => matcher(query)?.matches ?? false,
    // The server snapshot. FALSE means "assume the narrow layout", which is the
    // right way round: a phone getting the desktop treatment for one frame is a
    // visible jump on the slowest device, and a desktop getting the phone
    // treatment for one frame is not.
    () => false,
  );
}

/**
 * The one breakpoint this app makes a behavioural decision at.
 *
 * 48rem is Tailwind's `md`, and it is written here as a constant so the
 * JavaScript and the `md:` classes beside it cannot drift apart. A component
 * that switches behaviour at 48rem while its own layout switches at 40rem is a
 * bug nobody can see in either file alone.
 */
export const MD = '(min-width: 48rem)';

/**
 * The customer has asked their operating system for less movement.
 *
 * Honoured by `useAutoAdvance`, which disables itself entirely rather than
 * merely shortening anything: this setting is the only way somebody can say
 * "stop moving things at me" from OUTSIDE the app, and a carousel that
 * auto-advances more politely is still a carousel that auto-advances. It sits
 * beside `MD` for the same reason that one does — so the JavaScript and the
 * `motion-safe:` classes elsewhere cannot drift apart.
 */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
