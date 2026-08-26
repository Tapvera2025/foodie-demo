import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import { api, isAuthenticated, useIsSignedIn, type MenuItem } from '../lib/api';
import { formatINR } from '../lib/money';
import { useCart, useCartCount } from '../lib/cart';
import { useOrderNotifications } from '../lib/notify';
import { CATALOG_CHANGED, useFallbackInterval, ORDER_CHANGED, useRealtime } from '../lib/realtime';
import { useWatchItem } from '../lib/stock-watch';
import {
  AddControl,
  DishSheet,
  EmptyState,
  ErrorState,
  FoodTile,
  LiveOrders,
  MenuSkeleton,
  VegMark,
} from './ui';

/**
 * The stall menu.
 *
 * WHAT THIS BORROWS FROM THE DELIVERY APPS, AND WHAT IT REFUSES
 *
 * The structure is theirs and it is good: a photograph you see before you read
 * anything, the stall's identity on a card that overlaps it, category pills,
 * then rows where the price and the dietary mark are findable without reading.
 * People have been trained on that shape by every food app in India and there
 * is nothing to gain by being different.
 *
 * What is deliberately absent is everything that shape carries for a DELIVERY
 * product, because none of it is true here:
 *
 *   ★ 4.6 (2.5k+)   there is no rating data. Rendering a number would be
 *                   inventing a claim about a real business.
 *   15–20 min       that is a delivery estimate. The stall's own prep time is
 *                   shown instead — how long until you collect.
 *   2.1 km away     the customer is in the building. Distance is zero and
 *                   saying so is noise.
 *   ₹600 for two    nobody quoted that. The median dish price is shown as a
 *                   typical spend, labelled as the estimate it is.
 *   50% OFF         there is no discount model. A struck-through price with no
 *                   promotion behind it is the oldest trick in retail.
 *
 * BESTSELLER USED TO BE ON THAT LIST and has earned its way off it. The server
 * now badges the top three dishes by units actually sold in the last seven
 * days, rejected lines excluded — see `menu()` in discovery.controller.ts. The
 * test is not whether a badge looks good; it is whether anybody computed it.
 */
/**
 * What the chips above the menu do.
 *
 * Two of these SORT and two FILTER, and the difference is visible in the
 * behaviour rather than explained in copy: sorting flattens the menu into one
 * ranked list, filtering keeps the stall's own sections.
 *
 * That is not a stylistic choice. "Cheapest first" is a claim about the whole
 * menu — sorting inside sections would rank a ₹40 dessert below a ₹300 main
 * and answer nobody's question. A filter has no such problem: the sections
 * that survive it are still the stall's sections.
 */
type ViewMode = 'default' | 'price-asc' | 'price-desc' | 'bestsellers' | 'must-try';

const SORTS: ReadonlySet<ViewMode> = new Set(['price-asc', 'price-desc']);

const VIEW_CHIPS: readonly { mode: ViewMode; label: string }[] = [
  { mode: 'price-asc', label: 'Price: low to high' },
  { mode: 'price-desc', label: 'Price: high to low' },
  /*
   * TWO CHIPS, NOT ONE, and they are not synonyms.
   *
   * `bestseller` is computed from units actually sold in the last seven days
   * and nobody can edit it. `mustTry` is the stall's own recommendation, capped
   * at three. Merging them into one "Popular" chip would quietly make the
   * measured one unfalsifiable — see the note on the bestseller query in
   * discovery.controller.ts, which is the reason that badge was computed rather
   * than typed in.
   */
  { mode: 'bestsellers', label: 'Bestsellers' },
  { mode: 'must-try', label: 'Must try' },
];

