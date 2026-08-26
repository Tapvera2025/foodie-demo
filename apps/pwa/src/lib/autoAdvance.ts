/**
 * ============================================================================
 * A SNAP SCROLLER THAT ADVANCES ITSELF — AND GETS OUT OF THE WAY
 * ============================================================================
 *
 * This drives a NATIVE scroll-snap container. It does not manage an index, own
 * a transform, or render anything: it calls `scrollTo` on a real scroller and
 * lets the browser's snap points do the rest. So swipe, keyboard, scrollbar and
 * autoplay all move the same element the same way, and there is no second
 * source of truth to fall out of sync with the DOM.
 *
 * ----------------------------------------------------------------------------
 * THE OBJECTION THIS IS BUILT AGAINST
 * ----------------------------------------------------------------------------
 *
 * `OfferCarousel` in `ui.tsx` refuses to auto-advance, in as many words:
 *
 *     "A banner that moves on its own steals the tap of anybody reaching for
 *      it, and it is the single most complained-about pattern in food-delivery
 *      apps."
 *
 * That is right, and it is a statement about a carousel that moves WHILE BEING
 * TOUCHED — the customer commits to a tap, the slide slides, and the tap lands
 * on whatever arrived. Every condition below exists to make that impossible.
 * The rail advances only when nobody is looking at it in a way that could be
 * interrupted:
 *
 *   reduced motion      never advances at all — a full opt-out, and the only
 *                       one a customer can express from outside the app
 *   pointer / touch     stops the instant a finger lands, before any tap can
 *                       be stolen, and stays stopped for QUIET_MS afterwards
 *   hover / focus       a mouse resting on it, or a keyboard inside it, means
 *                       somebody is reading
 *   off-screen          an IntersectionObserver, so a rail scrolled past does
 *                       not animate or wake the compositor
 *   tab hidden          `document.hidden`, so a backgrounded tab does nothing
 *   nothing to scroll   `scrollWidth <= clientWidth` — this is what makes the
 *                       hook inert at `sm` and up, where the same element is a
 *                       CSS grid. No breakpoint is duplicated in JavaScript;
 *                       the layout decides and this observes the consequence.
 *
 * ----------------------------------------------------------------------------
 * ONE INTERVAL THAT TESTS CONDITIONS, NOT SIX TIMERS THAT RACE
 * ----------------------------------------------------------------------------
 *
 * The alternative — start a timer on mouseleave, clear it on mouseenter, again
 * for focus, for touch, for visibility — is six pairs of handlers that must all
 * agree about who owns the timer. They stop agreeing the first time two fire in
 * the same frame, and the failure is a rail that advances twice per tick or
 * never again, depending on the order.
 *
 * So there is exactly ONE interval, and it asks the questions at each tick.
 * Every "pause" is a boolean read at tick time. Nothing to leak, nothing to
 * double-fire, and adding a new reason to pause is one more `if`.
 */

import { useEffect, type RefObject } from 'react';

import { useMediaQuery, REDUCED_MOTION } from './media';

/** How long the rail stays still after the customer touches it. */
const QUIET_MS = 8_000;

/**
 * Where the next child must be scrolled to so the snap agrees with us.
 *
 * A `snap-start` child aligns against the SNAPPORT, which begins
 * `scroll-padding-left` inside the scrollport — 16px here, from `scroll-px-4`.
 * Scrolling to the child's raw offset would therefore leave it 16px past the
 * snap position, and the browser would immediately correct by that much: a
 * visible twitch at the end of every advance.
 *
 * Reading the value from the computed style rather than hardcoding 16 keeps
 * this correct if the rail's padding ever changes, and costs one style read per
 * advance — at most once every few seconds.
 */
function nextScrollLeft(el: HTMLElement): number {
  const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
  const elLeft = el.getBoundingClientRect().left;

  const starts = Array.from(el.children).map(
    (k) => k.getBoundingClientRect().left - elLeft + el.scrollLeft,
  );

  /*
   * `+ 8` of slack, because these are fractional pixels. Without it a child
   * already sitting at the snap position reads as "ahead of us" by 0.4px and
   * the rail advances to where it already is, forever.
   */
  const ahead = starts.find((x) => x > el.scrollLeft + pad + 8);

  // Nothing ahead — wrap. 0 rather than the first child's offset, because the
  // snapport maths above puts child one at scrollLeft 0 exactly.
  return ahead === undefined ? 0 : ahead - pad;
}

export function useAutoAdvance(
  ref: RefObject<HTMLElement | null>,
  { intervalMs = 4_500, enabled = true }: { intervalMs?: number; enabled?: boolean } = {},
): void {
  /*
   * Read unconditionally, at the top. A hook cannot be called behind an `if`,
   * and this is also the cheapest way to make the rail react to the OS setting
   * being changed while the app is open: the media query re-renders, the effect
   * below re-runs with a new `reduced`, and the interval is torn down.
   */
  const reduced = useMediaQuery(REDUCED_MOTION);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || reduced) return;

    let quietUntil = 0;
    let held = false;
    let onScreen = true;

    /** A finger or a cursor is on the rail — stop now, and stay stopped. */
    const hold = (): void => {
      held = true;
      quietUntil = Date.now() + QUIET_MS;
    };
    const release = (): void => {
      held = false;
      quietUntil = Date.now() + QUIET_MS;
    };

    el.addEventListener('pointerdown', hold, { passive: true });
    el.addEventListener('pointerup', release, { passive: true });
    el.addEventListener('pointercancel', release, { passive: true });
    el.addEventListener('touchstart', hold, { passive: true });
    el.addEventListener('touchend', release, { passive: true });
    el.addEventListener('wheel', hold, { passive: true });
    el.addEventListener('keydown', hold);
    el.addEventListener('mouseenter', hold);
    el.addEventListener('mouseleave', release);
    el.addEventListener('focusin', hold);
    el.addEventListener('focusout', release);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? true;
      },
      // Half of it has to be showing. A rail one pixel into the viewport is not
      // something anybody is watching, and advancing it wastes the frame.
      { threshold: 0.5 },
    );
    io.observe(el);

    const id = setInterval(() => {
      if (held || !onScreen || document.hidden) return;
      if (Date.now() < quietUntil) return;
      // The `sm` grid, and any rail short enough to fit. Checked every tick
      // rather than once, because a window resize crosses the breakpoint
      // without remounting anything.
      if (el.scrollWidth <= el.clientWidth + 1) return;

      el.scrollTo({ left: nextScrollLeft(el), behavior: 'smooth' });
    }, intervalMs);

    return () => {
      clearInterval(id);
      io.disconnect();
      el.removeEventListener('pointerdown', hold);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('touchstart', hold);
      el.removeEventListener('touchend', release);
      el.removeEventListener('wheel', hold);
      el.removeEventListener('keydown', hold);
      el.removeEventListener('mouseenter', hold);
      el.removeEventListener('mouseleave', release);
      el.removeEventListener('focusin', hold);
      el.removeEventListener('focusout', release);
    };
  }, [ref, enabled, reduced, intervalMs]);
}
