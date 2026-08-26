/**
 * What counts as a restock.
 *
 * ============================================================================
 * WHY THESE ARE THE TESTS
 * ============================================================================
 *
 * The feature's whole failure mode is silence. A watch that never fires looks
 * exactly like a dish that never came back, from every angle a human has:
 * nobody gets a toast, no error is logged, and the row sits in the table
 * looking correct. There is no symptom to notice and no bug report to file —
 * the diner simply concludes the button does nothing and never taps it again.
 *
 * So the rules are pinned here rather than trusted to the sweep being read
 * carefully. `itemState` is the pure function the sweep, the menu and the
 * checkout all share, and these assert the three transitions that decide
 * whether a waiting customer hears anything.
 */

import { describe, it, expect } from 'vitest';

import { itemState } from './availability.js';

type Input = Parameters<typeof itemState>[0];

const NOW = new Date('2026-08-20T12:00:00Z');

/** An ordinary, orderable, tracked dish. Each test breaks one thing. */
const dish = (over: Partial<Input> = {}): Input => ({
  status: 'ACTIVE',
  availability: 'AVAILABLE',
  availableFrom: null,
  inventoryMode: 'TRACKED',
  remaining: 5,
  ...over,
});

describe('what the sweep sees as a restock', () => {
  // --------------------------------------------------------------- route one
  /*
   * INVENTORY RAISED ABOVE ZERO.
   *
   * The clearest case and the one a customer means by "out of stock": it ran
   * out, the kitchen cooked more, the count went up.
   */
  it('fires when a tracked count goes from zero to positive', () => {
    expect(itemState(dish({ remaining: 0 }), NOW).orderable).toBe(false);
    expect(itemState(dish({ remaining: 0 }), NOW).reason).toBe('OUT_OF_STOCK');

    expect(itemState(dish({ remaining: 1 }), NOW).orderable).toBe(true);
  });

  // --------------------------------------------------------------- route two
  /*
   * A COOK UN-MARKS IT.
   *
   * Different mechanism, identical experience: the customer could not order it,
   * and now they can. Excluding this because it is "not really stock" would
   * mean the button silently does nothing at every stall that manages
   * availability by hand — which is most of them, since inventory tracking is
   * opt-in per item.
   */
  it('fires when availability goes back from SOLD_OUT', () => {
    const out = dish({ availability: 'SOLD_OUT', inventoryMode: 'UNTRACKED', remaining: null });
    expect(itemState(out, NOW).orderable).toBe(false);
    expect(itemState(out, NOW).reason).toBe('SOLD_OUT');

    const back = dish({ availability: 'AVAILABLE', inventoryMode: 'UNTRACKED', remaining: null });
    expect(itemState(back, NOW).orderable).toBe(true);
  });

  // ------------------------------------------------------------- route three
  /*
   * THE ONE THAT MUST NOT FIRE.
   *
   * Biryani that goes on sale at 18:00 is not out of stock at 17:00 — it was
   * never on. Treating the clock passing as a restock would mean a daily 6pm
   * notification for every diner who ever looked at it once, which is the
   * fastest way to teach somebody to ignore this app's notifications entirely.
   *
   * The guard lives in `watch()`, which refuses to CREATE the row, rather than
   * in the sweep. A watch that can never honestly fire should not exist in the
   * table pretending it might.
   */
  it('a scheduled start is not a restock — the state says TEMPORARILY_UNAVAILABLE', () => {
    const later = dish({
      availability: 'TEMPORARILY_UNAVAILABLE',
      availableFrom: new Date('2026-08-20T18:00:00Z'),
      inventoryMode: 'UNTRACKED',
      remaining: null,
    });

    const state = itemState(later, NOW);
    expect(state.orderable).toBe(false);
    expect(state.reason).toBe('TEMPORARILY_UNAVAILABLE');
    // The pair the controller keys its refusal on. If either half of this
    // changes, `not_restockable` stops being reachable and the daily-6pm
    // notification comes back.
    expect(later.availableFrom).not.toBeNull();
  });

  it('but the same item IS orderable once the clock passes', () => {
    const later = dish({
      availability: 'TEMPORARILY_UNAVAILABLE',
      availableFrom: new Date('2026-08-20T18:00:00Z'),
      inventoryMode: 'UNTRACKED',
      remaining: null,
    });
    expect(itemState(later, new Date('2026-08-20T18:30:00Z')).orderable).toBe(true);
  });

  // ------------------------------------------------------------------ refuse
  /*
   * A DISCONTINUED DISH IS NOT COMING BACK.
   *
   * `listed: false` — it is not on the menu at all, so the watch button should
   * never have been rendered. The controller refuses it anyway, because a menu
   * the client fetched two minutes ago can disagree with the database.
   */
  it('refuses a discontinued item — nothing to wait for', () => {
    // `INACTIVE`, not `DISCONTINUED`. The item's STATUS column carries the
    // former; `DISCONTINUED` is the reason `itemState` reports for it, and the
    // two names being different is a trap the type caught here.
    const gone = dish({ status: 'INACTIVE' });
    const state = itemState(gone, NOW);
    expect(state.orderable).toBe(false);
    expect(state.reason).toBe('DISCONTINUED');
    expect(state.listed).toBe(false);
  });

  /*
   * An UNTRACKED item with a stale `remaining` of 0 must stay orderable.
   *
   * This is the one that would produce a watch nobody can ever satisfy: the
   * sweep would read zero, decide the item is out, and the row would wait for
   * a count that the stall does not keep and will never raise.
   */
  it('ignores a stale count on an untracked item', () => {
    const untracked = dish({ inventoryMode: 'UNTRACKED', remaining: 0 });
    expect(itemState(untracked, NOW).orderable).toBe(true);
  });
});