export function Menu() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const { vendorId } = useParams<{ vendorId: string }>();
  const navigate = useNavigate();
  const { lines, sessionId } = useCart();
  const add = useCart((s) => s.add);
  const setQuantity = useCart((s) => s.setQuantity);
  const count = useCartCount();
  const signedIn = useIsSignedIn();

  const [vegOnly, setVegOnly] = useState(false);

  /**
   * ==========================================================================
   * ONE CONTROL, NOT TWO — SORTING AND FILTERING SHARE A SLOT
   * ==========================================================================
   *
   * "Price: low to high" reorders the menu. "Bestsellers" removes most of it.
   * They are different operations and it would be defensible to give them
   * separate rows — but on a phone that is two strips of chips above the food,
   * and the customer has to understand the difference before they can use
   * either.
   *
   * One exclusive choice instead. Picking any chip replaces the last, so there
   * is only ever one thing going on and one thing to undo. The veg switch stays
   * separate because it is a dietary requirement rather than a preference —
   * somebody who cannot eat meat needs it to survive every other choice they
   * make.
   */
  const [view, setView] = useState<ViewMode>('default');

  /**
   * The dish whose sheet is open, or null.
   *
   * THE ITEM, NOT ITS ID. Holding an id would mean looking the dish back up out
   * of `q.data` on every render, and that lookup returns `undefined` for the
   * one frame after a refetch drops or renames an item — which unmounts the
   * sheet under somebody's thumb. The object is a snapshot of what they tapped,
   * which is what a modal should show.
   *
   * The quantity is NOT snapshotted: it comes from the cart store below, so the
   * stepper inside the sheet stays live while it is open.
   */
  const [openDish, setOpenDish] = useState<MenuItem | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  /**
   * Which sections are SHUT, not which are open.
   *
   * Storing the closed ones means the default — an empty object — is everything
   * expanded, so a stall that adds a category tomorrow has it visible rather
   * than hidden behind a key nobody has written yet. The inverse shape has the
   * opposite default and the bug is invisible: a new section that silently
   * never appears.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);

  const q = useQuery({
    queryKey: ['menu', vendorId],
    queryFn: () => api.menu(vendorId!),
    enabled: Boolean(vendorId),
  });

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

  useOrderNotifications(mine.data?.orders, (id) => navigate(`/order/${id}`));

  /*
   * `catalog.changed` matters more on this screen than anywhere else in the
   * app: it is the one place a customer is choosing, and a dish that sold out
   * thirty seconds ago is a dish they are about to add to a basket and be
   * refused at checkout. The kitchen marking it sold out now reaches this
   * screen on the same transaction that recorded it.
   */
  useRealtime(CATALOG_CHANGED, [['menu', vendorId]], Boolean(vendorId));
  useRealtime(ORDER_CHANGED, [['session-orders']], Boolean(sessionId) && signedIn);

  const qtyOf = (id: string): number => lines.find((l) => l.menuItemId === id)?.quantity ?? 0;

  /**
   * The one authentication prompt in the journey. DR-0001.
   *
   * The item goes into the cart FIRST and the navigation happens second. That
   * ordering is the whole promise of "the cart must survive authentication":
   * tap ADD on a ₹150 roll, verify, and land back on a menu that already has it.
   */
  const addToCart = (item: MenuItem): void => {
    add({
      id: item.id,
      name: item.name,
      pricePaise: item.pricePaise,
      // Carried into the basket so CHECKOUT can show it. That screen has no
      // menu to look it up from — see `DraftLine`.
      imageUrl: item.imageUrl,
    });
    if (!isAuthenticated()) navigate('/verify');
  };

  const isVeg = (item: MenuItem): boolean => {
    const f = item.dietaryFlags.map((x) => x.toUpperCase());
    return (f.includes('VEG') || f.includes('JAIN')) && !f.includes('NON_VEG') && !f.includes('EGG');
  };

  /**
   * Search WITHIN this stall's menu.
   *
   * Client-side, unlike the court search, and that is not a shortcut. The whole
   * menu is already in memory — it arrived in one request and this screen is
   * rendering it — so a round trip per keystroke would be slower, would spend a
   * customer's data on something they already have, and would stop working the
   * moment the connection drops in a basement food court.
   *
   * The court search has to be server-side for the opposite reason: the client
   * has never seen another stall's menu, so "who sells momos" is a question it
   * simply cannot answer locally.
   *
   * Matching is a plain substring, deliberately, where the court search is
   * trigram-fuzzy. Somebody scanning one stall's menu is looking at a list they
   * can see; a fuzzy match here would return dishes that do not contain what
   * they typed, next to the evidence that it did not match, which reads as
   * broken. Across a whole court, where the alternative is missing a stall
   * entirely, the trade goes the other way.
   */
  const [dishQuery, setDishQuery] = useState('');

  const categories = useMemo(() => {
    const raw = q.data?.categories ?? [];
    const term = dishQuery.trim().toLowerCase();

    const matches = (i: { name: string; description: string | null }): boolean =>
      term === '' ||
      i.name.toLowerCase().includes(term) ||
      // Descriptions count HERE and not in the court search. Within one menu a
      // customer may be hunting "with cheese" or "paneer", which lives in the
      // description; across a court that would rank every dish mentioning a
      // chilli above the one actually called Chilli Momo.
      (i.description ?? '').toLowerCase().includes(term);

    /*
     * The stall's own sections, with each one's items narrowed. `view` has not
     * been applied yet — the block below does that, because two of its four
     * modes change the SHAPE of this list rather than its contents.
     */
    const sections = raw
      .map((c) => ({
        ...c,
        items: c.items.filter(
          (i) =>
            (!vegOnly || isVeg(i)) &&
            matches(i) &&
            (view !== 'bestsellers' || i.bestseller) &&
            (view !== 'must-try' || i.mustTry),
        ),
      }))
      .filter((c) => c.items.length > 0);

    if (!SORTS.has(view)) return sections;

    /*
     * SORTING FLATTENS. See the note on `ViewMode`.
     *
     * One synthetic section holding every surviving dish in price order. The
     * heading is dropped rather than kept and ignored: leaving "Starters" above
     * a list that is no longer starters would be worse than having no heading
     * at all.
     *
     * `id` is a fixed string because the render keys sections by it and the
     * scroll-spy looks them up in `sectionRefs`. A generated one would make
     * every keystroke remount the whole list.
     */
    const flat = sections.flatMap((c) => c.items);
    flat.sort((a, b) =>
      view === 'price-asc'
        ? a.pricePaise - b.pricePaise || a.name.localeCompare(b.name)
        : b.pricePaise - a.pricePaise || a.name.localeCompare(b.name),
    );

    // A tie broken by name, so two ₹120 dishes do not swap places between
    // renders. `sort` is stable in modern engines, but the input order here is
    // `flatMap` over sections and that is not a meaningful order to preserve.
    return flat.length === 0
      ? []
      : [
          {
            id: 'sorted',
            name: view === 'price-asc' ? 'Cheapest first' : 'Most expensive first',
            items: flat,
          },
        ];
  }, [q.data, vegOnly, dishQuery, view]);

  /** How many dishes the stall has in total, for the "3 of 47" line. */
  const totalItems = useMemo(
    () => (q.data?.categories ?? []).reduce((n, c) => n + c.items.length, 0),
    [q.data],
  );
  const shownItems = useMemo(
    () => categories.reduce((n, c) => n + c.items.length, 0),
    [categories],
  );

  const vendor = q.data?.vendor;

  /**
   * Adopt the stall into the cart on a DIRECT arrival, and only then.
   *
   * The header no longer reads the cart — it comes with the menu — which means
   * this screen now works for someone who opened `/vendor/:id` straight from a
   * link or a reload. Checkout still needs `vendorId`, so it has to be set
   * somewhere, and previously the only place was `Vendors.choose()`.
   *
   * The guard is `vendorId === null`, not "differs". `setVendor` EMPTIES the
   * basket when the stall changes — correctly, since an order has one vendor —
   * and doing that silently on mount would discard a basket the customer built
   * two taps ago. The stall list warns before switching; this must never
   * switch, only adopt.
   */
  const cartVendorId = useCart((s) => s.vendorId);
  const setVendor = useCart((s) => s.setVendor);
  /** For the breadcrumb and the Outlet row. Null on a cold link — see there. */
  const foodCourtName = useCart((s) => s.foodCourtName);

  // In an EFFECT, not during render. Writing to a store while rendering is a
  // side effect in the render phase — React warns about it, and under
  // concurrent rendering it can run on a render that is then thrown away.
  useEffect(() => {
    if (vendor && vendorId && cartVendorId === null) setVendor(vendorId, vendor.name);
  }, [vendor, vendorId, cartVendorId, setVendor]);

  /**
   * The banner photograph.
   *
   * `coverImageUrl` now, which the server resolves by the same rule the stall
   * CARD uses — the stall's own cover if it has uploaded one, otherwise its
   * first dish photo. That matters more than it sounds: this page used to pick
   * its own first-dish-with-an-image, in its own order, so tapping a card
   * showing a biryani could land on a page showing a paratha. Two answers to
   * one question, and the customer sees both within a second of each other.
   *
   * Null until a stall has photographed anything at all, and the fallback below
   * is designed to look chosen rather than missing.
   */
  const hero = q.data?.vendor.coverImageUrl ?? null;

  const basketPaise = lines.reduce((n, l) => n + l.pricePaise * l.quantity, 0);

  const jumpTo = (id: string): void => {
    setActive(id);
    setMenuOpen(false);
    // Expanding first: scrolling to a collapsed section lands on its heading
    // with nothing under it, which reads as the jump having failed.
    setCollapsed((m) => ({ ...m, [id]: false }));
    // After the expand has painted, or the target's position is the one it had
    // while shut and the scroll stops short by the height of its items.
    requestAnimationFrame(() =>
      sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  /**
   * WHICH SECTION AM I LOOKING AT.
   *
   * `active` was only ever set by tapping, so the sheet's bold row was "the
   * last thing you jumped to" — which is wrong the moment somebody scrolls,
   * and on a menu you scroll rather than jump it is wrong permanently.
   *
   * `IntersectionObserver` rather than a scroll handler: a scroll listener runs
   * on the main thread at every frame of a flick, and this screen is already
   * doing a 4-second poll and a sticky blur on a mid-range Android.
   *
   * `rootMargin` pins the trip-wire just under the sticky filter strip, so the
   * heading that has scrolled to the top of the READABLE area is the one that
   * counts — not one still hidden behind the bar.
   */
  useEffect(() => {
    const ids = categories.map((c) => c.id);
    if (ids.length === 0) return;

    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset['sectionId'];
          if (id) seen.set(id, e.isIntersecting ? e.boundingClientRect.top : Number.POSITIVE_INFINITY);
        }
        // The highest section still on screen. Sorting rather than taking the
        // first entry, because the callback receives only what CHANGED and the
        // one that changed is often the one leaving.
        const top = [...seen.entries()]
          .filter(([, y]) => Number.isFinite(y))
          .sort((a, b) => a[1] - b[1])[0];
        if (top) setActive(top[0]);
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 },
    );

    for (const id of ids) {
      const el = sectionRefs.current[id];
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [categories]);

  const name = vendor?.name ?? 'Menu';

  return (
    <div className="flex-1 flex flex-col bg-page">
      <main className="frame-inner w-full px-4 md:px-6 pt-4">
        {/* ================================================= breadcrumb + name
            A trail, not decoration: this page is reachable from a QR scan, a
            shared link and a reload, and in two of those three the customer has
            no history to go "back" through. The court name is the one piece of
            context that tells somebody who opened a link where they are.

            `foodCourtName` comes from the session rather than the menu, so it
            is absent on a cold link — and the crumb collapses to Home / Stall
            rather than rendering an empty segment.
        */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] mb-3">
          <button onClick={() => navigate('/court')} className="pressable text-ink-500 hover:text-ink-900">
            Home
          </button>
          {foodCourtName ? (
            <>
              <span aria-hidden className="text-ink-400">/</span>
              <button
                onClick={() => navigate('/court')}
                className="pressable text-ink-500 hover:text-ink-900 truncate max-w-[10rem]"
              >
                {foodCourtName}
              </button>
            </>
          ) : null}
          <span aria-hidden className="text-ink-400">/</span>
          <span className="font-bold text-ink-900 truncate">{name}</span>
        </nav>

        <div className="flex items-start gap-4">
          <h1 className="display text-[34px] md:text-[42px] text-ink-900 leading-tight flex-1 min-w-0">
            {name}
          </h1>

          {/*
            VEG AND ORDERS, TOGETHER, EXACTLY AS ON THE COURT LIST.

            The veg switch was down in the sticky strip below the banner — a
            grey band holding one large green pill, which read as an alert
            somebody had left on the page rather than a filter. It is the same
            control as the one on the stall list and it now looks and sits the
            same: a word and a switch, beside the profile icon, on the row with
            the title.

            Two screens with the same filter in two different places is two
            things for a customer to learn instead of one.
          */}
          <div className="flex items-center gap-1 shrink-0">
            {totalItems > 0 ? (
              <button
                onClick={() => setVegOnly((v) => !v)}
                aria-pressed={vegOnly}
                className={`pressable glass-hover shrink-0 h-9 flex items-center gap-1.5 rounded-full
                            px-2 border ${
                              vegOnly
                                ? 'bg-veg-fill border-veg-fill text-white'
                                : 'bg-ink-50 border-ink-200 text-ink-700'
                            }`}
              >
                <span className="eyebrow text-[10px] leading-none">Veg</span>
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

          {/* Orders lives up here now rather than floating on the photograph.
              The banner is contained and rounded, so a control overlapping its
              corner would sit half on the image and half on the page. */}
          <button
            onClick={() => navigate('/orders')}
            aria-label="Your orders"
            className="pressable glass-hover shrink-0 size-11 grid place-items-center rounded-full
                       border border-ink-200 bg-surface text-ink-900 relative"
          >
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
              <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M4.5 20a7.5 7.5 0 0115 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            {(mine.data?.orders.length ?? 0) > 0 ? (
              <span className="absolute top-2 right-2 size-2.5 rounded-full bg-brand-500 ring-2 ring-surface" />
            ) : null}
          </button>
          </div>
        </div>

        {/* ========================================================= the banner
            CONTAINED and rounded, matching the reference. A full-bleed hero
            reads as a magazine cover; a contained one reads as a photograph OF
            this stall, which is what it is. */}
        <div className="relative mt-5 rounded-[1.25rem] overflow-hidden">
          {hero ? (
            <img src={hero} alt="" className="h-52 md:h-72 lg:h-[22rem] w-full object-cover" />
          ) : (
            <HeroFallback name={name} />
          )}

          {/* The stall's own mark, over the photograph's bottom-left, on glass.
              Only when it HAS one — a placeholder square here would be a hole
              in the middle of the best picture on the page. */}
          {vendor?.logoUrl ? (
            <span className="absolute left-4 bottom-4 size-16 rounded-2xl overflow-hidden glass-on border border-transparent">
              <img src={vendor.logoUrl} alt="" className="size-full object-cover" />
            </span>
          ) : null}
        </div>

        {/* ==================================================== the facts strip
            The reference puts a star rating and a cost-for-two here. There is
            no rating data in this platform and inventing one would be a claim
            about a real business, so the slot carries what is actually known:
            a typical spend from the median dish price, the cuisines the stall
            declared, and whether it is open — with the closing time, because
            "Open now" at 22:50 in a food court is true and useless.
        */}
        {vendor ? (
          <div className="mt-5 space-y-2">
            {/*
              "₹200.00 typical per dish" AND THE CUISINE LINE ARE GONE.

              Both were borrowed from the delivery-app reference, where they do
              real work: you are choosing between restaurants you cannot see,
              across a city, so a price band and a cuisine tag are how you
              shortlist. Here the customer has already chosen this stall and is
              standing in front of it — they walked past the sign.

              What is left under the banner is the one thing that changes and
              that they cannot see from where they are: whether it is open, and
              until when. The banner above it is identity, not a spec sheet.
            */}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
              {vendor.accepting ? (
                <>
                  <span className="font-bold text-fresh-700">Open now</span>
                  {vendor.closesAt ? (
                    <>
                      <span aria-hidden className="text-ink-400">·</span>
                      <span className="text-ink-700">
                        Closes {clockTime(vendor.closesAt)}
                        {/* Only said when it is actually true. "Closes 2:00 am
                            tomorrow" at 23:00 is information; the same words at
                            01:00, when the stall shuts in an hour, are wrong. */}
                        {vendor.closesTomorrow ? ' tomorrow' : ''}
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="font-bold text-ink-700">
                    {vendor.closedReason === 'paused' ? 'Paused' : 'Closed'}
                  </span>
                  {vendor.opensAt ? (
                    <>
                      <span aria-hidden className="text-ink-400">·</span>
                      <span className="text-ink-700">
                        Opens {clockTime(vendor.opensAt)}
                        {vendor.opensToday === false ? ' tomorrow' : ''}
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </p>
          </div>
        ) : null}

        {/* ============================================ outlet and prep, dotted
            A two-row list joined by a dotted rail, exactly as the reference
            draws it. The rail is a `border-l` on the container with the dots as
            pseudo-free spans — cheaper than an SVG and it reflows with the
            text, which an SVG would not.
        */}
        {vendor ? (
          <div className="mt-5 pt-5 border-t border-ink-200 max-w-md">
            <ul className="relative pl-5 space-y-3">
              <span
                aria-hidden
                className="absolute left-[3px] top-2 bottom-2 w-px border-l border-dashed border-ink-200"
              />
              {foodCourtName ? (
                <li className="relative text-[15px]">
                  <span aria-hidden className="absolute -left-5 top-1.5 size-[7px] rounded-full bg-ink-200" />
                  <span className="font-bold text-ink-900">Outlet</span>{' '}
                  <span className="text-ink-700">{foodCourtName}</span>
                </li>
              ) : null}
              <li className="relative text-[15px] text-ink-700">
                <span aria-hidden className="absolute -left-5 top-1.5 size-[7px] rounded-full bg-ink-200" />
                <span className="tnum">{vendor.estimatedPrepMinutes}</span> min to collect
              </li>
            </ul>
          </div>
        ) : null}
      </main>

      {/* ================================================ the filter strip
          Sticky, and glass. It sits over the dish list as you scroll, and a
          solid bar there is a shelf across the middle of the page — a frosted
          one lets the photographs read through it, which is the one place in
          this app where a backdrop blur has something to blur.

          The category PILLS are gone. The reference navigates a long menu with
          the floating MENU sheet instead, and a rail of nine cuisines above a
          list of the same nine headings is the same information twice.
      */}
      {/*
        SEARCH ONLY, and only on a menu long enough to be worth searching.

        The veg switch used to share this strip, which meant the strip existed
        on every stall page — a grey band under the banner carrying one control.
        With veg in the header, a stall with fifteen dishes or fewer has no
        strip at all, and the menu starts directly under the outlet line.
      */}
      {q.data && totalItems > 15 ? (
        <div className="sticky top-0 z-20 border-b border-ink-200 bg-surface/80 glass-on rounded-none">
          <div className="frame-inner flex items-center gap-2 px-4 md:px-6 py-2.5">
            <div className="relative min-w-0 flex-1 max-w-sm">
              <svg
                viewBox="0 0 24 24"
                className="size-[18px] absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400"
                fill="none"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={dishQuery}
                onChange={(e) => setDishQuery(e.target.value)}
                placeholder={`Search ${totalItems} dishes`}
                aria-label="Search this menu"
                className="w-full h-10 bg-ink-50 text-ink-900 rounded-xl border border-ink-200 pl-11 pr-4
                           text-[15px] placeholder:text-ink-400 outline-none
                           focus:ring-2 focus:ring-brand-200 focus:border-brand-500"
              />
            </div>

            {/* The count, only while filtering. "Showing 3 of 47" is what tells
                somebody the rest of the menu still exists — without it a
                filtered menu looks like a stall that sells three things. */}
            {dishQuery.trim() ? (
              <p className="hidden sm:block text-[13px] text-ink-500 shrink-0" aria-live="polite">
                {shownItems === 0 ? 'No matches' : `${shownItems} of ${totalItems}`}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ============================================================= items */}
      <main className="frame-inner flex-1 w-full px-4 md:px-6 py-5">
        <LiveOrders orders={mine.data?.orders ?? []} onOpen={(id) => navigate(`/order/${id}`)} />

        {q.isLoading ? <MenuSkeleton /> : null}
        {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}

        {/*
          ====================================================================
          THE SORT AND FILTER CHIPS
          ====================================================================

          A horizontal scroller, because four chips plus their labels do not fit
          on a 360px screen and wrapping them to two lines pushes the food below
          the fold — which is the one thing this screen must not do.

          `scroll-px-4` is not decoration. `snap-start` aligns a child against
          the padding box reduced by `scroll-padding`, which defaults to zero —
          so without it the first chip snaps flush against the screen edge and
          reads as clipped. This is the same fix the court's category rail
          needed, for the same reason.

          Hidden entirely when the stall has no items: chips that filter nothing
          are four controls asking to be understood for no reward.
        */}
        {totalItems > 0 ? (
          <div
            className="-mx-4 md:-mx-6 mb-4 px-4 md:px-6 scroll-px-4 md:scroll-px-6
                       flex gap-2 overflow-x-auto snap-x no-scrollbar"
            role="group"
            aria-label="Sort and filter"
          >
            {VIEW_CHIPS.map((chip) => {
              const on = view === chip.mode;
              return (
                <button
                  key={chip.mode}
                  /* Tapping the active chip clears it. A filter you cannot
                     turn off without hunting for a fifth "All" chip is a trap,
                     and the chip that set it is the obvious place to look. */
                  onClick={() => setView(on ? 'default' : chip.mode)}
                  aria-pressed={on}
                  className={`pressable glass-hover snap-start shrink-0 h-9 px-3.5 rounded-full
                              border eyebrow text-[10px] whitespace-nowrap ${
                                on
                                  ? 'bg-brand-fill border-brand-fill text-on-brand'
                                  : 'bg-ink-50 border-ink-200 text-ink-700'
                              }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {/*
          An empty result from a CHIP is not the same as an empty result from
          the search box, which has its own message above. A stall with no
          bestsellers yet is normal — it has taken no orders — and saying so is
          more useful than an empty page.
        */}
        {view !== 'default' && shownItems === 0 && !dishQuery.trim() ? (
          <p className="text-[15px] text-ink-500 py-6" aria-live="polite">
            {view === 'bestsellers'
              ? 'No bestsellers yet — this stall has not sold enough this week.'
              : view === 'must-try'
                ? 'This stall has not picked any dishes to recommend.'
                : 'Nothing to show.'}
          </p>
        ) : null}

        {dishQuery.trim() && shownItems === 0 ? (
          <p className="text-[15px] text-ink-500 py-6" aria-live="polite">
            Nothing matching “{dishQuery.trim()}” on this menu.
          </p>
        ) : null}

        <div>
          {categories.map((c) => {
            const open = collapsed[c.id] !== true;
            return (
              <section
                key={c.id}
                ref={(el) => {
                  sectionRefs.current[c.id] = el;
                }}
                /* The observer callback gets a NODE, not a React key, so the
                   id has to travel on the element itself. */
                data-section-id={c.id}
                className="scroll-mt-20 border-b border-ink-200 last:border-b-0 py-5 first:pt-1"
              >
                {/*
                  THE HEADING IS THE TOGGLE, AND IT CARRIES THE COUNT.

                  "Kebabs Platter And Starters 16" is the reference's shape and
                  it earns its place: on a menu of sixty dishes the count is how
                  a customer decides whether to open a section or scroll past
                  it, and collapsing is how they get past the sixteen they do
                  not want without a thumb marathon.

                  A `<button>` with `aria-expanded`, not a div with a chevron.
                  The chevron is the only visible affordance and a screen reader
                  cannot see it rotate.
                */}
                <button
                  onClick={() => setCollapsed((m) => ({ ...m, [c.id]: open }))}
                  aria-expanded={open}
                  className="pressable glass-hover rounded-lg -mx-2 px-2 py-1 w-full flex items-center gap-3 text-left"
                >
                  <h2 className="text-[19px] font-bold text-ink-900 flex-1 min-w-0 truncate">
                    {c.name}{' '}
                    <span className="text-ink-500 font-bold tnum">({c.items.length})</span>
                  </h2>
                  <svg
                    viewBox="0 0 24 24"
                    className={`size-5 shrink-0 text-ink-700 transition-transform ${open ? '' : '-rotate-180'}`}
                    fill="none"
                    aria-hidden
                  >
                    <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {open ? (
                  <ul className="mt-2 lg:grid lg:grid-cols-2 lg:gap-x-8">
                    {c.items.map((item) => (
                      <li key={item.id} className="border-b border-ink-100 last:border-b-0 lg:border-b">
                        <Dish
                          item={item}
                          quantity={qtyOf(item.id)}
                          onAdd={() =>
                            qtyOf(item.id) === 0
                              ? addToCart(item)
                              : setQuantity(item.id, qtyOf(item.id) + 1)
                          }
                          onRemove={() => setQuantity(item.id, qtyOf(item.id) - 1)}
                          onOpen={() => setOpenDish(item)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>

        {q.data && categories.length === 0 ? (
          vegOnly ? (
            <EmptyState
              title="No vegetarian items"
              body="This stall has not marked any of its dishes vegetarian."
            />
          ) : (
            <EmptyState title="Nothing on the menu" body="This stall has not added any items yet." />
          )
        ) : null}
      </main>

      {/* ============================================== the MENU button + sheet */}
      {/*
        `>= 1`, NOT `> 1`. THAT ONE CHARACTER IS WHY IT WAS NEVER ON SCREEN.

        The condition was `categories.length > 1`, on the reasoning that a sheet
        listing a single section is chrome describing nothing. That reasoning is
        fine and the consequence was not: a stall whose menu is ONE section got
        no button at all — and a menu that is one long undivided section is
        precisely the one that is hardest to scroll, so it is the case that
        needs a jump list most.

        It also meant filtering could take the button away. Typing a search term
        that matched inside one section dropped the count to one and the control
        vanished mid-use, which reads as a crash rather than a rule.

        THE FILTERED LIST, THOUGH, NOT `q.data.categories`. The first attempt at
        this fix used the stall's raw sections so no filter could ever hide the
        button — and that renders a sheet with rows pointing at sections which
        are not on the page, or an empty sheet when a search matches nothing.
        Every row in the sheet has to be somewhere the customer can actually be
        sent, so the sheet follows what is rendered.
      */}
      {categories.length >= 1 ? (
        <MenuJump
          sections={categories.map((c) => ({ id: c.id, name: c.name, count: c.items.length }))}
          active={active}
          open={menuOpen}
          onToggle={() => setMenuOpen((o) => !o)}
          onPick={jumpTo}
          liftedByCart={count > 0}
        />
      ) : null}

      {count > 0 ? (
        <div className="action-dock sticky bottom-0 z-20 px-4 pb-4 safe-bottom">
          <div className="measure">
            {/* No plate. The BUTTON is the glass — see `.glass-action`. A
                frosted rim around a red pill read as a border, not a material. */}
            <button
              onClick={() => navigate('/checkout')}
              className="pressable glass-action w-full rounded-[1.4rem] text-on-brand py-4 px-5
                     flex items-center justify-between"
            >
              <span className="text-left">
                <span className="block text-[11px] text-on-brand-muted leading-tight eyebrow">
                {count} {count === 1 ? 'item' : 'items'}
                </span>
                <span className="block font-bold text-[17px] tnum leading-tight mt-0.5">
                {formatINR(basketPaise)}
                </span>
              </span>
              <span className="eyebrow text-[13px] flex items-center gap-1.5">
                View cart
                <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                <path
                  d="M9 5l7 7-7 7"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                </svg>
              </span>
            </button>
            {/*
              "Collect from the stall when your number is called" USED TO BE HERE
              and has moved to checkout.

              It is reassurance about a thing that has not happened yet. On a
              menu the customer has not ordered, so the sentence is answering a
              question nobody has asked — and it was the reason this control had
              to be a white bar at all: a caption needs an opaque background to
              be readable, and an opaque background across the width of the
              screen is the slab this replaced.

              It still appears at checkout, immediately before paying, which is
              the moment somebody actually wonders how they will get the food.
            */}
          </div>
        </div>
      ) : null}

      {/*
        THE DISH SHEET, RENDERED ONCE AT THE ROOT.

        Not inside the row that opened it. A `position: fixed` overlay resolves
        against the nearest ancestor carrying `transform`, `filter` or
        `backdrop-filter` rather than against the viewport — and the rows here
        sit inside glass surfaces that have all three. Mounted in the row, the
        sheet would be trapped inside a 96px-tall list item.

        One instance for the whole screen also means one dialog can be open, an
        Escape handler that cannot be registered ninety times, and a body scroll
        lock with exactly one owner.
      */}
      {openDish ? (
        <DishSheet
          item={openDish}
          quantity={qtyOf(openDish.id)}
          onAdd={() =>
            qtyOf(openDish.id) === 0
              ? addToCart(openDish)
              : setQuantity(openDish.id, qtyOf(openDish.id) + 1)
          }
          onRemove={() => setQuantity(openDish.id, qtyOf(openDish.id) - 1)}
          onClose={() => setOpenDish(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * ============================================================================
 * "TELL ME WHEN IT IS BACK"
 * ============================================================================
 *
 * WHAT THIS REPLACES
 *
 * Grey text saying "Sold out" and nothing else. That is the end of the journey
 * for the one person on the whole menu who has definitely decided what they
 * want — the stall cooks another tray twenty minutes later and the only diner
 * who was certain about it has gone.
 *
 * A DEAD END BECOMES A CONTROL, and it is the smallest one on the row on
 * purpose: it sits under a dish somebody cannot buy, so it must not compete
 * with the ADD buttons on the eight dishes they can.
 *
 * THE ERROR IS THE SERVER'S SENTENCE, NOT A GENERIC ONE.
 *
 * Every refusal from this endpoint is a real answer worth reading — "that one
 * is available right now", "it is not sold out, it goes on sale later today" —
 * and collapsing four useful messages into "Something went wrong" would throw
 * away the only part of the interaction that teaches the customer anything.
 */
function WatchButton({ item }: { item: MenuItem }) {
  const { watching, toggle, pending, error } = useWatchItem(item.id);

  return (
    <>
      <button
        onClick={toggle}
        disabled={pending}
        aria-pressed={watching}
        className={`pressable glass-hover mt-2 inline-flex items-center gap-1.5 rounded-full
                    border px-3 h-8 text-[12px] font-semibold disabled:opacity-50 ${
                      watching
                        ? 'border-fresh-500 text-fresh-700 bg-fresh-50'
                        : 'border-ink-200 text-ink-700 bg-ink-50'
                    }`}
      >
        {watching ? (
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
            <path
              d="M4 12.5l5 5 11-11"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          // A bell, because that is what the gesture means everywhere else a
          // phone has ever asked it.
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
            <path
              d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9zM10 18.5a2 2 0 004 0"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {pending ? 'One moment…' : watching ? "We'll tell you" : 'Tell me when it is back'}
      </button>

      {error ? (
        <p role="alert" className="text-[12px] text-ink-700 mt-1.5 leading-relaxed">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * `23:30` as `11:30 pm`.
 *
 * The API speaks 24-hour because it is unambiguous on the wire; a customer in a
 * food court reads a clock. `Intl` rather than hand-rolled modulo arithmetic —
 * it gets 00:xx and 12:xx right, which is exactly where hand-rolled versions
 * say "0:30 am" and "0:30 pm".
 */
function clockTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const d = new Date(2000, 0, 1, h, m);
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .toLowerCase();
}

/**
 * ============================================================================
 * THE FLOATING MENU BUTTON, AND THE SHEET IT OPENS
 * ============================================================================
 *
 * WHY A SHEET AND NOT A RAIL OF PILLS
 *
 * A horizontal pill rail shows three categories out of nine and hides the rest
 * behind a sideways scroll nobody discovers. The sheet shows all nine, with
 * their COUNTS, which is the thing that makes a long menu navigable: "Kebabs
 * 16" tells you where the stall's actual business is.
 *
 * WHY IT IS DARK
 *
 * The reference's is, and the reason is sound rather than fashionable — the
 * sheet floats over a page made of food photographs, and a light panel over a
 * light page needs a border to be a panel at all. A dark one separates by
 * value, which no amount of photograph behind it can defeat.
 *
 * It is `glass-on` over that dark, so the photographs read through as a blur
 * rather than being replaced by a slab. That is the one place in this app where
 * a backdrop filter has a genuinely busy backdrop to work with.
 */
function MenuJump({
  sections,
  active,
  open,
  onToggle,
  onPick,
  liftedByCart,
}: {
  sections: { id: string; name: string; count: number }[];
  active: string | null;
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  /** The cart bar occupies the bottom of the screen; the button steps over it. */
  liftedByCart: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  /*
   * ESCAPE CLOSES IT, AND SO DOES A TAP ANYWHERE ELSE.
   *
   * `pointerdown`, not `click`: a click fires after the pointer is released, so
   * tapping a dish while the sheet is open would close the sheet AND add the
   * dish. Closing on the press means the tap that dismisses is spent doing
   * only that — which is what every sheet on a phone does, and what a customer
   * expects without being able to say so.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onToggle();
    };
    const onDown = (e: PointerEvent): void => {
      if (!panel.current?.contains(e.target as Node)) onToggle();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, onToggle]);

  return (
    <div
      ref={panel}
      className={`fixed right-4 md:right-6 z-30 flex flex-col items-end gap-2 ${
        liftedByCart ? 'bottom-28' : 'bottom-5'
      } safe-bottom`}
    >
      {open ? (
        /*
          `max-h` and a scroll, because a stall with twenty categories would
          otherwise render a sheet taller than the phone and put the last six
          off the bottom of the screen with no way to reach them.

          `origin-bottom-right` so it grows OUT of the button rather than
          appearing beside it — the animation is what says these two things are
          one control.
        */
        <div
          role="menu"
          aria-label="Jump to a section"
          className="glass-on rounded-[1.25rem] border border-white/10 bg-ink-900/85 text-page
                     shadow-dialog w-[min(15rem,calc(100vw-2.5rem))] max-h-[50vh] overflow-y-auto
                     py-2 origin-bottom-right toast-in"
        >
          {sections.map((sec) => {
            const on = sec.id === active;
            return (
              <button
                key={sec.id}
                role="menuitem"
                onClick={() => onPick(sec.id)}
                aria-current={on ? 'true' : undefined}
                className={`pressable glass-hover rounded-lg mx-1.5 w-[calc(100%-0.75rem)] flex items-baseline gap-3
                            px-3 py-2 text-left ${on ? 'font-bold text-page' : 'text-page/70'}`}
              >
                {/* `truncate`, now the sheet is 15rem rather than 20rem. A name
                    like "Kebabs Platter And Starters" no longer fits on one
                    line, and a wrapped one turns a tidy list into a ragged
                    block where the counts stop lining up. */}
                <span className="flex-1 min-w-0 text-[14px] truncate">{sec.name}</span>
                <span className={`text-[14px] tnum shrink-0 ${on ? 'text-page' : 'text-page/60'}`}>
                  {sec.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/*
        A LABEL AS WELL AS A GLYPH. A lone fork-and-knife in a dark square is
        guessable at best, and this is the only way to navigate a sixty-dish
        menu without scrolling the whole thing.
      */}
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Close the section list' : 'Jump to a section'}
        /*
          48px, down from 62.

          It is a NAVIGATION AID sitting permanently on top of the content it
          helps you navigate, so it has to be reachable without being the
          largest object on the screen. 48 still clears the 44px minimum touch
          target, and gives back 40% of the area it was covering.
        */
        className="pressable glass-hover rounded-[0.9rem] size-12 grid place-items-center gap-px
                   bg-ink-900/90 text-page shadow-dialog border border-white/10"
      >
        <span className="eyebrow text-[8px] tracking-[0.1em] leading-none">
          {open ? 'CLOSE' : 'MENU'}
        </span>
        {open ? (
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
            <path
              d="M7 3v8m0 0v10m0-10a2.5 2.5 0 002.5-2.5V3M7 11A2.5 2.5 0 014.5 8.5V3M16.5 3c-1 2-1.5 4-1.5 6 0 1.7.8 2.8 2 3v9"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}

/**
 * One dish, as a ROW rather than a card.
 *
 * ============================================================================
 * WHY THE CARD BECAME A ROW
 * ============================================================================
 *
 * Every dish used to be a white card with a shadow, on a page of white cards
 * with shadows. Sixty of them is sixty rectangles, and the eye has to find the
 * edges before it can read anything. The reference uses a hairline between
 * plain rows, which is quieter and lets the PHOTOGRAPHS be the thing with edges
 * — they are the only part of a menu worth looking at before reading.
 *
 * ============================================================================
 * THE ORDER OF THE LINES, WHICH IS NOT THE OBVIOUS ONE
 * ============================================================================
 *
 *   mark → badge → name → price → description
 *
 * Price ABOVE description, not below. Description is the least-read line on the
 * screen, and putting it between the name and the price separates the two
 * things a customer is comparing across a menu. The reference does the same and
 * it is the single highest-leverage decision in this layout.
 */
function Dish({
  item,
  quantity,
  onAdd,
  onRemove,
  onOpen,
}: {
  item: MenuItem;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
  /** Open the full-size sheet. See `DishSheet` for why this is not the row. */
  onOpen: () => void;
}) {
  return (
    <div className={`flex gap-4 py-5 ${item.available ? '' : 'opacity-70'}`}>
      {/*
        THE TEXT BLOCK OPENS THE SHEET; THE CONTROLS STAY CONTROLS.

        Making the whole ROW the button is the tempting version and it is
        invalid: the row contains ADD and, once something is in the basket, a
        −/+ stepper, and a button cannot contain a button. Beyond the HTML, it
        is ambiguous to a thumb — tapping + near its edge would open a sheet
        instead of adding a second momo — and a screen reader would announce one
        control where there are three.

        `text-left` because a `<button>` centres its content by default, which
        would centre the whole dish description.
      */}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${item.name}, see details`}
          className="w-full text-left rounded-xl glass-hover -m-1 p-1"
        >
          <div className="flex items-center gap-2">
            <VegMark flags={item.dietaryFlags} />

          {/*
            BESTSELLER IS A FACT NOW, and that is the only reason it is here.

            The server badges the top three by units actually sold in the last
            seven days, excluding lines the kitchen rejected. An earlier version
            of this file listed this badge under "things the delivery apps do
            that we refuse", because there was no order-volume analysis and a
            badge nobody computed is a lie with a nice border. There is one now.
          */}
          {item.bestseller && item.available ? (
            <span className="inline-flex items-center gap-1 eyebrow text-[10px] text-brand-700">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
                <path d="M12 2.5l2.7 5.9 6.3.8-4.7 4.4 1.3 6.4L12 16.8 6.4 20l1.3-6.4L3 9.2l6.3-.8z" />
              </svg>
              Bestseller
            </span>
          ) : null}

          {/*
            ==================================================================
            THE STALL'S OWN PICK — A DIFFERENT WORD AND A DIFFERENT MARK
            ==================================================================

            Never rendered as "Bestseller", and never merged with it. That badge
            is a measurement; this one is the kitchen's opinion, set from the
            board and capped at three per stall. A customer who cannot tell them
            apart cannot tell which claims have a number behind them — and the
            moment the two look identical, the measured one has been quietly
            devalued to the level of the typed-in one.

            So: a hand icon rather than a star, "Must try" rather than
            "Bestseller", and `fresh-700` rather than `brand-700`. A dish can
            carry both, which is a fine thing to say — the stall recommends it
            and it also happens to sell.
          */}
          {item.mustTry && item.available ? (
            <span className="inline-flex items-center gap-1 eyebrow text-[10px] text-fresh-700">
              <svg
                viewBox="0 0 24 24"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3z" />
                <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
              </svg>
              Must try
            </span>
          ) : null}
        </div>

        <h3
          className={`font-bold text-[16px] leading-snug mt-2 ${
            item.available ? 'text-ink-900' : 'text-ink-400'
          }`}
        >
          {item.name}
        </h3>

        <p
          className={`text-[15px] font-bold mt-1.5 tnum ${
            item.available ? 'text-ink-900' : 'text-ink-400'
          }`}
        >
          {formatINR(item.pricePaise)}
        </p>

        {item.description ? (
          <p className="text-[13px] text-ink-500 mt-2 leading-relaxed clamp-2">
            {item.description}
          </p>
        ) : null}

          {/* Never colour alone. Sold-out and out-of-stock read identically to
              the customer — that difference is the vendor's business. */}
          {!item.available ? (
            <p className="eyebrow text-[10px] text-ink-400 mt-2.5">
              {item.unavailableReason === 'item.unavailable.badge'
                ? 'Unavailable right now'
                : 'Sold out'}
            </p>
          ) : null}
        </button>

        {/*
          THE WATCH BUTTON IS A SIBLING OF THE TAPPABLE BLOCK, NOT INSIDE IT.

          It used to sit in this column next to the "Sold out" line, which is
          now inside a `<button>` — and a button inside a button is invalid HTML
          that browsers resolve by dropping the inner one. "Tell me when it is
          back" would have silently stopped working, on the one control a
          customer only ever presses once.

          So the column stays a plain `div`: the part that opens the sheet is a
          button within it, and this is beside that button rather than in it.
        */}
        {!item.available ? <WatchButton item={item} /> : null}
      </div>

      {/*
        THE PHOTOGRAPH, WITH THE CONTROL OVERLAPPING ITS LOWER EDGE.

        `-mt-5` pulls the button up over the tile's box, so the row is the tile's
        height plus half a button rather than the two stacked. That overlap is
        what makes the pair read as one object — and it puts ADD on the largest,
        most obvious target in the row, which is the point.

        `items-center` on the column, so a narrow ADD and a wide stepper both
        stay centred under the photo as the quantity changes; left-aligned, the
        control would shift sideways the moment somebody tapped it.
      */}
      <div className="shrink-0 flex flex-col items-center">
        <FoodTile name={item.name} imageUrl={item.imageUrl} size="lg" dimmed={!item.available} />
        <div className="-mt-5">
          <AddControl
            quantity={quantity}
            label={item.name}
            disabled={!item.available}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The hero when no dish has a photograph.
 *
 * Deterministic from the stall name, so the same stall gets the same band on
 * every visit and a customer learns its colour. Two stops plus a soft vignette
 * at the bottom, where the identity sheet overlaps — without it the sheet's
 * white edge sits on a flat colour and reads as a seam rather than a layer.
 */
function HeroFallback({ name }: { name: string }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;

  const PAIRS: readonly (readonly [string, string])[] = [
    ['#F6C177', '#C4451C'],
    ['#7FB77E', '#137A45'],
    ['#8ECAE6', '#22668D'],
    ['#E8A0BF', '#B4436C'],
    ['#D4B483', '#8A6522'],
    ['#A5C882', '#4F772D'],
  ];
  const pair = PAIRS[Math.abs(h) % PAIRS.length]!;

  // The heights match the photograph's exactly. A fallback stuck at 224px while
  // the real hero grows to 320px would make the page change height depending on
  // whether a stall has got round to uploading a picture.
  return (
    <div
      aria-hidden
      className="h-56 md:h-72 lg:h-80 w-full grid place-items-center"
      style={{ background: `linear-gradient(150deg, ${pair[0]}, ${pair[1]})` }}
    >
      <span className="display text-[72px] text-white/90 drop-shadow-sm">
        {name.trim().slice(0, 1).toUpperCase()}
      </span>
    </div>
  );
}
