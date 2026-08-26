/**
 * The component kit.
 *
 * One file, because the whole app is eight screens and a second file would be
 * organisation for its own sake. If it passes ~400 lines, split by concern
 * (shell / feedback / food) rather than one file per component.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { ApiError } from '../lib/api';
import { formatINR } from '../lib/money';
import { cdn } from '../lib/cdn';
import { MD, useMediaQuery } from '../lib/media';
import { theme } from '../lib/theme';

// =============================================================================
// Shell
// =============================================================================

/**
 * The light / dark switch.
 *
 * `useSyncExternalStore` rather than `useState`, because the theme also lives on
 * `<html>` and in localStorage. Two copies of one truth is what made the kitchen
 * board flicker between its login and its dashboard, and the fix there was this
 * hook; there is no reason to reintroduce the same shape here.
 *
 * It is a sun/moon icon with no label because it sits in an app bar where every
 * pixel is already claimed, but the `aria-label` says what it will DO rather
 * than what the state IS — "Switch to dark" is actionable, "Dark mode: off"
 * makes a screen reader user work out the consequence themselves.
 */
export function ThemeToggle({ tint }: { tint?: 'brand' | 'plain' }) {
  const current = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  const next = current === 'light' ? 'dark' : 'light';
  const brand = tint === 'brand';

  return (
    <button
      onClick={() => theme.set(next)}
      aria-label={`Switch to ${next} mode`}
      className={`pressable glass-hover size-11 grid place-items-center rounded-full ${
        brand ? 'text-on-brand' : 'text-ink-700'
      }`}
    >
      {current === 'light' ? (
        // Moon: the thing you would be switching TO.
        <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" aria-hidden>
          <path
            d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

export function AppBar({
  title,
  subtitle,
  back,
  right,
  center,
  tint,
  width = 'read',
}: {
  title: string;
  subtitle?: string | undefined;
  /** Shows a back chevron. Omit on the first screen after a scan. */
  back?: boolean;
  right?: ReactNode;
  /**
   * Controls that belong to the whole screen rather than to the content.
   *
   * The stall list's search and veg switch. They were the first thing in the
   * BODY, which pushed the actual content — the categories, the offers, the
   * stalls — a hundred pixels down the page and made the top of the screen two
   * bands of chrome stacked on each other.
   *
   * A search that filters everything below it is navigation, not content, and
   * it belongs in the bar with the other things that are true of the whole
   * screen. Beside the title on a wide window; on its own row inside the bar
   * below `md`, because a court name, a search box and two icons do not fit on
   * one line of a phone and squeezing them would shrink the one you type in.
   */
  center?: ReactNode;
  /** Red bar for the stall header; white everywhere else. */
  tint?: 'brand' | 'plain';
  /** Matches the screen's body width, so the title lines up with the content. */
  width?: 'read' | 'full';
}) {
  const navigate = useNavigate();
  const brand = tint === 'brand';

  return (
    <header
      className={`sticky top-0 z-20 safe-top ${
        brand
          ? 'bg-brand-fill text-on-brand'
          : 'bg-surface border-b border-ink-200'
      }`}
    >
      {/* The BAR spans the WINDOW — a header that stops short of the edge looks
          like a bug, and until the frame's cap moved inward this comment was
          describing something that was not happening — but its CONTENTS follow
          the body's width, so on a checkout screen the title sits directly
          above the first line of the order rather than a screen-width away
          from it. */}
      <div
        className={`flex items-start gap-3 px-4 md:px-6 pt-3 pb-3 ${
          width === 'read' ? 'measure' : 'frame-inner'
        }`}
      >
        {back ? (
          <button
            onClick={() => navigate(-1)}
            aria-label="Go back"
            // 44px minimum. A cook with wet hands and a diner walking through a
            // hall are both hitting this without looking.
            className="pressable glass-hover -ml-2 size-11 grid place-items-center rounded-full shrink-0"
          >
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
              <path
                d="M15 19l-7-7 7-7"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}

        {/*
          `flex-1` ALWAYS on a phone, and only surrendered at `md`.

          Below `md` the centre slot is not on this row at all — it is the
          full-width search underneath — so the title has to claim the space or
          it sizes to its own text and the right-hand cluster drifts inward,
          leaving a gap between the court name and the icons that reads as a
          layout that failed.

          At `md` the centre slot joins this row, and there the title takes what
          it needs and the search takes the rest, rather than the two splitting
          the row evenly and leaving a 200px input.
        */}
        <div className={`min-w-0 py-1.5 flex-1 ${center ? 'md:flex-none md:shrink-0' : ''}`}>
          <h1
            className={`text-[19px] leading-tight font-bold truncate ${
              brand ? 'text-on-brand' : 'text-ink-900'
            }`}
          >
            {title}
          </h1>
          {subtitle ? (
            /* `on-brand-muted`, not `brand-100`. The old pairing put #FFDEDB on
               #E8483F — 3.08:1, well under AA for 13px text, and the line it
               was failing on is the one that says how many stalls are open. */
            <p
              className={`text-[13px] mt-0.5 truncate ${
                brand ? 'text-on-brand-muted' : 'text-ink-500'
              }`}
            >
              {subtitle}
            </p>
          ) : null}
        </div>

        {/* Wide windows only. Below `md` it renders on its own row below.

            `justify-end` so the collapsed chip sits beside the profile icons
            rather than stranded against the title with a void after it. */}
        {center ? (
          <div className="hidden md:flex justify-end items-center min-w-0 flex-1">{center}</div>
        ) : null}

        {right ? <div className="shrink-0 py-1">{right}</div> : null}
      </div>

      {/*
        THE SECOND ROW, PHONES ONLY.

        A full-width search under the title — logo left, controls right, search
        beneath — which is the shape every delivery app in India uses and the
        one a customer already knows how to read. `flex` rather than `block`
        because the field inside is `flex-1`, and a flex child needs a flex
        parent to grow into.
      */}
      {center ? (
        <div
          className={`md:hidden flex items-center px-4 pb-3 ${
            width === 'read' ? 'measure' : 'frame-inner'
          }`}
        >
          {center}
        </div>
      ) : null}
    </header>
  );
}

export function Screen({
  title,
  subtitle,
  children,
  footer,
  back,
  right,
  center,
  tint,
  width = 'read',
}: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
  back?: boolean;
  right?: ReactNode;
  /** Screen-wide controls that live in the bar. See `AppBar`. */
  center?: ReactNode;
  tint?: 'brand' | 'plain';
  /**
   * How the screen uses a wide window.
   *
   * `read` (default) keeps content at a readable measure and centres it. Right
   * for anything that is a SEQUENCE — checkout, payment, verification — where
   * a wider column only makes the eye travel further between a label and the
   * number next to it.
   *
   * `full` lets the screen fill the frame and lay out a grid. Right for
   * anything that is a SET — the stall list, a menu, an order history — where
   * seeing more at once is the entire value.
   */
  width?: 'read' | 'full';
}) {
  return (
    /* `flex-1`, not `min-h-full`. The app shell is now a flex column with a
       `min-height`, and a percentage min-height inside it has nothing definite
       to resolve against — it would collapse and take the sticky footer with
       it. */
    <div className="flex-1 flex flex-col bg-page">
      <AppBar
        title={title}
        subtitle={subtitle}
        width={width}
        {...(back !== undefined ? { back } : {})}
        {...(right !== undefined ? { right } : {})}
        {...(center !== undefined ? { center } : {})}
        {...(tint !== undefined ? { tint } : {})}
      />
      <main
        className={`flex-1 w-full px-4 py-4 md:px-6 ${
          width === 'read' ? 'measure' : 'frame-inner'
        }`}
      >
        {children}
      </main>
      {footer}
    </div>
  );
}

/** The sticky bottom action. Always full-width, always thumb-height. */
export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="action-dock sticky bottom-0 z-20 px-4 md:px-6 pb-4 safe-bottom">
      {/* Same measure as the body. A "PAY NOW" control stretched to the window
          is a 1400px-wide button, which reads as a banner rather than a thing
          to press. */}
      {/* The child supplies its own surface — `glass-action` on the button, or
          whatever a screen needs. A wrapper plate here was a rim around every
          one of them. */}
      <div className="measure">{children}</div>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      className="pressable glass-hover w-full rounded-xl bg-brand-fill text-on-brand font-bold text-[15px]
                 tracking-wide py-4 disabled:opacity-45"
    >
      {children}
    </button>
  );
}

// =============================================================================
// Food-specific
// =============================================================================

/**
 * The veg / non-veg mark.
 *
 * A legal requirement in India, not decoration: FSSAI packaging and labelling
 * rules mandate a distinguishing mark, green for vegetarian and brown for
 * non-vegetarian. Rendered as an SVG rather than a coloured character so it
 * survives a font that does not have the glyph, and labelled for screen readers
 * because colour is never the only carrier of meaning (WCAG 1.4.1).
 */
export function VegMark({ flags }: { flags: string[] }) {
  const f = flags.map((x) => x.toUpperCase());
  const kind = f.includes('NON_VEG')
    ? 'nonveg'
    : f.includes('EGG')
      ? 'egg'
      : f.includes('VEG') || f.includes('JAIN')
        ? 'veg'
        : null;

  // No dietary information is not the same as vegetarian. Showing a green mark
  // on an unlabelled item is a claim we cannot support, and for a Jain or
  // vegetarian diner it is the one mistake that matters most.
  if (kind === null) return null;

  // The raw token names, not `--color-*`. Under `@theme inline` Tailwind does
  // not emit the `--color-*` layer at all, so reaching for it here would give a
  // dietary mark with no fill — invisible, on the one element in this app that
  // is a legal requirement rather than a design choice.
  const colour =
    kind === 'veg'
      ? 'var(--veg-500)'
      : kind === 'egg'
        ? 'var(--egg-500)'
        : 'var(--nonveg-500)';

  const label = kind === 'veg' ? 'Vegetarian' : kind === 'egg' ? 'Contains egg' : 'Non-vegetarian';

  return (
    <svg viewBox="0 0 16 16" className="size-[15px] shrink-0" role="img" aria-label={label}>
      <rect x="0.9" y="0.9" width="14.2" height="14.2" rx="2" fill="none" stroke={colour} strokeWidth="1.6" />
      {kind === 'nonveg' ? (
        // Brown mark is a triangle under the 2011 amendment, not a circle.
        <path d="M8 4.2l3.6 6.4H4.4z" fill={colour} />
      ) : (
        <circle cx="8" cy="8" r="3.5" fill={colour} />
      )}
    </svg>
  );
}

/**
 * The stand-in for a photograph.
 *
 * `menu_item.image_url` exists in the schema and no vendor has ever filled it,
 * so every tile on the pilot menu is this. It is built to look chosen rather
 * than missing: a deterministic two-tone gradient from a hash of the item name,
 * with the initial set large.
 *
 * Deterministic matters more than pretty. The same dish gets the same colours
 * on every screen and every reload, so a customer learns the shape of the menu
 * — which is most of what a photograph was doing.
 */
const TILE_PAIRS: readonly (readonly [string, string])[] = [
  ['#F6C177', '#E8483F'],
  ['#7FB77E', '#137A45'],
  ['#F2A65A', '#C4451C'],
  ['#8ECAE6', '#22668D'],
  ['#E8A0BF', '#B4436C'],
  ['#D4B483', '#8A6522'],
  ['#A5C882', '#4F772D'],
  ['#F2B5D4', '#9A4C95'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The same deterministic gradient, as a wide band rather than a square tile.
 *
 * For the stall card's hero when neither the stall's cover nor any of its
 * dishes has a photograph. Exported because it is now needed in two places and
 * the whole point is that the SAME name always produces the SAME colours — a
 * second implementation would break that on the one screen where a customer is
 * learning to recognise stalls by sight.
 *
 * 160deg rather than the tile's 135: across a 16:10 band a diagonal at 135°
 * puts the colour change in the corner, where the logo sits.
 */
export function coverGradient(name: string): string {
  const pair = TILE_PAIRS[hash(name) % TILE_PAIRS.length]!;
  return `linear-gradient(160deg, ${pair[0]}, ${pair[1]})`;
}

export function FoodTile({
  name,
  imageUrl,
  size = 'md',
  dimmed,
}: {
  name: string;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  dimmed?: boolean;
}) {
  const cls =
    size === 'lg' ? 'size-24' : size === 'sm' ? 'size-12' : 'size-[76px]';
  const pair = TILE_PAIRS[hash(name) % TILE_PAIRS.length]!;

  if (imageUrl) {
    return (
      <img
        // A SQUARE crop of a wide photo throws away a third of it. `cdn()` lets
        // Cloudinary decide which third, by finding the food first.
        src={cdn(imageUrl, 'tile') ?? imageUrl}
        alt=""
        loading="lazy"
        className={`${cls} rounded-tile object-cover shrink-0 ${dimmed ? 'opacity-45 grayscale' : ''}`}
      />
    );
  }

  return (
    <div
      // Decorative: the item's name is already the heading next to it, so
      // announcing an initial here would just be noise in a screen reader.
      aria-hidden
      className={`${cls} rounded-tile shrink-0 grid place-items-center ${
        dimmed ? 'opacity-40 grayscale' : ''
      }`}
      style={{ background: `linear-gradient(135deg, ${pair[0]}, ${pair[1]})` }}
    >
      <span className="text-white/95 font-bold text-2xl drop-shadow-sm">
        {name.trim().slice(0, 1).toUpperCase()}
      </span>
    </div>
  );
}

/**
 * The − N + control, overlapping the bottom of the tile.
 *
 * The overlap is the one piece of pure imitation here, and it earns its place:
 * it puts the action at the item's visual centre of gravity rather than at the
 * end of a row, so a thumb travelling down a menu barely moves sideways.
 */
export function AddControl({
  quantity,
  onAdd,
  onRemove,
  disabled,
  label,
}: {
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
  disabled?: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <div className="w-[92px] h-9 rounded-lg border border-ink-200 bg-ink-50 grid place-items-center">
        <span className="text-[11px] font-bold text-ink-400 tracking-wide">SOLD OUT</span>
      </div>
    );
  }

  if (quantity === 0) {
    return (
      <button
        onClick={onAdd}
        aria-label={`Add ${label}`}
        /* `brand-700` rather than `brand-600` for the label: red-on-white at
           brand-600 is 4.91:1, which passes, but brand-700 is 6.76:1 and this
           is 13px — the smallest text in the app that anyone has to act on. */
        className="pressable glass-hover w-[92px] h-9 rounded-lg bg-surface border border-brand-200
                   text-brand-700 font-bold text-[13px] tracking-wide shadow-add"
      >
        ADD
      </button>
    );
  }

  return (
    <div className="w-[92px] h-9 rounded-lg bg-surface border border-brand-200 shadow-add flex items-stretch overflow-hidden">
      <button
        onClick={onRemove}
        aria-label={`Remove one ${label}`}
        /* `rounded-none` is deliberate, not a leftover: the film needs a
           shape, and this button's shape is cut by the parent's
           `rounded-lg overflow-hidden`. Saying so keeps it out of the
           "unshaped element with a background" bucket the check below
           rejects. */
        className="pressable glass-hover rounded-none flex-1 text-brand-700 font-bold text-lg leading-none"
      >
        −
      </button>
      <span className="w-7 grid place-items-center text-brand-700 font-bold text-[13px] tnum">
        {quantity}
      </span>
      <button
        onClick={onAdd}
        aria-label={`Add one ${label}`}
        /* Square on purpose — clipped by the parent. See the − button. */
        className="pressable glass-hover rounded-none flex-1 text-brand-700 font-bold text-lg leading-none"
      >
        +
      </button>
    </div>
  );
}

/**
 * One stall, as a card.
 *
 * ============================================================================
 * WHAT THIS IS AND IS NOT COPIED FROM THE REFERENCE
 * ============================================================================
 *
 * Copied: the shape. A full-bleed photograph on top, the brand mark as a small
 * white tile overlapping its bottom-left, then name, cuisine tags joined by
 * bullets, and a prep time under a clock. That structure is right — it leads
 * with the only thing a hungry person actually evaluates, which is the food.
 *
 * NOT copied: the ★ 4.8.
 *
 * There is no rating anywhere in this platform — no reviews, no scores, nothing
 * to average. Rendering a number there would be inventing a fact about a real
 * business, and the failure mode is not symmetric: a stall could be marked down
 * by a rating nobody gave it, on the screen that decides whether anyone walks
 * over. So the slot carries the thing the platform genuinely knows and the
 * customer genuinely needs, which is whether the stall is taking orders at all.
 *
 * The prep time is the stall's OWN estimate and is phrased "about 15 min" for
 * that reason. The reference shows a range; a range here would mean inventing a
 * spread around a single stored number.
 */
export function StallCard({
  vendor,
  onOpen,
}: {
  vendor: {
    id: string;
    name: string;
    cuisine: string[];
    estimatedPrepMinutes: number;
    accepting: boolean;
    closedReason: string | null;
    coverImageUrl: string | null;
    logoUrl: string | null;
    typicalSpendPaise?: number | null;
    offerHeadline?: string | null;
    /** Dishes that matched a search. Absent outside search results. */
    matches?: { id: string; name: string; pricePaise: number; orderable: boolean }[];
  };
  onOpen: () => void;
}) {
  const v = vendor;
  const matches = v.matches ?? [];

  return (
    <button
      disabled={!v.accepting}
      onClick={onOpen}
      className="pressable group w-full text-left disabled:cursor-default"
    >
      <div className="rounded-card bg-surface shadow-card overflow-hidden">
        {/*
          THE HERO SHORTENS AS THE GRID WIDENS.

          The reference is a phone: one column, and a tall 16:10 photograph is
          exactly right when it is the only thing on screen. Carrying that ratio
          into a three-column desktop grid produces a wall of photographs with
          every stall's NAME pushed below the fold — the images stop being
          appetising and become an obstacle between the customer and the list.

          So the ratio is a function of the column count, not a constant.
        */}
        <div className="relative h-40 sm:h-44 lg:h-48 overflow-hidden">
          {v.coverImageUrl ? (
            <img
              src={v.coverImageUrl}
              alt=""
              loading="lazy"
              className={`size-full object-cover transition-transform duration-300 ${
                v.accepting
                  ? 'motion-safe:group-hover:scale-[1.03]'
                  : 'opacity-45 grayscale'
              }`}
            />
          ) : (
            <div
              aria-hidden
              className={`size-full ${v.accepting ? '' : 'opacity-40 grayscale'}`}
              style={{ background: coverGradient(v.name) }}
            />
          )}

          {/*
            A scrim under the logo tile only, not across the whole image.
            A full-image gradient is the reflex here and it dulls every
            photograph on the screen to make one 48px corner legible. The tile
            carries its own surface and its own shadow instead.
          */}
          {/*
            The mark moves out of the offer's way rather than overlapping it.

            Bottom-left is its home — it is where every delivery app puts a
            brand mark and it sits on the calmest part of a food photograph. But
            that is exactly where the offer headline now goes, and two things
            fighting for one corner is worse than either being slightly wrong.
            With an offer it goes top-left; without one it stays put.
          */}
          <div
            className={`absolute left-3 size-12 rounded-xl bg-surface shadow-card grid place-items-center overflow-hidden ${
              v.offerHeadline ? 'top-3' : 'bottom-3'
            }`}
          >
            {v.logoUrl ? (
              <img src={v.logoUrl} alt="" loading="lazy" className="size-full object-contain p-1" />
            ) : (
              // The initial, in the display serif. A stall with no logo gets
              // something that looks like a mark rather than a gap.
              <span aria-hidden className="display text-[20px] text-ink-700">
                {v.name.trim().slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>

          {/*
            THE OFFER, ACROSS THE FOOT OF THE PHOTOGRAPH.

            It was a small pill in the top corner. The reference puts it large
            and bottom-left, and that is the better call for a reason beyond
            taste: the top corner of a food photograph is usually the busiest
            part of it — plates, hands, a counter — while the bottom is
            tablecloth. A pill fighting a photograph loses; a gradient with type
            on it does not.

            Fixed white on a black gradient rather than theme tokens. This sits
            on a photograph in both themes and must not invert with the palette.

            It advertises — no discount is applied at checkout. The stall is
            making a claim about its own menu pricing.
          */}
          {v.offerHeadline ? (
            <>
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-2/5"
                style={{
                  background: 'linear-gradient(to top, rgb(0 0 0 / 0.85), rgb(0 0 0 / 0))',
                }}
              />
              <span className="absolute left-4 right-4 bottom-3 text-[19px] font-black text-white leading-tight truncate">
                {v.offerHeadline}
              </span>
            </>
          ) : null}
        </div>

        <div className="px-4 pt-3.5 pb-4">
          <div className="flex items-start gap-3">
            <p
              className={`min-w-0 flex-1 font-bold text-[16px] leading-snug truncate ${
                v.accepting ? 'text-ink-900' : 'text-ink-500'
              }`}
            >
              {v.name}
            </p>

            {/* Where the reference puts the rating. See the header. */}
            <span className="shrink-0">
              {v.accepting ? (
                <Pill tone="good">Open</Pill>
              ) : (
                // Colour is never the only signal, and the copy never says the
                // tablet is the problem — PRD §16.2, ESC-02.
                <Pill tone="neutral">
                  {v.closedReason === 'paused' ? 'Paused' : 'Closed'}
                </Pill>
              )}
            </span>
          </div>

          {/*
            Cuisine and a typical spend, as the reference's
            "Bengali, North Indian · ₹250 for one".

            `·` rather than `•` — at 13px the heavier bullet reads as a list
            marker and pulls the eye off the words it separates.

            The spend is the MEDIAN item price rounded to ten rupees, and the
            "about" is load-bearing: it is a description of a menu, not a quote,
            and a customer who reads it as a promise will feel misled by a
            ₹340 basket.
          */}
          {v.cuisine.length > 0 || v.typicalSpendPaise ? (
            <p className="text-[13px] text-ink-500 truncate mt-1">
              {[
                v.cuisine.join(','),
                v.typicalSpendPaise
                  ? `about ${formatINR(v.typicalSpendPaise)} for one`
                  : null,
              ]
                .filter(Boolean)
                .join(' ·')}
            </p>
          ) : null}

          <div className="flex items-center gap-1.5 mt-2.5">
            <svg viewBox="0 0 24 24" className="size-4 text-ink-400 shrink-0" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M12 7.5V12l3 1.8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[13px] text-ink-500 tnum">
              {/* The stall's own estimate, not a promise made on its behalf. */}
              about {v.estimatedPrepMinutes} min
            </span>
          </div>

          {/*
            WHY THIS STALL IS IN THE RESULTS.

            Without it a dish search is a puzzle: you type "momo", get Spice
            Garden, and have to open it to find out whether that was a real
            match or a fuzzy one on the stall's name. Naming the dishes answers
            that in place — and carries the price, which is the next thing
            anybody wants, so comparing three stalls no longer means opening
            three menus.

            A sold-out match is shown struck through rather than hidden. The
            stall genuinely does sell it, which is worth knowing, and silently
            dropping it would leave a card in the results with nothing
            explaining why.
          */}
          {matches.length > 0 ? (
            <ul className="mt-3 pt-3 border-t border-ink-100 space-y-1.5">
              {matches.map((m) => (
                <li key={m.id} className="flex items-baseline gap-2 text-[13px]">
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      m.orderable ? 'text-ink-800' : 'text-ink-400 line-through'
                    }`}
                  >
                    {m.name}
                  </span>
                  <span
                    className={`shrink-0 tnum font-semibold ${
                      m.orderable ? 'text-ink-900' : 'text-ink-400'
                    }`}
                  >
                    {formatINR(m.pricePaise)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </button>
  );
}

/**
 * The offer carousel.
 *
 * ============================================================================
 * IT ADVERTISES. IT DOES NOT DISCOUNT.
 * ============================================================================
 *
 * `order.discount_paise` exists and `computeQuote` already subtracts it, so a
 * real discount would be a short change — and it would force a decision nobody
 * has made: who funds it. So these banners are the stall's own claim about its
 * own menu pricing, and the checkout is untouched.
 *
 * WHY THE HEADLINE IS STILL REQUIRED, NOW THAT IT IS NOT SHOWN
 *
 * There was a caption under each banner repeating the headline and naming the
 * stall. It is gone — the artwork already says both, in the stall's own design,
 * and a line of grey text under a poster was the app talking over it.
 *
 * `headline` did not become optional when the caption did. It is the image's
 * ALT text, and a database CHECK still refuses artwork without one, because an
 * offer that exists only as a JPEG is invisible to a screen reader and to
 * anybody whose image never loaded — which in a basement food court is common
 * rather than exotic. The carousel is the first thing on the screen; it must
 * not be the first thing that fails silently.
 *
 * Removing the caption made that MORE load-bearing, not less: the alt text is
 * now the only textual form the offer has anywhere in the client.
 *
 * SCROLL-SNAP, NOT A TIMER
 *
 * No auto-advance. A banner that moves on its own steals the tap of anybody
 * reaching for it, and it is the single most complained-about pattern in
 * food-delivery apps. The customer scrolls; the dots say how far along they are.
 */
export function OfferCarousel({
  offers,
  onOpen,
}: {
  offers: { vendorId: string; vendorName: string; imageUrl: string; headline: string }[];
  onOpen: (vendorId: string, vendorName: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);

  if (offers.length === 0) return null;

  return (
    <div>
      {/*
        ONE BANNER AT A TIME, FULL WIDTH, AT EVERY SIZE.

        It used to be a three-across rail: `w-[85%] sm:w-[46%] lg:w-[31%]`, the
        peek-the-next-card pattern the stall cards use. That is right for CARDS,
        which are a set you compare — and wrong for a banner, which is a single
        piece of artwork somebody designed. At 31% of a wide window it rendered
        the stall's poster four inches across with its own headline unreadable
        inside it, and on a phone it stopped short of the edge for no reason a
        customer could see.

        Each slide is `w-full` and the rail snaps, so several offers are a swipe
        rather than a squeeze.
      */}
      <div
        ref={rail}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Rounded, not floored: a snap that lands a pixel short would keep
          // the dot on the previous slide.
          setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
        /* EDGE TO EDGE ON A PHONE. The negative margin cancels the body's
           `px-4`, so the artwork touches both sides of the screen the way it
           does in every delivery app — and returns to the content width at
           `md`, where a banner spanning a 1400px window with no margin reads as
           a mis-set image rather than a design. */
        className="flex overflow-x-auto no-scrollbar snap-x snap-mandatory -mx-4 md:mx-0"
        role="region"
        aria-label="Offers"
      >
        {offers.map((o) => (
          <button
            key={o.vendorId}
            onClick={() => onOpen(o.vendorId, o.vendorName)}
            className="pressable snap-start shrink-0 w-full"
          >
            {/*
              NO FIXED RATIO, AND NO CROP.

              The obvious thing is a fixed `aspect-[2/1]` with `object-cover`,
              and it destroys the one asset this component exists to show. The
              artwork in these slots is designed — a headline in the middle, a
              starburst in a corner, a ribbon along the bottom — and cropping to
              a ratio the stall did not design for cuts the corners off. A
              letterbox with `object-contain` is the mirror of the same problem:
              bands of dead colour where the stall put a picture of food.

              So the banner is shown at ITS OWN shape, full width, and the page
              accommodates it. `max-h` is the only guard, for the stall that
              uploads something nearly square and would otherwise render a
              1400px-tall wall on a desktop.
            */}
            <img
              src={o.imageUrl}
              // The headline IS the alt text, not a caption — and now that
              // there is no text under the artwork it is the ONLY text. A
              // database CHECK refuses an image without one, which is what
              // makes that safe to rely on.
              alt={`${o.vendorName}: ${o.headline}`}
              loading="lazy"
              className="w-full h-auto max-h-[26rem] object-contain bg-ink-100 md:rounded-card"
            />
          </button>
        ))}
      </div>

      {/*
        DOTS, ONLY WHEN THERE IS SOMEWHERE TO GO.

        A full-width slide hides the fact that a second one exists — the peek of
        the next card used to do that job for free, and making the banner full
        width took it away. One dot under a single offer would be chrome
        describing nothing.

        No auto-advance. A banner that moves on its own steals the tap of
        anybody reaching for it, and it is the most complained-about pattern in
        food-delivery apps.
      */}
      {offers.length > 1 ? (
        <div className="flex justify-center gap-1.5 mt-2.5">
          {offers.map((o, i) => (
            <button
              key={o.vendorId}
              onClick={() =>
                rail.current?.scrollTo({ left: i * rail.current.clientWidth, behavior: 'smooth' })
              }
              aria-label={`Offer ${i + 1} of ${offers.length}`}
              aria-current={i === at ? 'true' : undefined}
              className={`pressable rounded-full transition-all ${
                i === at ? 'w-5 h-1.5 bg-ink-700' : 'size-1.5 bg-ink-200'
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Search: an icon until it is wanted, a field once it is.
 *
 * ============================================================================
 * WHY IT COLLAPSES
 * ============================================================================
 *
 * A permanently-open search box is a wide, bright, empty rectangle sitting
 * across the most valuable strip of the screen, every visit, for a feature most
 * people never use. It was also visually the loudest thing in the bar, which
 * made the bar read as a search page with a court name attached.
 *
 * So it is a word and an icon, and it becomes a field when somebody means it.
 *
 * ============================================================================
 * CLOSING CLEARS THE TERM, AND THAT IS NOT TIDINESS
 * ============================================================================
 *
 * A collapsed box holding "momo" would filter the whole page with nothing on
 * screen explaining why. The customer sees three stalls in a court they know
 * has nine, and the only evidence is inside a control they have shut. Every
 * route out — the ×, Escape, clicking away from an empty field — clears.
 *
 * The one that does NOT close is clicking away from a field with text in it.
 * Somebody who typed a term and tapped a card is coming back to those results,
 * and throwing them away because focus moved is the same bug wearing a hat.
 */
export function CollapsibleSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  /*
   * ==========================================================================
   * IT ONLY COLLAPSES ON A WIDE WINDOW
   * ==========================================================================
   *
   * The argument for collapsing is about a DESKTOP bar: a permanently-open box
   * there is a wide bright rectangle across the most valuable strip of the
   * screen, competing with the court name, for something most people never use.
   *
   * None of that is true on a phone. The field gets its own full-width row
   * under the title — the shape every delivery app in India uses — where an
   * open box is exactly the right size for its row and costs nothing that was
   * being used for something else. Collapsing it there just hides the one
   * control on the screen that answers "do they have momos", behind a tap.
   *
   * ONE COMPONENT, NOT TWO RENDERED AND ONE HIDDEN. See `useMediaQuery`: two
   * inputs for one purpose means a screen reader announcing the search twice,
   * focus landing in the invisible one, and a half-typed term lost on rotation.
   */
  const wide = useMediaQuery(MD);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const close = (): void => {
    onChange('');
    setOpen(false);
  };

  if (wide && !open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          // After paint, or the element does not exist yet to focus.
          requestAnimationFrame(() => input.current?.focus());
        }}
        className="pressable glass-hover shrink-0 flex items-center gap-2 h-11 rounded-xl px-3 text-ink-700"
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {/* The word as well as the glyph. A lone magnifier is guessable and a
            labelled one is not a guess — and it gives the button a hit area
            worth aiming at with a thumb. */}
        <span className="text-[14px] font-semibold">Search</span>
      </button>
    );
  }

  /*
   * OPEN, IT GROWS — BUT ONLY SO FAR.
   *
   * `flex-1 min-w-0` so on a phone it takes the whole row it was given, and
   * `max-w-sm` so on a 1440px desktop it does NOT stretch into the same wide
   * bright rectangle this component exists to avoid. Growing without a cap
   * would make opening the search reproduce the exact layout it replaced.
   *
   * `min-w-0` is what lets a flex child shrink below its content width; without
   * it the input pushes the veg toggle off the end of a narrow bar.
   */
  return (
    // `max-w-sm` only once there is a bar to be too wide in. On a phone this is
    // its own row and the field should fill it.
    <div className="relative flex-1 min-w-0 md:max-w-sm">
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
        ref={input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        enterKeyHint="search"
        // Only an EMPTY field closes itself. See the header: a term the
        // customer is still using must survive them tapping a card.
        onBlur={() => {
          // Only where a collapsed form exists to return to. On a phone this
          // field IS the row; closing it would leave a gap.
          if (wide && value.trim() === '') setOpen(false);
        }}
        placeholder={placeholder}
        aria-label="Search dishes, stalls or cuisine"
        className="w-full h-11 rounded-xl border border-ink-200 bg-ink-50 text-ink-900
                   pl-11 pr-11 text-[15px] placeholder:text-ink-400 outline-none
                   focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
      />

      {/*
        The × CLEARS on a phone and CLOSES on a desktop, and on a phone it is
        absent until there is something to clear — an × on an empty field that
        is permanently open does nothing at all, which is the worst kind of
        button.

        NOT RENDERED, rather than the `hidden` ATTRIBUTE. Tailwind's preflight
        sets `[hidden] { display: none }` in the base layer and `.grid` sets
        `display: grid` in utilities; equal specificity, later layer wins, so
        the attribute would have been silently ignored on exactly this element.
      */}
      {wide || value !== '' ? (
      <button
        onClick={close}
        aria-label={wide ? 'Close search' : 'Clear search'}
        className="pressable glass-hover absolute right-1 top-1/2 -translate-y-1/2 size-9 grid place-items-center rounded-lg text-ink-500"
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      ) : null}
    </div>
  );
}

/**
 * A titled horizontal rail with arrows on desktop.
 *
 * ============================================================================
 * SCROLL ON TOUCH, ARROWS ON A POINTER — BOTH, NOT EITHER
 * ============================================================================
 *
 * A phone already has the gesture: a rail is just an overflowing row and a
 * thumb does the rest. A mouse does not — dragging a horizontal scroller with a
 * cursor is awkward, a trackpad's sideways scroll is a setting many people have
 * never used, and a rail with no visible control on a laptop reads as a row
 * that has been cut off rather than one you can move.
 *
 * So the arrows appear only under `(hover: hover) and (pointer: fine)`, which
 * is the same guard the `.pressable` hover state uses. Never both a scrollbar
 * and a control the touch user cannot benefit from.
 *
 * `scroll-snap` on the children so a flick lands on a card edge rather than
 * halfway through a photograph.
 */
export function Rail({
  title,
  children,
  ariaLabel,
}: {
  title?: string;
  children: ReactNode;
  ariaLabel: string;
}) {
  const track = useRef<HTMLDivElement>(null);

  const nudge = (dir: -1 | 1): void => {
    const el = track.current;
    if (!el) return;
    // 80% of the viewport, not 100%: leaving a sliver of the previous card
    // visible is what tells somebody the rail moved rather than replaced itself.
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <section aria-label={ariaLabel}>
      {title ? (
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="display text-[20px] md:text-[24px] text-ink-900">{title}</h2>

          {/* `hidden` until a fine pointer exists. `can-hover:` is not a
              Tailwind default, so this uses the arbitrary variant rather than
              inventing a class the design token test cannot see. */}
          <div className="hidden [@media(hover:hover)and(pointer:fine)]:flex gap-2 shrink-0">
            {([-1, 1] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => nudge(dir)}
                aria-label={dir === -1 ? 'Scroll left' : 'Scroll right'}
                className="pressable glass-hover size-9 grid place-items-center rounded-full bg-ink-100 text-ink-700"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                  <path
                    d={dir === -1 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/*
        Bleeds to the frame edge so a card can sit half off-screen — the
        strongest possible hint that a row continues.

        `py-1.5 -my-1.5` IS NOT SPACING. It is headroom.

        `overflow-x: auto` does not stay on one axis: per spec, when one axis is
        `visible` and the other is not, the visible one computes to `auto` as
        well. So this scroller clips VERTICALLY too, and anything a child draws
        outside its own box is cut off — which is exactly what happened to the
        selected category's ring, sheared flat across the top.

        The padding gives that decoration room inside the scroll box and the
        matching negative margin takes it back out of the layout, so the row
        still sits where it did. Any future ring, shadow or hover scale on a
        rail child gets the same headroom for free.

        ==================================================================
        `scroll-px-*` IS NOT DECORATION. WITHOUT IT `px-4` DOES NOTHING.
        ==================================================================

        The first circle sat flush against the left edge of the screen while
        every heading on the page began 16px in. The padding was right there in
        the class string and it was being scrolled out from under itself.

        Scroll snapping aligns a `snap-start` child against the container's
        SNAPPORT, and the snapport is the scrollport — the PADDING box —
        reduced by `scroll-padding`. `scroll-padding` defaults to zero, so the
        snapport began at the padding box edge, 16px to the LEFT of where
        `padding-left` puts the first item. The browser resolved that by
        scrolling the track 16px to bring the child flush with the snapport,
        which parks the left padding off-screen. The padding is applied, it is
        simply hidden underneath the scroll offset.

        `scroll-px-*` pulls the snapport in to match, so the snap position and
        the padding agree and the rail's first item lines up with the headings
        above it. It must track `px-*` at every breakpoint — a mismatch here is
        invisible until somebody looks at the left edge on a phone.

        This is also why the offer carousel above does not need it: that one
        genuinely bleeds to the frame edge and carries no padding to protect.
      */}
      <div
        ref={track}
        className="flex gap-4 overflow-x-auto no-scrollbar snap-x scroll-smooth py-1.5 -my-1.5 -mx-4 px-4 scroll-px-4 md:-mx-6 md:px-6 md:scroll-px-6"
      >
        {children}
      </div>
    </section>
  );
}

/**
 * "What's on your mind?" — a circle of food per category.
 *
 * ============================================================================
 * THE PHOTOGRAPH IS THE CONTROL
 * ============================================================================
 *
 * These were text pills, and the reference is right that they should not be.
 * "Biryani" as a word is a filter; a photograph of biryani is an appetite, and
 * the row is near the top of the screen precisely to do the second thing.
 *
 * Each image is a real dish from this court carrying that label — matched
 * server-side on the menu category first and the dish name second. Stock art
 * would have been easier and wrong: a generic curry above a chip that filters
 * to this court's actual food is a promise made by a stock library.
 *
 * Null falls back to the deterministic gradient with an initial, which is the
 * same treatment a dish with no photo gets everywhere else in the app.
 */
export function CategoryRail({
  categories,
  active,
  onPick,
}: {
  categories: { label: string; imageUrl: string | null }[];
  active: string | null;
  onPick: (category: string | null) => void;
}) {
  if (categories.length === 0) return null;

  return (
    <Rail title="What's on your mind?" ariaLabel="Filter by category">
      {/* "All" is a category too, and giving it the same shape keeps the row
          one row. A text button beside a line of circles reads as chrome. */}
      <button
        onClick={() => onPick(null)}
        aria-pressed={active === null}
        className="pressable snap-start shrink-0 w-[84px] text-center"
      >
        {/*
          "Everything" chosen is frosted ink, not a red disc.

          It keeps `bg-ink-100` underneath in BOTH states, so the chip does not
          change colour family when you pick it — `.glass-on` composites over
          the same base and adds the edge. That is what makes the selected and
          unselected versions read as one control in two states rather than two
          different buttons.
        */}
        <span
          className={`block size-[84px] rounded-full grid place-items-center border transition-colors ${
            active === null
              ? 'glass-on bg-ink-100 text-ink-900 border-transparent'
              : 'bg-ink-100 text-ink-700 border-transparent'
          }`}
        >
          <span className="eyebrow text-[11px]">All</span>
        </span>
        <span
          className={`block text-[13px] mt-2 truncate ${
            active === null ? 'font-bold text-ink-900' : 'text-ink-500'
          }`}
        >
          Everything
        </span>
      </button>

      {categories.map((c) => {
        const on = active === c.label;
        return (
          <button
            key={c.label}
            onClick={() => onPick(on ? null : c.label)}
            aria-pressed={on}
            className="pressable snap-start shrink-0 w-[84px] text-center"
          >
            <span
              className={`block size-[84px] rounded-full overflow-hidden grid place-items-center ${
                // A ring rather than a fill: the photograph is the content and
                // tinting it would fight the food it is showing.
                //
                // Frosted rather than red, and here that is more than a palette
                // preference — a red circle drawn around a photograph of food
                // is the one place red genuinely fails to register, because
                // half the pictures in this rail already have red in them.
                // `.glass-ring` layers a bright hairline over a soft halo, so
                // it separates from a busy image without competing with it.
                on ? 'glass-ring' : ''
              }`}
              style={c.imageUrl ? undefined : { background: coverGradient(c.label) }}
            >
              {c.imageUrl ? (
                <img src={c.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <span aria-hidden className="display text-[28px] text-white/95">
                  {c.label.trim().slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <span
              className={`block text-[13px] mt-2 truncate ${
                on ? 'font-bold text-ink-900' : 'text-ink-500'
              }`}
            >
              {c.label}
            </span>
          </button>
        );
      })}
    </Rail>
  );
}

/**
 * A stall the court is leading with. Photograph first, text over it.
 *
 * THE BADGE IS A FACT, NOT A DECORATION.
 *
 * The reference put a star rating here. There is no rating data in this
 * platform, so the slot carries the two things genuinely known — the most
 * orders actually taken this week, and the shortest prep estimate among stalls
 * open right now. Both are computed server-side in the vendor list.
 *
 * THE SCRIM IS A GRADIENT AND IT IS NOT OPTIONAL.
 *
 * White text over an unknown photograph is unreadable roughly half the time —
 * a shot of a pale thali will swallow it entirely. The gradient guarantees a
 * dark band under the text whatever the image turns out to be, which is why it
 * is a fixed black rather than a theme token: it is compensating for the
 * PHOTOGRAPH, not participating in the theme.
 */
export function TrendingCard({
  vendor,
  badge,
  onOpen,
}: {
  vendor: {
    name: string;
    cuisine: string[];
    estimatedPrepMinutes: number;
    coverImageUrl: string | null;
  };
  badge: 'POPULAR' | 'QUICKEST';
  onOpen: () => void;
}) {
  return (
    <button onClick={onOpen} className="pressable group w-full text-left">
      <div className="relative overflow-hidden rounded-card aspect-[4/3] sm:aspect-[16/10]">
        {vendor.coverImageUrl ? (
          <img
            src={vendor.coverImageUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.04]"
          />
        ) : (
          <div
            aria-hidden
            className="size-full"
            style={{ background: coverGradient(vendor.name) }}
          />
        )}

        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgb(0 0 0 / 0.82) 0%, rgb(0 0 0 / 0.45) 32%, rgb(0 0 0 / 0) 62%)',
          }}
        />

        <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 eyebrow text-[10px] text-ink-900">
            {badge === 'QUICKEST' ? (
              <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
                <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
                <path d="M12 2l2.9 6.3 6.8.8-5 4.7 1.3 6.8L12 17.3 6 20.6l1.3-6.8-5-4.7 6.8-.8L12 2z" />
              </svg>
            )}
            {badge === 'QUICKEST' ? 'Quickest' : 'Popular'}
          </span>

          {/* Fixed white, not `text-ink-900`. This text sits on a photograph in
              both themes, so it must not invert with the palette. */}
          <p className="display text-[26px] sm:text-[30px] text-white mt-2.5 leading-tight">
            {vendor.name}
          </p>

          <div className="flex items-center gap-3 mt-1.5 text-[13px] text-white/85">
            {vendor.cuisine.length > 0 ? (
              <span className="truncate">{vendor.cuisine.join(' ·')}</span>
            ) : null}
            <span className="flex items-center gap-1.5 shrink-0 tnum">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M12 7.5V12l3 1.8"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              {vendor.estimatedPrepMinutes} min
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

/**
 * Every other stall, as a compact row.
 *
 * The reference is explicit that the big photograph belongs to Trending and the
 * main list does not get one: a small square mark, the name, the cuisine, and
 * the state on the right. That is the correct division — twelve full-bleed
 * photo cards is a scroll, not a list, and the customer reading this section
 * has already decided against the two the court is leading with.
 */
export function StallRow({
  vendor,
  onOpen,
}: {
  vendor: {
    name: string;
    cuisine: string[];
    estimatedPrepMinutes: number;
    accepting: boolean;
    closedReason: string | null;
    opensAt: string | null;
    opensToday: boolean | null;
    coverImageUrl: string | null;
    logoUrl: string | null;
  };
  onOpen: () => void;
}) {
  const v = vendor;
  const mark = v.logoUrl ?? v.coverImageUrl;

  return (
    <button
      disabled={!v.accepting}
      onClick={onOpen}
      className="pressable w-full text-left disabled:cursor-default"
    >
      <div className="rounded-card bg-surface shadow-card p-3.5 flex items-center gap-3.5">
        <div
          className={`size-14 shrink-0 rounded-xl overflow-hidden grid place-items-center ${
            v.accepting ? '' : 'opacity-45 grayscale'
          }`}
          style={mark ? undefined : { background: coverGradient(v.name) }}
        >
          {mark ? (
            <img src={mark} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <span aria-hidden className="display text-[22px] text-white/95">
              {v.name.trim().slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={`font-bold text-[15px] leading-snug truncate ${
              v.accepting ? 'text-ink-900' : 'text-ink-500'
            }`}
          >
            {v.name}
          </p>
          {v.cuisine.length > 0 ? (
            <p className="text-[13px] text-ink-500 truncate mt-0.5">{v.cuisine.join(' ·')}</p>
          ) : null}
        </div>

        <div className="shrink-0 text-right">
          {v.accepting ? (
            <>
              <Pill tone="good">Open</Pill>
              <p className="text-[12px] text-ink-500 tnum mt-1.5">{v.estimatedPrepMinutes} min</p>
            </>
          ) : (
            <>
              <Pill tone="neutral">
                {v.closedReason === 'paused' ? 'Paused' : 'Closed'}
              </Pill>
              {/*
                The one closed state that can say WHEN.
                A paused or blocked stall has a problem somebody is dealing
                with; a stall outside its hours is behaving exactly as intended,
                and telling the customer to come back at five is the single most
                useful thing this row can do.
              */}
              <p className="text-[12px] text-ink-500 tnum mt-1.5">
                {v.opensAt
                  ? v.opensToday
                    ? `Opens ${to12Hour(v.opensAt)}`
                    : `Opens ${to12Hour(v.opensAt)} tomorrow`
                  : 'Not taking orders'}
              </p>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

/** `17:00` → `5:00 PM`. The server speaks 24-hour; India reads 12. */
function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

/** A small status pill. Text always states the meaning; colour only reinforces. */
export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const tones = {
    neutral: 'bg-ink-100 text-ink-700',
    good: 'bg-fresh-50 text-fresh-700',
    warn: 'bg-warn-50 text-warn-700',
    bad: 'bg-alert-50 text-alert-500',
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
  interactive,
}: {
  children: ReactNode;
  className?: string;
  /**
   * The card is the clickable thing — give it a hover film.
   *
   * A prop rather than `className="glass-hover"` at the call site, because the
   * film needs the RADIUS to know what shape to be, and the radius lives in
   * here. A caller passing `glass-hover` alone is passing half a treatment, and
   * the missing half is invisible until somebody hovers it — which is exactly
   * how the category chips ended up with rectangles behind them.
   *
   * These cards sit INSIDE a `pressable` button and cover it completely, so the
   * button's own hover would never be seen. Same pointer, same moment.
   */
  interactive?: boolean;
}) {
  return (
    <div
      className={`bg-surface rounded-card shadow-card ${interactive ? 'glass-hover' : ''} ${
        className ?? ''
      }`}
    >
      {children}
    </div>
  );
}

// =============================================================================
// Confirm
// =============================================================================

/**
 * The one place this app stops and asks.
 *
 * It replaces a `window.confirm`, which is the worst of the native dialogs
 * because of WHERE it appeared: on a customer's phone, mid-journey, styled by
 * the browser. On Android Chrome that is a grey slab with a URL in it. Anybody
 * who has been phished recognises the shape, and the one moment this app asks a
 * customer to trust it was rendered in the chrome of a page they did not open.
 *
 * It also cannot say the thing that matters. `confirm` gives one blob of text
 * and two buttons labelled by the OS — "OK" and "Cancel". "OK" is the wrong
 * word for "yes, throw away my basket", and it is the DEFAULT-looking one.
 *
 * SO: the destructive choice is the plain button and the safe one is filled.
 * Both say what they do. Dismissing by scrim or Escape keeps the basket, which
 * is the outcome somebody who taps away by accident meant to have.
 *
 * BOTTOM-ANCHORED ON A PHONE, CENTRED ABOVE IT. A dialog vertically centred on
 * a 6-inch screen puts its buttons where no thumb reaches.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Keep looking',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-40 bg-scrim flex items-end sm:items-center justify-center p-3 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-sm rounded-card bg-surface shadow-card p-5 safe-bottom"
      >
        <h2 id="confirm-title" className="text-[17px] font-bold text-ink-900 leading-tight">
          {title}
        </h2>
        <p className="text-[14px] text-ink-500 mt-2 leading-relaxed">{body}</p>

        <div className="mt-5 space-y-2">
          {/* The SAFE choice is the filled one and sits first, under the thumb.
              `window.confirm` put the destructive action behind the button
              labelled "OK", which reads as agreement rather than as loss. */}
          <button
            onClick={onCancel}
            className="pressable glass-hover w-full rounded-xl bg-brand-fill text-on-brand font-bold text-[15px] py-3.5"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="pressable glass-hover w-full rounded-xl border border-ink-200 bg-surface text-ink-700
                       font-semibold text-[14px] py-3"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ============================================================================
 * THE DISH SHEET — a dish, at the size somebody decides at
 * ============================================================================
 *
 * The menu row gives a description two lines and then clamps it. That is the
 * right call for a list somebody is scanning, and it is the wrong one at the
 * moment they stop on a dish and want to know what it actually is — which is
 * precisely when the sentence the stall paid to have written gets cut off.
 *
 * So the row stays as it is and tapping it opens this: the photograph large
 * enough to be worth having, the full description, and ADD in reach.
 *
 * ----------------------------------------------------------------------------
 * WHY THE WHOLE ROW IS NOT THE BUTTON
 * ----------------------------------------------------------------------------
 *
 * The row already contains ADD and, once something is in the basket, a −/+
 * stepper. Nesting those inside a larger button is invalid HTML and, worse,
 * ambiguous to a screen reader and to a thumb: tapping + near its edge would
 * open a sheet instead of adding a second momo. The photograph and the text
 * block open the sheet; the controls stay controls.
 *
 * ----------------------------------------------------------------------------
 * A DIALOG, WITH THE THINGS THAT MAKES IT ONE
 * ----------------------------------------------------------------------------
 *
 * Escape closes it, the background stops scrolling underneath it, a backdrop
 * click dismisses it, and it is labelled by the dish name so a screen reader
 * announces what opened rather than "dialog". None of that is decoration —
 * a modal without them is a div that happens to be on top.
 */
export function DishSheet({
  item,
  quantity,
  onAdd,
  onRemove,
  onClose,
}: {
  item: {
    name: string;
    description: string | null;
    pricePaise: number;
    imageUrl: string | null;
    dietaryFlags: string[];
    available: boolean;
    bestseller?: boolean;
  };
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const img = cdn(item.imageUrl, 'card');

  return (
    <div
      className="fixed inset-0 z-40 bg-scrim flex items-end sm:items-center justify-center p-3 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dish-sheet-title"
        className="w-full max-w-md rounded-card bg-surface shadow-dialog overflow-hidden safe-bottom
                   max-h-[90dvh] flex flex-col"
      >
        {/*
          The photograph, in a fixed 4:3 box.

          A RATIO, not a height. The images arrive in whatever shape a phone
          took them, and letting each one set its own height makes the sheet
          jump to a different size per dish. `object-cover` inside a fixed ratio
          crops consistently — and the CDN has already cropped around the food
          with `g_auto`, so the interesting part survives.
        */}
        {img ? (
          <div className="relative shrink-0 aspect-[4/3] w-full bg-ink-100">
            <img src={img} alt="" className="absolute inset-0 size-full object-cover" />

            {/*
              The close control sits ON the photograph, which means it has no
              predictable background — a dark button vanishes on a dark curry
              and a light one vanishes on a plate. A frosted disc takes its
              contrast from whatever is behind it, which is the one thing that
              works over an arbitrary image.
            */}
            <button
              onClick={onClose}
              aria-label="Close"
              className="pressable glass-action glass-action-ink absolute top-3 right-3 size-9 grid place-items-center
                         rounded-full text-page"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ) : null}

        <div className="p-5 overflow-y-auto">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <VegMark flags={item.dietaryFlags} />
                {item.bestseller && item.available ? (
                  <span className="inline-flex items-center gap-1 eyebrow text-[10px] text-brand-700">
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
                      <path d="M12 2.5l2.7 5.9 6.3.8-4.7 4.4 1.3 6.4L12 16.8 6.4 20l1.3-6.4L3 9.2l6.3-.8z" />
                    </svg>
                    Bestseller
                  </span>
                ) : null}
              </div>

              <h2
                id="dish-sheet-title"
                className="font-bold text-[19px] leading-snug text-ink-900 mt-2"
              >
                {item.name}
              </h2>

              <p className="text-[16px] font-bold text-ink-900 mt-1.5 tnum">
                {formatINR(item.pricePaise)}
              </p>
            </div>

            {/*
              No photograph means no close button above, so one is needed here.
              Rendering both would put two dismiss controls in one dialog.
            */}
            {!img ? (
              <button
                onClick={onClose}
                aria-label="Close"
                className="pressable glass-hover shrink-0 size-9 grid place-items-center rounded-full
                           bg-ink-100 text-ink-700"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </div>

          {/*
            NOT clamped here. This is the whole reason the sheet exists — if the
            description were truncated in the place somebody opened to read it,
            the sheet would do nothing the row did not already do.
          */}
          {item.description ? (
            <p className="text-[14px] text-ink-500 mt-3.5 leading-relaxed">{item.description}</p>
          ) : null}

          <div className="mt-5">
            {!item.available ? (
              /* Colour is never the only signal — this reads the same in
                 monochrome and to somebody who cannot distinguish the red. */
              <p className="text-[14px] font-semibold text-ink-400 text-center py-3">
                Not available right now
              </p>
            ) : quantity === 0 ? (
              <button
                onClick={onAdd}
                className="pressable glass-action w-full rounded-xl py-3.5 text-[15px] font-bold text-on-brand"
              >
                ADD
              </button>
            ) : (
              <div className="flex items-center justify-between gap-4 rounded-xl bg-ink-50 p-2">
                <button
                  onClick={onRemove}
                  aria-label={`Remove one ${item.name}`}
                  className="pressable glass-hover size-11 grid place-items-center rounded-lg
                             bg-surface text-ink-900 font-bold text-[20px]"
                >
                  −
                </button>
                <span className="tnum font-bold text-[17px] text-ink-900" aria-live="polite">
                  {quantity}
                </span>
                <button
                  onClick={onAdd}
                  aria-label={`Add another ${item.name}`}
                  className="pressable glass-hover size-11 grid place-items-center rounded-lg
                             bg-surface text-ink-900 font-bold text-[20px]"
                >
                  +
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Feedback
// =============================================================================

/**
 * Skeletons, not spinners.
 *
 * The layout is known before the data is, so the customer's eye can settle on
 * where the first stall will appear instead of being thrown when content lands
 * under a centred spinner. It also makes a slow network feel like loading
 * rather than like nothing happening.
 */
export function StallSkeleton() {
  return (
    // Same grid AND the same card shape as the real list, so nothing jumps when
    // the data lands. This had to change with the card: a skeleton of small
    // row-tiles standing in for tall photo cards makes the whole page lurch
    // downward on load, which is worse than no skeleton at all.
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="bg-surface rounded-card shadow-card overflow-hidden">
          <div className="skeleton aspect-[16/10] lg:aspect-[16/9] w-full" />
          <div className="px-4 pt-3.5 pb-4 space-y-2">
            <div className="skeleton h-4 w-2/5 rounded" />
            <div className="skeleton h-3 w-3/5 rounded" />
            <div className="skeleton h-3 w-1/4 rounded" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MenuSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-surface rounded-card shadow-card p-4 flex gap-4">
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-12 rounded" />
            <div className="skeleton h-4 w-3/5 rounded" />
            <div className="skeleton h-3 w-1/3 rounded" />
            <div className="skeleton h-3 w-4/5 rounded" />
          </div>
          <div className="skeleton size-[76px] rounded-tile" />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3" role="status">
      <div className="size-8 rounded-full border-[3px] border-ink-200 border-t-brand-500 motion-safe:animate-spin" />
      <p className="text-sm text-ink-500">{label}</p>
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-20 text-center px-6">
      <p className="text-[17px] font-bold text-ink-900">{title}</p>
      <p className="text-sm text-ink-500 mt-2 max-w-[15rem] mx-auto leading-relaxed">{body}</p>
    </div>
  );
}

/**
 * Error copy is chosen by CODE, never by parsing the server's message.
 *
 * The correlation id is always shown. When a customer says "it did not work",
 * that eight-character string is the difference between finding the request in
 * the logs and guessing.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;

  const copy: Record<string, { title: string; body: string }> = {
    QR_INVALID: {
      title: "That code didn't work",
      body: 'Check you scanned a code inside this food court, or ask a member of staff.',
    },
    SESSION_EXPIRED: {
      title: 'Your session ended',
      body: 'Scan the QR code again to start ordering.',
    },
    VENDOR_CLOSED: { title: 'This stall has stopped taking orders', body: 'Try another stall.' },
    ITEM_UNAVAILABLE: {
      title: 'Something sold out',
      body: 'An item in your basket is no longer available. Remove it and try again.',
    },
    NETWORK: {
      title: 'Cannot reach the server',
      body: 'Check your connection and try again. Nothing has been ordered.',
    },
    TIMEOUT: {
      title: 'That took too long',
      body: 'The server did not answer. Nothing has been ordered — try again.',
    },
    CROSS_VENDOR_CART: {
      title: 'One stall at a time',
      body: 'Each order goes to a single kitchen. Place this one first.',
    },
    RATE_LIMITED: {
      title: 'Too many attempts',
      body: 'Wait a moment and try again.',
    },
    INVALID_CREDENTIALS: {
      title: "That code didn't match",
      body: 'Check the digits, or ask for a new code.',
    },
  };

  const c = (api && copy[api.code]) ?? {
    title: 'Something went wrong',
    body: api?.message ?? 'Please try again in a moment.',
  };

  return (
    <div className="py-14 text-center px-6" role="alert">
      <p className="text-[17px] font-bold text-ink-900">{c.title}</p>
      <p className="text-sm text-ink-500 mt-2 max-w-[16rem] mx-auto leading-relaxed">{c.body}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="pressable glass-hover mt-6 px-6 py-3 rounded-xl bg-brand-fill text-on-brand font-bold text-sm"
        >
          Try again
        </button>
      ) : null}
      {api && api.correlationId !== 'none' ? (
        <p className="mt-8 text-[11px] text-ink-400 tnum">
          Reference {api.correlationId.slice(0, 8)}
        </p>
      ) : null}
    </div>
  );
}

// =============================================================================
// Live orders
// =============================================================================

/**
 * How the customer gets back to food that is already cooking.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A food court exists so you can buy a curry from one stall and a drink from
 * another. The cart enforces one vendor per ORDER — correct, an order goes to
 * one kitchen — but that was being felt as one vendor per VISIT, because once
 * you left the tracking screen there was no route back to it. The customer's
 * only options were to stare at a progress bar or lose the order.
 *
 * So: a strip that follows them onto the stall list and every menu, showing
 * what is in flight. Tapping one returns to its tracking screen. Ordering from
 * a second stall costs nothing and loses nothing.
 *
 * It appears only when there is something to show, and disappears when the
 * last order is collected — a permanent chrome element for an empty list is
 * just a thing to scroll past.
 */
const LIVE_STATUSES = new Set([
  'CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'DISPATCHED',
  'ACKNOWLEDGED',
  'PREPARING',
  'READY',
]);

/** What the customer is told, in four words or fewer. */
export function orderStatusLabel(status: string): { text: string; tone: 'wait' | 'go' | 'warn' } {
  switch (status) {
    case 'CREATED':
    case 'PAYMENT_PENDING':
      return { text: 'Payment not done', tone: 'warn' };
    case 'PAYMENT_CONFIRMED':
    case 'DISPATCHED':
      return { text: 'Sent to the stall', tone: 'wait' };
    case 'ACKNOWLEDGED':
    case 'PREPARING':
      return { text: 'Being made', tone: 'wait' };
    case 'READY':
      return { text: 'Ready to collect', tone: 'go' };
    default:
      return { text: status, tone: 'wait' };
  }
}

export function LiveOrders({
  orders,
  onOpen,
}: {
  orders: { orderId: string; orderNumber: string; status: string; vendorName: string }[];
  onOpen: (orderId: string) => void;
}) {
  const live = orders.filter((o) => LIVE_STATUSES.has(o.status));
  if (live.length === 0) return null;

  return (
    <section className="mb-4" aria-label="Your orders">
      <h2 className="text-[13px] font-bold text-ink-500 px-1 mb-2">
        {live.length === 1 ? 'Your order' : `Your orders (${live.length})`}
      </h2>

      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 items-start">
        {live.map((o) => {
          const s = orderStatusLabel(o.status);
          return (
            <li key={o.orderId}>
              <button onClick={() => onOpen(o.orderId)} className="pressable w-full text-left">
                {/* Glass on the card, not the button. See Orders.tsx. */}
                <Card
                  interactive
                  className={`px-4 py-3 flex items-center gap-3 ${
                    s.tone === 'go' ? 'border-2 border-fresh-500' : ''
                  }`}
                >
                  <span
                    className={`text-[15px] font-black tnum shrink-0 ${
                      s.tone === 'go' ? 'text-fresh-700' : 'text-ink-900'
                    }`}
                  >
                    {o.orderNumber}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink-500 truncate">{o.vendorName}</span>
                  </span>

                  <Pill tone={s.tone === 'go' ? 'good' : s.tone === 'warn' ? 'warn' : 'neutral'}>
                    {s.text}
                  </Pill>

                  <svg viewBox="0 0 24 24" className="size-4 text-ink-400 shrink-0" fill="none" aria-hidden>
                    <path
                      d="M9 5l7 7-7 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Card>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