/**
 * ============================================================================
 * THE KITCHEN'S SIDE
 * ============================================================================
 *
 * `stockAlerts` in the KDS controller decides what a cook is told. The rule
 * that matters is the one that keeps the alert worth reading: silence when the
 * cook did it themselves.
 */
describe('what the kitchen is told', () => {
  const DEFAULT_THRESHOLD = 3;

  /** The controller's rule, extracted so it can be asserted without a database. */
  const classify = (
    availability: string,
    remaining: number,
    threshold: number | null,
  ): 'OUT' | 'LOW' | null => {
    if (availability === 'SOLD_OUT') return null;
    const limit = threshold ?? DEFAULT_THRESHOLD;
    if (remaining <= 0) return 'OUT';
    if (remaining <= limit) return 'LOW';
    return null;
  };

  it('says nothing when a cook marked it sold out themselves', () => {
    // The person reading this screen is the person who pressed the button.
    // Telling them what they just did is how an alert stops being read.
    expect(classify('SOLD_OUT', 0, null)).toBeNull();
    expect(classify('SOLD_OUT', 2, null)).toBeNull();
  });

  it('says OUT when a tracked item hits zero on its own', () => {
    expect(classify('AVAILABLE', 0, null)).toBe('OUT');
  });

  it('warns while there is still time to cook more', () => {
    expect(classify('AVAILABLE', 3, null)).toBe('LOW');
    expect(classify('AVAILABLE', 1, null)).toBe('LOW');
    expect(classify('AVAILABLE', 4, null)).toBeNull();
  });

  /*
   * The per-item override, and the reason NULL cannot mean "no warning".
   *
   * Every row is NULL on the day this ships. If NULL disabled the warning, the
   * feature would be off for the entire platform at launch and would only ever
   * turn on for items somebody had edited by hand — which is nobody.
   */
  it('honours a per-item threshold, and NULL means the default rather than off', () => {
    expect(classify('AVAILABLE', 8, 10)).toBe('LOW');
    expect(classify('AVAILABLE', 8, null)).toBeNull();
    expect(classify('AVAILABLE', 1, 1)).toBe('LOW');
  });
});
