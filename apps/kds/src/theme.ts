/**
 * The kitchen board's theme, defaulting DARK.
 *
 * Deliberately a copy of the customer app's `lib/theme.ts` rather than a shared
 * package. The two apps are separate Vite builds with no shared workspace
 * module, and eighty lines duplicated is cheaper than a package boundary for
 * one file. The one line that differs is the default passed to `initTheme`.
 *
 * The storage key differs too, which matters more than it looks: on a laptop
 * running both apps on localhost they share an origin, so a single key would
 * mean a cook flipping the board to light also flipped the customer app.
 */

export type Theme = 'light' | 'dark';

const KEY = 'foodcourt-kds-theme';

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

let current: Theme = read() ?? 'dark';

function paint(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
}

/** Call once, before React mounts, so there is no flash of the wrong theme. */
export function initTheme(fallback: Theme = 'dark'): void {
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
      // Choice does not persist. It still applies for this shift.
    }
    paint(t);
    for (const l of listeners) l();
  },

  toggle(): void {
    theme.set(current === 'dark' ? 'light' : 'dark');
  },

  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
