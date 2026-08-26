/**
 * ============================================================================
 * READ CODE, NOT PROSE
 * ============================================================================
 *
 * This exists because the same bug was written three times in three separate
 * checks, each time by someone who had just been bitten by it:
 *
 *   - `track-rail.mjs` asserted a duplicated headline branch was GONE, and
 *     failed on the comment explaining why it had been removed
 *   - `pay-handoff.mjs` derived its list of failure flags and silently missed
 *     one, because the ternary chain it was scanning had different syntax in a
 *     comment than in the code
 *   - `realtime-rooms.mjs` asserted the gateway has no `socket.on('subscribe')`
 *     handler, and failed on the sentence in the gateway that says exactly
 *     that: "there is no `@SubscribeMessage`, no `socket.on('subscribe')`"
 *
 * Every one of those failed LOUDLY, which was luck. The same blindness passes
 * silently in the other direction: a check looking FOR a pattern is satisfied
 * by a pattern that survives only in a note about how things used to be. A
 * green check that is reading commentary is worse than no check.
 *
 * This codebase comments unusually heavily — several files are more prose than
 * code — so any check that greps source here will hit this. One shared helper
 * means the next check gets it right without having to be bitten first.
 *
 * ----------------------------------------------------------------------------
 * THE COLON RULE
 * ----------------------------------------------------------------------------
 *
 * `//` is only a comment when it does not follow a colon, so `https://…` and
 * `redis://…` inside a string survive. That is not hypothetical here: the
 * outbound-URL sweep and the provider files are full of them, and stripping
 * from `//` in `https://sandbox.cashfree.com` would eat the rest of the line
 * — including, on a bad day, the very thing being searched for.
 *
 * Block comments — including JSX `{​/* … *​/}` — come out with the ordinary
 * rule, since JSX comments are just block comments in an expression slot.
 */

/** Source with comments removed. Line count is not preserved; offsets shift. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Assert the stripper actually did something, and did not eat everything.
 *
 * A check whose `stripComments` silently returned its input unchanged is back
 * to reading prose; one whose regex ran away and returned "" passes every
 * assertion vacuously. Both are caught by looking at the sizes, and every
 * caller should include this in its control.
 *
 * Returns a short string for the control line rather than throwing, so the
 * caller decides how a failure is reported.
 */
export function strippedReport(raw, stripped) {
  const removed = raw.length - stripped.length;
  return {
    removed,
    /** Heavily-commented files here lose thousands of characters; 200 is a floor, not a target. */
    ok: removed > 200 && stripped.length > raw.length * 0.05,
    text: `${removed} comment chars stripped, ${stripped.length} of ${raw.length} kept`,
  };
}
