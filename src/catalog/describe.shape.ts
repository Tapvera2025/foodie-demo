/**
 * ============================================================================
 * TURNING A MODEL'S OUTPUT INTO SOMETHING THAT CAN GO ON A MENU
 * ============================================================================
 *
 * ITS OWN FILE, WITH NO IMPORTS, ON PURPOSE.
 *
 * This is the only thing standing between a language model and a live customer
 * menu in a food court, which makes it the piece most worth testing and the
 * piece that must be testable without a network, a database or a set of API
 * keys. It lived inside `describe.provider.ts`, which imports `config`, which
 * meant a test of pure string handling could not run without a valid
 * configuration — so it went untested.
 *
 * Nothing in here reaches outside itself. That is the point.
 */

/**
 * ============================================================================
 * SHAPING, WHICH IS NOT THE SAME AS TRIMMING
 * ============================================================================
 *
 * A model's raw output is close to what is wanted and reliably wrong in a small
 * number of ways. Each rule here corresponds to something a real model does:
 *
 *   `"Soft paneer…"`          -> wrapping the answer in quotes
 *   `Here is a description:`  -> a preamble before the answer
 *   `**Khir Kadam** is…`      -> markdown emphasis
 *   two paragraphs            -> ignoring "one sentence"
 *
 * Returning `null` rather than a best effort is deliberate. This function is the
 * only thing standing between a model and a live customer menu, and a caller
 * that receives `null` falls through to the other provider — which is a better
 * outcome than putting `Here is a description:` on a menu board.
 */
export function shape(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let t = raw.trim();

  // A preamble, up to the first colon, when the colon is early enough to be a
  // lead-in rather than part of the sentence.
  const colon = t.indexOf(':');
  if (colon > 0 && colon < 40 && /^(here|sure|okay|certainly|description)/i.test(t)) {
    t = t.slice(colon + 1).trim();
  }

  t = t
    .replace(/\*\*/g, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Matched wrapping quotes, straight or curly. Only when they wrap the WHOLE
  // string — a quotation inside the sentence is the model's business.
  const quoted = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(t);
  if (quoted?.[2] !== undefined) t = quoted[2].trim();

  if (t.length === 0) return null;

  /*
   * Keep the first sentence only.
   *
   * Split on a terminator followed by a space and a capital, so "Rs. 40" and
   * "St. Mary's" do not count as sentence ends. If the model wrote three
   * sentences, the first one is the one that fits the card.
   */
  const firstSentence = t.split(/(?<=[.!?])\s+(?=[A-Z])/)[0]?.trim() ?? t;
  if (firstSentence.length >= 20) t = firstSentence;

  const words = t.split(' ').filter(Boolean);

  /*
   * FLOOR AND CEILING, AND WHY THE FLOOR REJECTS RATHER THAN PADS.
   *
   * Under six words is not a description — it is "Delicious paneer dish", or a
   * refusal like "I cannot help with that", and neither belongs on a menu.
   * There is nothing to salvage, so this reports failure and the caller tries
   * the other provider.
   *
   * The ceiling truncates instead, because a too-long answer contains a good
   * one. Cut on a word boundary and close the sentence.
   */
  if (words.length < 6) return null;

  if (words.length > 45) {
    t = words.slice(0, 45).join(' ').replace(/[,;:\s]+$/, '');
  }

  if (!/[.!?]$/.test(t)) t += '.';

  // The column is bounded at 500 and the customer card clamps long before that.
  return t.slice(0, 500);
}
