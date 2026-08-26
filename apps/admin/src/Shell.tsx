import { useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';

import { auth } from './api';
import { theme } from './theme';
import { ThemeToggle } from './ui';

/**
 * The console shell — sidebar, brand, sign out.
 *
 * THE NAVIGATION LISTS WHAT EXISTS, AND NAMES WHAT DOES NOT
 *
 * The obvious admin sidebar is Dashboard / Orders / Analytics / Settings, and
 * building it would take ten minutes and produce four destinations that either
 * 404 or show an empty state pretending to be a feature.
 *
 * So the top group is what is built and works. The bottom group is what is
 * specified and is not, rendered plainly as text — not as disabled links, which
 * invite clicking and then feel broken. It costs a few lines and means nobody
 * has to open four pages to discover the console does two things well.
 *
 * When one of them lands it moves up a group. The list going down as the
 * product goes up is the point.
 */

const BUILT = [
  { to: '/courts', label: 'Food courts', icon: 'store' },
  { to: '/orders', label: 'Live orders', icon: 'pulse' },
  { to: '/offers', label: 'Offer carousel', icon: 'megaphone' },
] as const;

/**
 * Specified in PRD §13, not built. Listed, not linked.
 *
 * Each says what it would DO rather than its module name, because "Live order
 * monitoring" tells somebody nothing about whether they need it and "watch and
 * unstick orders across a court" does.
 */
const NOT_BUILT = [
  ['Payments and refunds', 'Per-order payment state, manager force-refund'],
  ['Settlements', 'What each vendor is owed and was paid'],
  ['Audit log', 'Read-only. Append-only in the database'],
] as const;

function Icon({ name }: { name: string }) {
  if (name === 'store') {
    return (
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
        <path
          d="M4 10h16M6 10V7a2 2 0 012-2h8a2 2 0 012 2v3M7 10v9M17 10v9M5 19h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (name === 'megaphone') {
    return (
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
        <path
          d="M4 10v4a1 1 0 001 1h3l5 4V5L8 9H5a1 1 0 00-1 1zM17 9a4 4 0 010 6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (name === 'pulse') {
    // A heartbeat trace: this section is about things still moving, and the
    // ones that have stopped.
    return (
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
        <path
          d="M3 12h4l2.5-6 4 12L16 12h5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return null;
}

export function Shell({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  const { pathname } = useLocation();

  /**
   * A stall page belongs to Food courts.
   *
   * `NavLink`'s own `end`/prefix matching cannot know that `/stalls/:id` is a
   * child of the courts section — they are sibling routes, because a stall is
   * reachable without naming its court. Deciding it here keeps the nav honest
   * on the one screen where the URL and the hierarchy disagree.
   */
  const inCourts = pathname.startsWith('/courts') || pathname.startsWith('/stalls');

  return (
    <div className="min-h-dvh flex">
      {/* ========================================================= sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-ink-200 bg-surface">
        <div className="px-5 pt-6 pb-5">
          <p className="display text-[24px] text-ink-900 leading-none">Foodie</p>
          <p className="eyebrow text-[9px] text-ink-500 mt-1.5">Platform console</p>
        </div>

        <nav className="px-3 flex-1">
          {BUILT.map((item) => {
            /**
             * ACTIVE IS PER-ITEM, which it was not.
             *
             * The old version applied `inCourts` to every entry in `BUILT`.
             * That was invisibly correct while there was one entry and wrong
             * the instant there were two: on `/orders` the Food courts link
             * would have rendered unlit and Live orders lit — by coincidence,
             * since both were reading the same boolean. The very next item
             * added would have lit both at once.
             *
             * `NavLink`'s own `isActive` is not enough on its own, which is why
             * `inCourts` exists at all: `/stalls/:id` is a child of Food courts
             * in the hierarchy and a sibling in the router.
             */
            const active = item.to === '/courts' ? inCourts : pathname.startsWith(item.to);

            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`pressable glass-hover flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold ${
                  active
                    ? 'bg-ink-900 text-page'
                    : 'text-ink-700 hover:text-ink-900'
                }`}
              >
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            );
          })}

          <p className="eyebrow text-[9px] text-ink-500 px-3 mt-8 mb-2">Not built yet</p>
          <ul className="px-3 space-y-3">
            {NOT_BUILT.map(([label, what]) => (
              <li key={label}>
                <span className="block text-[12px] font-semibold text-ink-400">{label}</span>
                <span className="block text-[11px] text-ink-400/80 leading-snug mt-0.5">
                  {what}
                </span>
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-3 border-t border-ink-200 flex items-center gap-1">
          <ThemeToggle />
          <button
            onClick={() => auth.clear('MANUAL')}
            className="pressable glass-hover flex-1 rounded-xl px-3 py-2 text-[12px] font-semibold text-ink-500
                        hover:text-ink-900 text-left"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* ====================================================== main column */}
      <div className="min-w-0 flex-1 flex flex-col">
        {/* The sidebar collapses below `md`, so the actions it holds need a
            home. A top bar that only exists on narrow screens rather than a
            drawer: two destinations do not justify a hamburger. */}
        <header className="md:hidden sticky top-0 z-20 bg-surface border-b border-ink-200 px-5 h-14 flex items-center gap-3">
          <p className="display text-[18px] text-ink-900 flex-1">Foodie</p>
          <ThemeToggle />
          <button
            onClick={() => auth.clear('MANUAL')}
            className="pressable glass-hover rounded-lg px-3 py-2 text-[12px] font-semibold text-ink-500"
          >
            Sign out
          </button>
        </header>

        <main className="flex-1 px-5 md:px-8 py-6 md:py-8" data-theme-mode={mode}>
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
