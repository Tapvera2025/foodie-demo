/**
 * Light and dark for the console, defaulting light.
 *
 * A near-copy of the customer app's `lib/theme.ts`, deliberately rather than a
 * shared package: three separate Vite builds with no shared workspace module,
 * and sixty lines duplicated is cheaper than a package boundary for one file.
 * The two lines that differ are the storage key and the default.
 *
 * The KEY is what matters most in that pair. On a laptop running all three apps
 * on localhost they share an origin, so a single key would mean flipping the
 * console to dark also flipped the customer app — three products fighting over
 * one localStorage entry.
 */

export type Theme = 'light' | 'dark';

const KEY = 'foodcourt-admin-theme';

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

let current: Theme = read() ?? 'light';

function paint(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
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
      // Private browsing. The choice applies now and does not persist.
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
