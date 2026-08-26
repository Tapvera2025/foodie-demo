/**
 * Light and dark, with an app-chosen default.
 *
 * THE DEFAULT IS THE PRODUCT'S, NOT THE OPERATING SYSTEM'S
 *
 * The usual pattern is to follow `prefers-color-scheme` and call it respectful.
 * Here it is wrong, because the two surfaces have opposite constraints and the
 * OS knows about neither:
 *
 *   - a customer's phone is competing with daylight in a food court, so light
 *     wins whatever the phone was set to at breakfast;
 *   - a kitchen tablet glares at somebody over a hot range for eight hours, so
 *     dark wins whatever the tablet shipped with.
 *
 * So the precedence is: an explicit choice the person made, then the app's
 * default, and `prefers-color-scheme` is not consulted at all. A customer who
 * runs their phone dark and gets a light menu has lost nothing — the toggle is
 * one tap away and their choice sticks.
 *
 * `useSyncExternalStore` rather than a context, for the same reason the KDS
 * auth store uses it: the value can change from outside React (another tab),
 * and a source of truth React polls during render is the bug that made the
 * kitchen board flicker.
 */

export type Theme = 'light' | 'dark';

const KEY = 'foodcourt-theme';

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // Private browsing can throw on localStorage. A theme is not worth a crash.
    return null;
  }
}

/** Cached, because `useSyncExternalStore` compares snapshots by identity. */
let current: Theme = read() ?? 'light';

function paint(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  // Tells the browser to theme its own chrome — form controls, scrollbars, and
  // the address bar on mobile. Without it a dark page keeps a white scrollbar.
  document.documentElement.style.colorScheme = t;
}

/** Call once, before React mounts, so there is no flash of the wrong theme. */
export function initTheme(fallback: Theme = 'light'): void {
  current = read() ?? fallback;
  paint(current);
}

export const theme = {
  get: (): Theme => current,

  set(t: Theme): void {
    current = t;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // Choice does not persist in private browsing. It still applies now.
    }
    paint(t);
    for (const l of listeners) l();
  },

  toggle(): void {
    theme.set(current === 'light' ? 'dark' : 'light');
  },

  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
