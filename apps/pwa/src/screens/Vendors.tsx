import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import { api, useIsSignedIn } from '../lib/api';
import { useAutoAdvance } from '../lib/autoAdvance';
import { useCart } from '../lib/cart';
import { useOrderNotifications } from '../lib/notify';
import { CATALOG_CHANGED, useFallbackInterval, ORDER_CHANGED, useRealtime } from '../lib/realtime';
import {
  CategoryRail,
  CollapsibleSearch,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LiveOrders,
  OfferCarousel,
  Screen,
  StallCard,
  StallSkeleton,
  ThemeToggle,
  TrendingCard,
} from './ui';

/**
 * Every stall in the venue, on one screen.
 *
 * This is the screen the whole product exists to make possible: the customer
 * compares six kitchens while seated, instead of reading a board from the back
 * of a queue. So density matters more than beauty — six cards visible without
 * scrolling beats four that look nicer.
 *
 * WHAT IS DELIBERATELY NOT HERE: RATINGS
 *
 * A star rating is the most prominent element on a Zomato card, and there is no
 * rating anywhere in this system. Showing "★ 4.2" would be inventing data about
 * a real business — a stall could be marked down by a number nobody gave it.
 * The space goes to facts we actually hold: whether the stall is open, and how
 * long it says it takes. Ratings can be added when there is something to
 * average.
 */
