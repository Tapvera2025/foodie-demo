/**
 * ============================================================================
 * THE "WHAT'S ON YOUR MIND?" CHIPS
 * ============================================================================
 *
 * Pure, and in its own file, because the bug it exists to prevent was not
 * visible in any query. Every SQL statement involved was correct; the chips
 * were built from two sources and applied against one, and the only place that
 * mistake could be seen was in the shape of what got returned. Logic like that
 * belongs somewhere a test can reach it without a database.
 *
 * ---------------------------------------------------------------------------
 * THE BUG
 * ---------------------------------------------------------------------------
 *
 * Chips come from two places, and they answer at different grains:
 *
 *   - `vendor.cuisine` — how a stall describes ITSELF. "North Indian".
 *   - `menu_category.name` — what it actually COOKS. "Bread", "Momos".
 *
 * The response used to carry a label and a photograph and nothing else, so the
 * client had to work out for itself which stalls a chip selected. It did the
 * only thing it could with what it had: matched the label against each stall's
 * `cuisine` array. That works for exactly the chips of the first kind.
 *
 * Tapping "Bread" compared "bread" against ["North Indian", "Mughlai"], matched
 * nothing, and told a customer standing in front of a stall selling naan that
 * the court had none. The chip was real, the stall was real, the join that
 * connected them ran on the server and was thrown away.
 *
 * ---------------------------------------------------------------------------
 * SO THE CHIP CARRIES ITS OWN ANSWER
 * ---------------------------------------------------------------------------
 *
 * Each chip ships the set of stall ids it selects. Exact rather than a
 * substring guess, one mechanism covering both sources, and — because the same
 * pass builds the labels and the membership — the two cannot drift apart.
 */

/** A stall, as the discovery query returns it. Only the fields chips need. */
export type ChipVendor = { id: string; cuisine: string[] };

/** One row of `menu_category` joined up to its stall. */
export type ChipMenuCategory = { name: string; vendorId: string };

/** A photographed dish, used to find a picture for each label. */
export type ChipPhoto = {
  itemName: string;
  imageUrl: string | null;
  categoryName: string;
  cuisine: string[];
};

export type CategoryChip = {
  label: string;
  imageUrl: string | null;
  /** The stalls this chip selects. Sorted, so the response is deterministic. */
  vendorIds: string[];
};

/**
 * Eight is what fits a scrollable row before it stops being a choice and
 * becomes a list to read.
 */
export const MAX_CHIPS = 8;

/**
 * A label has to be a word, not an initial and not a sentence.
 *
 * Two characters filters out the single letters that appear in hand-typed
 * menus; twenty-four is the point past which a label stops fitting under an
 * 84px circle and starts truncating into meaninglessness.
 */
const MIN_LABEL = 2;
const MAX_LABEL = 24;

export function buildCategoryChips(input: {
  vendors: ChipVendor[];
  menuCategories: ChipMenuCategory[];
  photos: ChipPhoto[];
}): CategoryChip[] {
  const { vendors, menuCategories, photos } = input;

  /**
   * Label -> the STALLS that justify it.
   *
   * A set of ids, not a count. The count was the old shape and it was wrong in
   * a way nobody would have noticed: a stall that had split its menu into three
   * sections all called "Rolls" bumped the counter three times, so the row led
   * with whatever one stall had subdivided the most. The stated intent is "the
   * thing most of this court's stalls sell", and the cardinality of a set of
   * stall ids is literally that sentence.
   */
  const byLabel = new Map<string, Set<string>>();

  const bump = (label: string, vendorId: string): void => {
    const clean = label.trim();
    if (clean.length < MIN_LABEL || clean.length > MAX_LABEL) return;

    /*
     * Case-insensitively, keeping the FIRST spelling seen. "momos" from one
     * stall and "Momos" from another are one chip, not two — and the customer
     * sees whichever stall was listed first, rather than a lowercased label
     * that matches nobody's menu.
     */
    const key = clean.toLowerCase();
    const existing = [...byLabel.keys()].find((k) => k.toLowerCase() === key);
    const at = existing ?? clean;

    const set = byLabel.get(at) ?? new Set<string>();
    set.add(vendorId);
    byLabel.set(at, set);
  };

  for (const v of vendors) for (const c of v.cuisine) bump(c, v.id);
  for (const c of menuCategories) bump(c.name, c.vendorId);

  const ranked = [...byLabel.entries()]
    .sort((a, b) => (b[1].size !== a[1].size ? b[1].size - a[1].size : a[0].localeCompare(b[0])))
    .slice(0, MAX_CHIPS)
    .map(([label]) => label);

  /**
   * A PHOTOGRAPH PER CATEGORY, taken from a dish that is actually in it.
   *
   * The image is most of why the row works — "Biryani" as a word is a filter,
   * a photograph of biryani is an appetite. Stock art would be the easy way to
   * get it and the wrong one: a generic curry above a chip that filters to this
   * court's actual biryani is a promise made by a stock library.
   *
   * Matched on the category NAME first and the dish name second, because a chip
   * can come from either source. `null` when nothing in the court has a
   * photograph, which the client draws as a gradient rather than a broken
   * circle.
   */
  return ranked.map((label) => {
    const key = label.toLowerCase();
    const hit =
      photos.find((p) => p.categoryName.toLowerCase() === key) ??
      photos.find((p) => p.itemName.toLowerCase().includes(key)) ??
      photos.find((p) => p.cuisine.some((c) => c.toLowerCase() === key));

    return {
      label,
      imageUrl: hit?.imageUrl ?? null,
      vendorIds: [...(byLabel.get(label) ?? new Set<string>())].sort(),
    };
  });
}
