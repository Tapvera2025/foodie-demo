import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import { ErrorState, Spinner, ThemeToggle } from './ui';

interface DevCourt {
  name: string;
  city: string;
  /** Null when the court has no QR yet — it exists and cannot be entered. */
  token: string | null;
}

/**
 * DEVELOPMENT ONLY — the "pretend I scanned" screen.
 *
 * In production a customer arrives at /t/:token because their camera opened
 * that URL from a poster in the venue. There is no list of courts to browse,
 * and there must not be: the token is the only thing establishing that they
 * are actually standing in the place they are ordering from.
 *
 * The endpoint behind it returns 404 when NODE_ENV is production.
 *
 * ============================================================================
 * WHY THIS SCREEN GOT THE REDESIGN TOO, DESPITE NOT SHIPPING
 * ============================================================================
 *
 * It was skipped on the grounds that it is scaffolding. That reasoning is
 * wrong, and the way it went wrong is worth recording: this is the FIRST SCREEN
 * anybody sees when they open the customer app on a laptop, every single time.
 * Menu, Checkout and Track were rebuilt and none of them is reachable without
 * passing through here.
 *
 * So the app was redesigned and looked exactly as it always had, because the
 * only door into it was the one door nobody rebuilt. "It's just a dev screen"
 * is true and completely beside the point — it is the screen the design is
 * judged by.
 *
 * It is still marked as scaffolding, just deliberately rather than by neglect:
 * the dashed warn note stays, and the eyebrow says DEVELOPMENT before anything
 * else does.
 */
export function DevEntry() {
  const q = useQuery({
    queryKey: ['dev-courts'],
    queryFn: async (): Promise<{ courts: DevCourt[] }> => {
      const res = await fetch('/api/v1/dev/courts');
      if (!res.ok) throw new Error('Dev court list unavailable');
      return res.json() as Promise<{ courts: DevCourt[] }>;
    },
  });

  const courts = q.data?.courts ?? [];
  const reachable = courts.filter((c) => c.token !== null);

  return (
    /*
      Not `Screen`, which would put a nav app-bar across the top. This is a
      front door, not a step in a journey — the same shape the console and the
      kitchen board open with: wordmark, eyebrow, then the content.
    */
    <div className="flex-1 flex flex-col bg-page px-4 md:px-6 py-8 md:py-12">
      <div className="w-full">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div className="min-w-0">
            <p className="display text-[38px] md:text-[46px] text-ink-900 leading-none">Foodie</p>
            {/*
              DEVELOPMENT, not "Customer app". The eyebrow is the first thing
              read and it is the only place this screen can say what it is
              before somebody starts treating it as the product.
            */}
            <p className="eyebrow text-[10px] text-ink-500 mt-2.5">
              Development · stands in for scanning
            </p>
          </div>
          <ThemeToggle />
        </div>

        <h1 className="text-[15px] font-bold text-ink-900">Pick a food court</h1>
        <p className="text-[13px] text-ink-500 mt-1 mb-5 leading-relaxed">
          {q.isLoading
            ? 'Asking the server what is live…'
            : reachable.length === 0
              ? 'None of these can be entered yet.'
              : `${reachable.length} ${
                  reachable.length === 1 ? 'venue is' : 'venues are'
                } reachable. Tapping one is the same as scanning its poster.`}
        </p>

        {q.isLoading ? <Spinner label="Loading courts…" /> : null}

        {q.isError ? (
          <>
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
            <p className="text-[12px] text-ink-500 text-center mt-2 leading-relaxed">
              The API is not answering on port 3000. Run <code className="ident">npm run dev:all</code>,
              or <code className="ident">npm run diagnose:customer</code> to find which link is
              broken.
            </p>
          </>
        ) : null}

        {q.data && courts.length === 0 ? (
          <div className="rounded-card border border-dashed border-ink-200 bg-surface px-6 py-12 text-center">
            <p className="text-[15px] font-bold text-ink-900">Nothing seeded yet</p>
            <p className="text-[13px] text-ink-500 mt-1.5 leading-relaxed">
              Run <code className="ident">npm run seed:dev</code>, then reload.
            </p>
          </div>
        ) : null}

        {courts.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
            {courts.map((c) =>
              /*
                A court with no QR is SHOWN, and shown as unreachable.
                Omitting it was the old behaviour and produced the one bug report
                this screen cannot answer: "I created a court and it is not here."
                Nothing errored, nothing was missing from the console, and the
                cause — no token — was two applications away.
              */
              c.token === null ? (
                <li key={c.name}>
                  <div className="flex h-full items-start gap-3.5 rounded-card border border-dashed border-ink-200 bg-surface p-4">
                    <span
                      aria-hidden
                      className="size-11 shrink-0 grid place-items-center rounded-xl bg-ink-100 text-ink-400"
                    >
                      <svg viewBox="0 0 24 24" className="size-5" fill="none">
                        <path
                          d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15M5 19L19 5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                    <span className="min-w-0">
                      <span className="block font-bold text-[15px] text-ink-500 truncate">
                        {c.name}
                      </span>
                      <span className="block text-[12px] text-ink-400 mt-0.5 leading-snug">
                        No QR yet — issue one in the console to make this reachable.
                      </span>
                    </span>
                  </div>
                </li>
              ) : (
                <li key={c.token}>
                  <Link
                    to={`/t/${c.token}`}
                    /*
                      A QR tile, not a text link.
                      This screen stands in for pointing a camera at a poster, and
                      it looks like it: the mark is the thing you would be
                      scanning. Making the substitute resemble the real action
                      keeps the dev shortcut from quietly becoming the mental
                      model of the product.
                    */
                    /* The hover used to turn the card's border and its icon red, which
                       on a grid of eight courts made the cursor look like it was
                       SELECTING one rather than passing over it. Frost the tile
                       instead and leave the palette alone. */
                    className="pressable glass-hover group flex h-full items-center gap-3.5 rounded-card border
                               border-ink-200 bg-surface shadow-card p-4
                               hover:border-glass-edge"
                  >
                    <span
                      aria-hidden
                      className="size-11 shrink-0 grid place-items-center rounded-xl bg-ink-100
                                 text-ink-500 transition-colors group-hover:bg-glass-press
                                 group-hover:text-ink-900"
                    >
                      <svg viewBox="0 0 24 24" className="size-5" fill="none">
                        <path
                          d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                        <rect
                          x="8.5"
                          y="8.5"
                          width="7"
                          height="7"
                          rx="1"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-[15px] text-ink-900 truncate">
                        {c.name}
                      </span>
                      <span className="block text-[12px] text-ink-500 mt-0.5 truncate">
                        {c.city}
                      </span>
                    </span>

                    <svg
                      viewBox="0 0 24 24"
                      className="size-4 shrink-0 text-ink-400 transition-colors group-hover:text-ink-700"
                      fill="none"
                      aria-hidden
                    >
                      <path
                        d="M9 5l7 7-7 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                </li>
              ),
            )}
          </ul>
        ) : null}

        {/* Dashed and warn-tinted, like every other piece of scaffolding in the
            app, so "this is not the product" is a consistent visual signal
            rather than a sentence you have to read. `mt-auto` pins it to the
            bottom of a tall window instead of leaving it floating halfway up
            an empty page. */}
        <p
          className="text-[12px] text-warn-700 leading-relaxed mt-10 rounded-xl border border-dashed
                     border-warn-500 bg-warn-50 px-4 py-3"
        >
          This screen does not exist in production. A customer only ever reaches a court by scanning
          the code displayed there — the token is what shows they are on the premises.
        </p>
      </div>
    </div>
  );
}