export function Vendors() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const navigate = useNavigate();
  const { foodCourtId, foodCourtName, vendorId, vendorName, lines, sessionId } = useCart();
  const setVendor = useCart((s) => s.setVendor);

  /** Verified, as something React watches. Gates every customer-token query. */
  const signedIn = useIsSignedIn();

  /** The stall being switched TO, while we ask about the basket it would empty. */
  const [switching, setSwitching] = useState<{ id: string; name: string } | null>(null);
  /*
   * The trending rail advances itself. Every way it can annoy somebody — a
   * finger on it, a cursor over it, focus inside it, the tab in the background,
   * the rail scrolled off screen, or the customer having asked their OS for
   * reduced motion — stops it. See `useAutoAdvance`; the reasoning against
   * auto-advance that `OfferCarousel` documents is answered there rather than
   * ignored.
   *
   * It is also inert from `sm` up with no breakpoint written here, because the
   * hook advances only a container that actually overflows and the same element
   * is a CSS grid at that width.
   */
  const trendingRail = useRef<HTMLDivElement>(null);
  useAutoAdvance(trendingRail);

  const [query, setQuery] = useState('');

  /** The chosen category chip, or null for All. Filters the stall list. */
  const [category, setCategory] = useState<string | null>(null);

  /**
   * The veg-only switch, in the header beside the search box.
   *
   * A stall matches when ANY of its cuisine tags reads vegetarian. That is a
   * coarse filter and it is the honest limit of what the stall list knows —
   * the menu screen has the real per-dish `VegMark`, which is FSSAI-mandated
   * and per-item. Filtering stalls out entirely on a tag would hide a stall
   * with a full veg section because somebody tagged it "North Indian", so this
   * filters only where the tag is explicit.
   */
  const [vegOnly, setVegOnly] = useState(false);

  /**
   * The term actually sent to the server, trailing the box by 250ms.
   *
   * Without this every keystroke is a request: "momo" is four, three of which
   * are already stale before they return, and on a food-court 4G connection the
   * results visibly flicker backwards as slower earlier ones land. 250ms is
   * below the threshold where typing feels laggy and above the gap between
   * keystrokes for anyone who is not deliberately testing it.
   */
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length >= 2;

  const found = useQuery({
    queryKey: ['court-search', foodCourtId, debounced],
    queryFn: () => api.searchCourt(foodCourtId!, debounced),
    enabled: Boolean(foodCourtId) && searching,
    // A search result is not live state the way an order is. Holding it briefly
    // makes backspacing through a term instant instead of re-fetching every
    // prefix on the way out.
    staleTime: 30_000,
  });

  /**
   * Orders already in flight, polled while the customer browses.
   *
   * Four seconds, same as the tracking screen — the point is that a customer
   * choosing their second stall still sees the first order turn READY without
   * having to go looking for it.
   */
  const mine = useQuery({
    queryKey: ['session-orders', sessionId],
    queryFn: () => api.sessionOrders(sessionId!),
    /*
      Gated on the CUSTOMER TOKEN, not on the session.

      A session exists from the moment somebody scans a poster; the token
      exists only after they verify a number. Gating on `sessionId` alone meant
      every browsing visitor polled their own orders every four seconds and got
      a 401 every time — hundreds of identical auth failures in the API log,
      from a client asking a question it had no right to ask.

      Nobody unverified has orders, so there is nothing to miss.
    */
    enabled: Boolean(sessionId) && signedIn,
    /*
      4s -> FALLBACK_MS. This list is now driven by `order.changed`, which the
      server publishes inside the transaction that moved the order — so it
      updates on the change rather than up to four seconds after it, and an
      idle screen stops asking a question whose answer almost never differs.

      What is left is insurance against a socket that died quietly. See
      `lib/realtime.ts`.
    */
    refetchInterval: fallbackMs,
  });

  // Every state change on any of this customer's orders becomes a popup,
  // wherever they happen to be in the app.
  useOrderNotifications(mine.data?.orders, (id) => navigate(`/order/${id}`));

  const q = useQuery({
    queryKey: ['vendors', foodCourtId],
    queryFn: () => api.vendors(foodCourtId!),
    enabled: Boolean(foodCourtId),
  });

  /*
   * Two events, two different lists, and they are genuinely independent.
   *
   * `order.changed` moves the customer's own orders — the strip of live orders
   * at the top of this screen. `catalog.changed` moves the STALLS: one closes,
   * one runs out of its last dish, one comes back. A customer standing in a
   * court looking at a list of stalls should not be offered one that shut two
   * minutes ago, and this screen previously learned that only because
   * `session-orders` happened to be polling next to it.
   */
  useRealtime(ORDER_CHANGED, [['session-orders']], Boolean(sessionId) && signedIn);
  useRealtime(CATALOG_CHANGED, [['vendors', foodCourtId]], Boolean(foodCourtId));

  const vendors = q.data?.vendors ?? [];

  /*
   * DECLARED HERE BECAUSE THE FILTER BELOW READS IT.
   *
   * `const` is not hoisted. This sat further down beside `offers`, which read
   * fine and would have thrown a ReferenceError on first render the moment the
   * category filter started using it — `useMemo` runs its callback during the
   * call, not later, so the temporal dead zone is live at that line.
   */
  const categories = q.data?.categories ?? [];

  /**
   * Open stalls first, then closed ones — never interleaved.
   *
   * A closed stall between two open ones is a card the customer reads, wants,
   * and cannot have. Sorting them below turns a repeated small
   * disappointment into one clear boundary.
   */
  const sorted = useMemo(() => {
    /**
     * WHEN SEARCHING, THE SERVER'S ORDER IS THE ANSWER — DO NOT RE-SORT IT.
     *
     * The results come back ranked by trigram similarity, open stalls first.
     * Re-sorting alphabetically here would throw away the relevance that the
     * whole search exists to produce and put "Aggarwal Sweets" above the stall
     * whose dish is literally called Momo.
     */
    if (searching) return found.data?.vendors ?? [];

    /*
     * THE CHIP CARRIES ITS OWN ANSWER.
     *
     * This matched `category` against `v.cuisine` and could not have worked for
     * half the chips. The row is built from two sources — how a stall describes
     * itself ("North Indian") and what its menu sections are called ("Bread") —
     * and only the first is a cuisine tag. Tapping Bread compared "bread"
     * against ["North Indian", "Mughlai"], matched nothing, and reported an
     * empty court to somebody standing in front of a stall selling naan.
     *
     * `vendorIds` comes from the join that built the chip, so membership is
     * exact rather than a substring guess, and the two can no longer disagree.
     * A missing entry means the chip is stale — one render behind a refetch —
     * and an empty set filters to nothing, which is the honest answer for a
     * chip that genuinely selects no stall.
     */
    const picked = category
      ? new Set(categories.find((c) => c.label === category)?.vendorIds ?? [])
      : null;

    return [...vendors]
      .filter((v) => {
        if (picked && !picked.has(v.id)) return false;
        if (vegOnly && !v.cuisine.some((c) => /veg|jain|vegetarian/i.test(c))) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.accepting !== b.accepting) return a.accepting ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [vendors, searching, found.data, category, categories, vegOnly]);

  const openCount = sorted.filter((v) => v.accepting).length;

  /**
   * The trending stalls, resolved from ids to the stalls themselves.
   *
   * The server sends `{ vendorId, badge }` rather than duplicating the whole
   * stall, so a stall cannot appear in the two sections with two different
   * prep times or two different open states. `flatMap` drops any id the list
   * does not contain, which cannot happen from one response but would if these
   * ever came from separate requests.
   */
  const offers = q.data?.offers ?? [];

  const trending = useMemo(() => {
    const byId = new Map(vendors.map((v) => [v.id, v]));
    return (q.data?.trending ?? []).flatMap((t) => {
      const vendor = byId.get(t.vendorId);
      return vendor ? [{ ...t, vendor }] : [];
    });
  }, [q.data, vendors]);

  if (!foodCourtId) {
    return (
      <Screen title="Scan to start">
        <EmptyState
          title="Nothing scanned yet"
          body="Scan the QR code on a poster or stall front to see what is open here."
        />
      </Screen>
    );
  }

  const open = (id: string, name: string): void => {
    setVendor(id, name);
    navigate(`/vendor/${id}`);
  };

  const choose = (id: string, name: string): void => {
    // Switching stalls empties the basket, so say so first. Silently discarding
    // someone's choices is the kind of thing that loses an order.
    if (vendorId && vendorId !== id && lines.length > 0) {
      setSwitching({ id, name });
      return;
    }
    open(id, name);
  };

  return (
    <Screen
      /* `full`: this is a SET, and seeing more of it at once is the whole
         product. A stall list is the one screen where a wide window should
         mean more stalls, not more margin. */
      width="full"
      title={foodCourtName ?? 'Food court'}
      subtitle={
        q.isLoading
          ? 'Finding stalls…'
          : `${openCount} of ${vendors.length} ${vendors.length === 1 ? 'stall' : 'stalls'} open now`
      }
      right={
        /*
          VEG, THEME, PROFILE — in that order, on one line with the title.

          Veg moved UP here from the row below. On a phone that row now holds
          the search field at full width, and a toggle sharing it would either
          squeeze the field or wrap — which is what "the mobile UI looks broken"
          was: a collapsed search chip and a veg switch huddled at the right of
          an otherwise empty row.

          It is a filter that is either on or off for the whole screen, which is
          the same kind of thing as the theme switch beside it, so it belongs in
          the same cluster.
        */
        <div className="flex items-center gap-1">
          {vendors.length > 0 ? (
            /*
              ================================================================
              VEG ONLY
              ================================================================

              A WORD AND A SWITCH, and the word never drops.

              The bug was never the switch — it was the switch ALONE. The label
              was hidden below 380px, which left a bare grey toggle in the bar
              saying "something here is on or off" without saying what. A
              control whose meaning lives entirely in a word is a control that
              breaks the moment the word is dropped for space.

              So the switch stays, smaller, and the label is now unconditional.

              NO FSSAI MARK HERE, deliberately. That mark is a per-DISH legal
              requirement with a fixed colour, and this filter matches a stall's
              cuisine tags — putting the mandated mark on a coarse stall-level
              guess would lend it an authority it has not got. The word carries
              the meaning; `VegMark` on a menu row carries the claim.

              The filter itself is coarse by necessity: it matches a stall's own
              cuisine TAGS, the only dietary signal the stall list holds. The
              per-dish `VegMark` on a menu is the real one, per item, and this
              does not pretend to be it. A stall is hidden only when its tags say
              vegetarian explicitly, never inferred.
            */
            <button
              onClick={() => setVegOnly((x) => !x)}
              aria-pressed={vegOnly}
              className={`pressable glass-hover shrink-0 h-9 flex items-center gap-1.5 rounded-full
                          px-2 border ${
                            vegOnly
                              ? 'bg-veg-fill border-veg-fill text-white'
                              : 'bg-ink-50 border-ink-200 text-ink-700'
                          }`}
            >
              {/*
                THE LABEL IS NOT OPTIONAL AND NEVER DROPS.

                It used to disappear below 380px, which left a bare grey switch
                in the bar — a control whose entire meaning lived in a word that
                was no longer on screen. `VEG` at 10px is twenty pixels; there is
                no width at which dropping it is the right trade, because the
                thing it is competing with for space is a court name the customer
                already knows.
              */}
              <span className="eyebrow text-[10px] leading-none">Veg</span>

              {/*
                A REAL SWITCH, kept small. 24×14 with a 10px knob rather than the
                28×16 it was: a toggle beside two 44px icon buttons does not need
                to match them, it needs to read as a switch, and it does that at
                any size the knob is still round.
              */}
              <span
                aria-hidden
                className={`h-3.5 w-6 rounded-full p-0.5 shrink-0 transition-colors ${
                  vegOnly ? 'bg-white/35' : 'bg-ink-200'
                }`}
              >
                <span
                  className={`block size-2.5 rounded-full bg-surface transition-transform ${
                    vegOnly ? 'translate-x-2.5' : ''
                  }`}
                />
              </span>
            </button>
          ) : null}

          {/* The theme switch lives here, on the stall list, because this is the
              screen a customer lands on after scanning and the one they will be
              on when they notice the screen is hard to read. Putting it behind a
              profile page would mean finding it after the moment it was needed. */}
          <ThemeToggle />

          {/* The only persistent way into the customer's own orders. Every screen
             before this was a one-way street: place an order, and the only route
             back to it was a link you had already navigated past. */}
          <button
            onClick={() => navigate('/orders')}
            aria-label="Your orders"
            className="pressable glass-hover size-11 grid place-items-center rounded-full relative"
          >
            <svg viewBox="0 0 24 24" className="size-6 text-ink-700" fill="none" aria-hidden>
              <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M4.5 20a7.5 7.5 0 0115 0"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            {/* A dot, not a count. The count is already on the strip below; a
                second number to reconcile is a second thing that can be wrong. */}
            {(mine.data?.orders.length ?? 0) > 0 ? (
              <span className="absolute top-2 right-2 size-2.5 rounded-full bg-brand-500 ring-2 ring-surface" />
            ) : null}
          </button>
        </div>
      }
      /*
        SEARCH LIVES IN THE BAR, not at the top of the body.

        It was the first thing on the page, which pushed the actual content —
        categories, offers, stalls — a hundred pixels down and made the top of
        the screen two bands of chrome stacked on each other. A control that
        filters everything below it is navigation, not content.

        On a phone it is a full-width field on its own row under the title, the
        shape every delivery app in India uses. On a wide window it collapses to
        a word and an icon beside the title — see `CollapsibleSearch` for why the
        two differ rather than one shape being made to serve both.
      */
      center={
        vendors.length > 0 ? (
          <CollapsibleSearch
            value={query}
            onChange={setQuery}
            placeholder="Search for momo, biryani, a stall…"
          />
        ) : undefined
      }
    >
      {/*
        One line saying what happened, only while searching.
        A results list with no count leaves "is this everything?" unanswered,
        and the fuzzy match makes that worse — a customer who sees three cards
        after typing "momo" has no way to tell whether the court has three or
        whether the search gave up.
      */}
      {searching ? (
        <p className="text-[13px] text-ink-500 mb-3 px-1" aria-live="polite">
          {found.isLoading
            ? `Searching for “${debounced}”…`
            : found.isError
              ? 'Search is unavailable right now — the list below is every stall.'
              : sorted.length === 0
                ? `Nothing matching “${debounced}” in this court.`
                : `${sorted.length} ${sorted.length === 1 ? 'stall has' : 'stalls have'} something matching “${debounced}”.`}
        </p>
      ) : null}

      <LiveOrders
        orders={mine.data?.orders ?? []}
        onOpen={(id) => navigate(`/order/${id}`)}
      />

      {q.isLoading ? <StallSkeleton /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}

      {/*
        ================================================================
        TRENDING NOW — the two the court is leading with
        ================================================================

        Hidden entirely while searching. Somebody who typed "momo" has told you
        precisely what they want, and putting two unrelated stalls above their
        results is the app talking over them.

        Also hidden below three stalls: "trending" out of two options is not a
        recommendation, it is the whole list with a badge on it.
      */}
      {/*
        ================================================================
        OFFERS — the first thing on the screen, and the most claimed
        ================================================================

        Only stalls the platform granted a slot, that filled it, and that are
        accepting orders right now. The third condition is the one that is easy
        to forget: leading the whole app with a shut stall's offer is an
        advertisement for a disappointment, discovered at the end of a menu.

        Hidden while searching, like Trending. Somebody who typed "momo" has
        said what they want.
      */}
      {!searching && offers.length > 0 ? (
        /*
          ================================================================
          PHONES AND TABLETS ONLY
          ================================================================

          Hidden from `xl` up. The product is used standing in a food court on
          a phone, or on a tablet; the desktop view exists so the thing is not
          broken when somebody opens it on a laptop, and a full-width promotional
          banner is the wrong first impression there — it pushes the stall grid,
          which is what a desktop's height is actually good for, below the fold.

          A WIDTH, NOT `pointer: coarse`. The pointer query is the more precise
          expression of "tablet or phone" and it is the wrong tool here: a
          developer resizing a desktop browser to check the phone layout keeps a
          fine pointer, so the banner would vanish at 390px and read as a bug in
          the one workflow where somebody is looking hard at this component.

          1280px, rather than `lg`. Every common tablet in landscape sits below
          it — the 10.9" iPad is 1180 and the 11" Pro is 1194 — so the cut lands
          between tablets and laptops rather than through the middle of the
          tablets. The 12.9" iPad Pro at 1366 is on the wrong side of it, and
          that is the price of using width at all: at 1366 CSS pixels it is
          indistinguishable from a small laptop.
        */
        <section className="mb-6 xl:hidden" aria-label="Offers">
          <OfferCarousel offers={offers} onOpen={(id, name) => choose(id, name)} />
        </section>
      ) : null}

      {/*
        ================================================================
        CATEGORIES — built from what this court actually sells
        ================================================================
      */}
      {!searching && categories.length > 0 ? (
        <div className="mb-7">
          <CategoryRail categories={categories} active={category} onPick={setCategory} />
        </div>
      ) : null}

      {/* A hairline between sections, as the reference has it. Without one the
          page is four unrelated rows and the eye has nothing to rest against —
          particularly on a desktop where they are all the same width. */}
      {!searching && categories.length > 0 ? (
        <hr className="border-ink-200 mb-7" />
      ) : null}

      {!searching && !category && trending.length > 0 && vendors.length > 2 ? (
        <section className="mb-7" aria-label="Trending now">
          <h2 className="display text-[20px] md:text-[24px] text-ink-900 mb-3">Trending now</h2>
          {/*
            ============================================================
            A CAROUSEL ON A PHONE, A GRID FROM `sm`
            ============================================================

            Stacked full-width cards cost a phone roughly 250px of vertical
            space EACH, so two trending stalls pushed "All stalls" — the thing
            a customer actually came to browse — most of a screen down. A
            court's headline picks should cost one card of height, not one per
            stall.

            One element does both: a flex scroller below `sm`, `display: grid`
            from `sm` up, where two cards fit side by side and there is nothing
            to scroll. The children carry a width only while it is a scroller
            (`sm:w-auto` hands sizing back to the grid) and `shrink-0` is inert
            in grid, so no wrapper is duplicated per breakpoint.

            `w-[86%]` IS THE POINT, NOT A ROUNDING.

            A card that fills the width looks like a stacked card that happens
            to scroll — nothing on screen says there is a second one, so nobody
            swipes. Leaving ~14% of the next card visible is the only affordance
            a touch carousel gets; the peek IS the scrollbar.

            `scroll-px-4` MUST TRACK `px-4`. A `snap-start` child aligns against
            the SNAPPORT — the padding box reduced by `scroll-padding`, which
            defaults to zero — so without it the browser scrolls the track 16px
            to seat the first card flush and parks the left padding off-screen.
            The card then hugs the edge of the phone while the heading above it
            begins 16px in. `tests/design/tokens.mjs` fails the build on this
            exact omission, which is why it is spelled out at both breakpoints.
          */}
          <div
            ref={trendingRail}
            role="region"
            aria-label="Trending stalls"
            className="flex gap-3 overflow-x-auto no-scrollbar snap-x snap-mandatory scroll-smooth
                       -mx-4 px-4 scroll-px-4
                       sm:grid sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:mx-0 sm:px-0 sm:scroll-px-0"
          >
            {trending.map((t) => (
              <div key={t.vendorId} className="snap-start shrink-0 w-[86%] sm:w-auto">
                <TrendingCard
                  vendor={t.vendor}
                  badge={t.badge}
                  onOpen={() => choose(t.vendor.id, t.vendor.name)}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/*
        ================================================================
        ALL STALLS — compact rows, not a second wall of photographs
        ================================================================

        Two columns from `sm` and three from `lg`. A row is short enough that a
        wide window fits nine of them without scrolling, which is the whole
        argument for a food court you can survey rather than scroll.
      */}
      {sorted.length > 0 ? (
        <section aria-label={searching ? 'Search results' : 'All stalls'}>
          {!searching ? (
            <h2 className="display text-[20px] md:text-[24px] text-ink-900 mb-3">All stalls</h2>
          ) : null}

          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 items-start">
            {sorted.map((v, i) => {
              const firstClosed = v.accepting === false && sorted[i - 1]?.accepting === true;

              return (
                <Fragment key={v.id}>
                  {/*
                    The divider is its own grid child spanning every column, so
                    the boundary between open and closed stays a boundary rather
                    than becoming a caption on one card in the middle of a row.

                    Its own `<li>` rather than `display: contents` on the card's:
                    `contents` on a list item drops it out of the list semantics
                    in several browsers, and a screen reader announcing "list, 2
                    items" for a list of six stalls is a worse bug than the
                    layout one it would be solving.
                  */}
                  {firstClosed ? (
                    <li
                      aria-hidden
                      className="col-span-full text-[13px] font-semibold text-ink-500 pt-3 pb-1 px-1"
                    >
                      Closed right now
                    </li>
                  ) : null}

                  <li>
                    {/*
                      THE BIG PHOTO CARD, EVERYWHERE.

                      This was a compact row when not searching, from an earlier
                      reference that showed "All stalls" as a dense list. The
                      Swiggy layout is unambiguous that it should not be: the
                      photograph IS the card, and a 56px thumbnail beside two
                      lines of text is a contacts list that happens to be about
                      food.

                      A food court has a handful of stalls, not two hundred
                      restaurants, so the density a row buys is density nobody
                      needed — and it cost the one thing that makes somebody
                      want to eat.
                    */}
                    <StallCard vendor={v} onOpen={() => choose(v.id, v.name)} />
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </section>
      ) : null}

      {q.data && sorted.length === 0 ? (
        query ? (
          <EmptyState title="No stalls match that" body="Try a different name or cuisine." />
        ) : (
          <EmptyState
            title="Nothing is open"
            body="No stall in this court is taking orders right now."
          />
        )
      ) : null}

      {/*
        The basket-emptying question, which used to be a `window.confirm`.
        It names BOTH stalls and the number of items, which the native dialog
        could not — its text was written once, at build time, and the same
        sentence appeared whether the basket held one samosa or nine.
      */}
      {switching ? (
        <ConfirmDialog
          title={`Start again at ${switching.name}?`}
          body={`Your basket has ${lines.length} ${
            lines.length === 1 ? 'item' : 'items'
          } from ${vendorName ?? 'another stall'}. Each order goes to one kitchen, so opening ${
            switching.name
          } empties it.`}
          cancelLabel={`Stay at ${vendorName ?? 'this stall'}`}
          confirmLabel="Empty it and switch"
          onCancel={() => setSwitching(null)}
          onConfirm={() => {
            open(switching.id, switching.name);
            setSwitching(null);
          }}
        />
      ) : null}
    </Screen>
  );
}
