import { describe, it, expect } from 'vitest';

import { currentClose, hasNoSchedule, isOpenAt, nextOpening, parseHours } from './opening-hours.js';

const IST = 'Asia/Kolkata';

/** A Date at a given IST wall-clock time. IST is UTC+5:30 and has no DST. */
function ist(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00+05:30`);
}

// 2026-08-17 is a Monday.
const MON = '2026-08-17';
const TUE = '2026-08-18';
const SAT = '2026-08-22';
const SUN = '2026-08-23';

describe('an unconfigured stall is always open, never never-open', () => {
  /*
   * The single most important assertion in this file.
   *
   * Every vendor row holds `{}` — the column has existed since the first
   * migration and nothing has ever written it. If empty meant closed, deploying
   * this module would have shut every stall on the platform simultaneously,
   * with no error anywhere and no way for a vendor to fix it.
   */
  it('treats {} as no schedule', () => {
    expect(hasNoSchedule(parseHours({}))).toBe(true);
    expect(isOpenAt(parseHours({}), ist(MON, '03:00'), IST)).toBe(true);
    expect(nextOpening(parseHours({}), ist(MON, '03:00'), IST)).toBeNull();
  });

  it('treats junk in the column as no schedule rather than throwing', () => {
    // One vendor row edited by hand must not take down a whole court's menu.
    for (const junk of [null, 42, 'closed', [], { mon: 'all day' }, { mon: [{ open: '25:00' }] }]) {
      expect(hasNoSchedule(parseHours(junk))).toBe(true);
    }
  });
});

describe('split windows — lunch and dinner with a dead afternoon', () => {
  const hours = parseHours({
    mon: [
      { open: '11:00', close: '15:30' },
      { open: '18:30', close: '23:00' },
    ],
  });

  it('is open during lunch', () => {
    expect(isOpenAt(hours, ist(MON, '12:00'), IST)).toBe(true);
  });

  it('is SHUT in the afternoon gap', () => {
    // The case a single open/close per day cannot express, and the reason the
    // shape is a list.
    expect(isOpenAt(hours, ist(MON, '16:45'), IST)).toBe(false);
  });

  it('says when it reopens, today', () => {
    expect(nextOpening(hours, ist(MON, '16:45'), IST)).toEqual({
      at: '18:30',
      today: true,
      day: 'mon',
    });
  });

  it('is open again for dinner', () => {
    expect(isOpenAt(hours, ist(MON, '20:00'), IST)).toBe(true);
  });

  it('closes at the closing minute, not after it', () => {
    expect(isOpenAt(hours, ist(MON, '22:59'), IST)).toBe(true);
    expect(isOpenAt(hours, ist(MON, '23:00'), IST)).toBe(false);
  });
});

describe('a window running past midnight', () => {
  const late = parseHours({ sat: [{ open: '18:00', close: '02:00' }] });

  it('is open before midnight on the day itself', () => {
    expect(isOpenAt(late, ist(SAT, '23:30'), IST)).toBe(true);
  });

  /*
   * The bug this prevents: a late counter vanishing from the app at midnight,
   * during the hour it makes its money. Sunday's own windows say nothing about
   * Saturday's 18:00–02:00, so the check has to look back a day.
   */
  it('is still open after midnight, which belongs to the NEXT weekday', () => {
    expect(isOpenAt(late, ist(SUN, '00:30'), IST)).toBe(true);
    expect(isOpenAt(late, ist(SUN, '01:59'), IST)).toBe(true);
  });

  it('shuts at the closing time', () => {
    expect(isOpenAt(late, ist(SUN, '02:00'), IST)).toBe(false);
  });
});

describe('closed days', () => {
  const weekdaysOnly = parseHours({
    mon: [{ open: '11:00', close: '22:00' }],
    tue: [{ open: '11:00', close: '22:00' }],
  });

  it('is shut on a day with no windows', () => {
    expect(isOpenAt(weekdaysOnly, ist(SAT, '13:00'), IST)).toBe(false);
  });

  it('looks ahead across days to answer when it reopens', () => {
    // Monday closing time, so the answer is Tuesday — not "nothing".
    const next = nextOpening(weekdaysOnly, ist(MON, '23:00'), IST);
    expect(next).toEqual({ at: '11:00', today: false, day: 'tue' });
  });

  it('returns null when a week holds nothing, rather than promising a time', () => {
    // An explicitly empty schedule is indistinguishable from permanently shut
    // and must not render as "opens at ...".
    expect(nextOpening(parseHours({ mon: [] }), ist(MON, '10:00'), IST)).toBeNull();
  });
});

describe('the timezone is the court, not the server', () => {
  const hours = parseHours({ mon: [{ open: '09:00', close: '17:00' }] });

  it('reads 10:00 IST as open even though it is 04:30 UTC', () => {
    expect(isOpenAt(hours, ist(MON, '10:00'), IST)).toBe(true);
    // Same instant, asked about a court in London: 05:30 there, before opening.
    expect(isOpenAt(hours, ist(MON, '10:00'), 'Europe/London')).toBe(false);
  });

  it('does not use a fixed offset, so a DST zone stays correct', () => {
    // 1 Jan and 1 Jul in London differ by an hour of offset. A stall open
    // 09:00-17:00 local is open at 10:00 local on both, and an implementation
    // that added a constant offset would get one of them wrong.
    const winter = new Date('2026-01-05T10:00:00+00:00'); // Mon, GMT
    const summer = new Date('2026-07-06T10:00:00+01:00'); // Mon, BST
    expect(isOpenAt(hours, winter, 'Europe/London')).toBe(true);
    expect(isOpenAt(hours, summer, 'Europe/London')).toBe(true);
  });
});

describe('parse discards only what is broken', () => {
  it('keeps the good windows and drops the bad ones in the same day', () => {
    const h = parseHours({
      tue: [
        { open: '11:00', close: '15:00' },
        { open: '99:99', close: '15:00' },
        { open: '18:00', close: '18:00' },
      ],
    });
    expect(h.tue).toEqual([{ open: '11:00', close: '15:00' }]);
    expect(isOpenAt(h, ist(TUE, '12:00'), IST)).toBe(true);
  });
});

/**
 * ============================================================================
 * currentClose — "Open now · Closes 11:30 pm"
 * ============================================================================
 *
 * The cases below are the ones that made the first implementation wrong. It
 * looked for the window containing `now` and returned its close, which is the
 * obvious reading of the question and answers two ordinary schedules wrongly.
 * A negative control is what exposed it: removing the tie-break the code had
 * did not fail a single test, because the tie-break was never reached.
 */
describe('currentClose', () => {
  const IST = 'Asia/Kolkata';
  /** A wall-clock instant in IST, without hardcoding the +5:30 offset twice. */
  const at = (iso: string): Date => new Date(`${iso}+05:30`);

  it('is null with no schedule — a stall that never shuts has no closing time', () => {
    expect(currentClose({}, at('2026-08-19T12:00'), IST)).toBeNull();
  });

  it('is null when the stall is shut', () => {
    expect(
      currentClose({ wed: [{ open: '11:00', close: '15:00' }] }, at('2026-08-19T16:00'), IST),
    ).toBeNull();
  });

  it('answers with the end of the window that is running', () => {
    expect(
      currentClose({ wed: [{ open: '11:00', close: '23:30' }] }, at('2026-08-19T12:00'), IST),
    ).toEqual({ at: '23:30', tomorrow: false });
  });

  it('respects a REAL gap — lunch service answers 15:00, not the dinner close', () => {
    // Declared dinner-first, which is what a vendor adding a second shift types.
    const hours = {
      wed: [
        { open: '18:00', close: '23:00' },
        { open: '11:00', close: '15:00' },
      ],
    };
    expect(currentClose(hours, at('2026-08-19T12:00'), IST)).toEqual({
      at: '15:00',
      tomorrow: false,
    });
    expect(currentClose(hours, at('2026-08-19T19:00'), IST)).toEqual({
      at: '23:00',
      tomorrow: false,
    });
  });

  /*
   * OVERLAPPING. Both windows contain 13:00 and the counter serves until 22:00.
   * Answering with either window alone is a guess; answering with the earlier
   * close tells a customer the stall shuts in an hour when it has nine to go.
   */
  it('merges overlapping windows and answers with the end of the stretch', () => {
    const hours = {
      wed: [
        { open: '09:00', close: '14:00' },
        { open: '12:00', close: '22:00' },
      ],
    };
    expect(currentClose(hours, at('2026-08-19T13:00'), IST)).toEqual({
      at: '22:00',
      tomorrow: false,
    });
  });

  /*
   * ADJACENT. Two shifts that touch — how a vendor enters a staff changeover.
   * Only the first contains 12:00, so a per-window answer is 15:00: a closing
   * time that does not exist, because the stall does not close then.
   */
  it('joins shifts that merely touch — 15:00 is a changeover, not a close', () => {
    const hours = {
      wed: [
        { open: '11:00', close: '15:00' },
        { open: '15:00', close: '23:00' },
      ],
    };
    expect(currentClose(hours, at('2026-08-19T12:00'), IST)).toEqual({
      at: '23:00',
      tomorrow: false,
    });
  });

  it('flags a close that lands after midnight', () => {
    expect(
      currentClose({ wed: [{ open: '18:00', close: '02:00' }] }, at('2026-08-19T23:00'), IST),
    ).toEqual({ at: '02:00', tomorrow: true });
  });

  it("reads YESTERDAY's late window at 00:30, and agrees with isOpenAt", () => {
    const hours = {
      wed: [{ open: '18:00', close: '02:00' }],
      thu: [{ open: '18:00', close: '02:00' }],
    };
    const past = at('2026-08-20T00:30');
    expect(isOpenAt(hours, past, IST)).toBe(true);
    expect(currentClose(hours, past, IST)).toEqual({ at: '02:00', tomorrow: false });
  });

  it('joins windows that touch ACROSS midnight', () => {
    const hours = {
      wed: [{ open: '18:00', close: '00:00' }],
      thu: [{ open: '00:00', close: '02:00' }],
    };
    expect(currentClose(hours, at('2026-08-20T00:30'), IST)).toEqual({
      at: '02:00',
      tomorrow: false,
    });
  });

  /**
   * THE INVARIANT, CHECKED EVERY MINUTE OF A DAY.
   *
   * `currentClose` returning null and `isOpenAt` returning true is the failure
   * that shows up as a stall reading "Open now ·" with nothing after the dot.
   * Sampling every minute rather than every five because the interesting values
   * are the boundaries, and a five-minute stride steps over half of them.
   */
  it.each([
    ['a real gap', { wed: [{ open: '11:00', close: '15:00' }, { open: '18:00', close: '23:00' }] }],
    ['overlapping', { wed: [{ open: '09:00', close: '14:00' }, { open: '12:00', close: '22:00' }] }],
    ['adjacent', { wed: [{ open: '11:00', close: '15:00' }, { open: '15:00', close: '23:00' }] }],
    ['past midnight', { wed: [{ open: '18:00', close: '02:00' }], thu: [{ open: '18:00', close: '02:00' }] }],
  ])('never disagrees with isOpenAt — %s', (_label, hours) => {
    const disagreements: string[] = [];
    for (let m = 0; m < 24 * 60; m++) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const t = at(`2026-08-19T${hh}:${mm}`);
      if (isOpenAt(hours, t, IST) !== (currentClose(hours, t, IST) !== null)) {
        disagreements.push(`${hh}:${mm}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
