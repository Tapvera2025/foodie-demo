/**
 * When a stall is open, and when it next will be.
 *
 * ============================================================================
 * WHY THIS EXISTS NOW AND NOT BEFORE
 * ============================================================================
 *
 * `vendor.operating_hours` has been in the schema since the initial migration —
 * `JSONB NOT NULL DEFAULT '{}'` — and nothing has ever read or written it. Every
 * row holds `{}`. The customer app could therefore say only two things about a
 * closed stall: "Paused", or "Not taking orders". Neither answers the question
 * somebody standing in a food court at 4pm is actually asking, which is *when
 * can I eat there*.
 *
 * ============================================================================
 * SPLIT WINDOWS, NOT ONE OPEN AND ONE CLOSE
 * ============================================================================
 *
 * The obvious shape is `{ mon: { open, close } }` and it is wrong for this
 * market. A great many Indian food-court stalls run lunch and dinner with a
 * dead afternoon between — 11:00–15:30, then 18:30–23:00. Modelling one window
 * per day forces those stalls to either claim they are open at 4pm, which loses
 * an order the kitchen cannot cook, or to close at 15:30 and lose the evening.
 *
 * So a day is a LIST of windows. Most stalls will have one; the ones that need
 * two are not an edge case here.
 *
 * ============================================================================
 * PAST MIDNIGHT IS A REAL CASE
 * ============================================================================
 *
 * `close < open` means the window runs into the next day: 18:00–02:00. Late
 * counters do exist and treating that as invalid data would be a bug reported
 * as "the app says we are shut during our busiest hour".
 *
 * ============================================================================
 * NO HOURS MEANS ALWAYS OPEN, DELIBERATELY
 * ============================================================================
 *
 * Every existing stall has `{}`. If empty meant closed, shipping this file
 * would shut the entire platform the moment it deployed — a silent, total
 * outage caused by a feature nobody had filled in yet. Empty means "no schedule
 * configured", and a stall with no schedule is governed by the controls that
 * already exist: its status, its pause, and its kitchen heartbeat.
 */

/** `HH:MM`, 24-hour, in the COURT's timezone. Never UTC — see `isOpenAt`. */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

export interface Window {
  readonly open: string;
  readonly close: string;
}

/** A day missing from the record is a day the stall is shut. */
export type OpeningHours = Partial<Record<Day, readonly Window[]>>;

export function isValidTime(s: string): boolean {
  return TIME.test(s);
}

/** Minutes past midnight. The unit every comparison below works in. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * Parse whatever is in the JSONB column, discarding anything malformed.
 *
 * Tolerant rather than throwing, because this runs on the read path for every
 * stall in a court. One vendor row edited by hand into a bad shape must not
 * take down the whole menu — it should make that ONE stall behave as though it
 * has no schedule, which is the safe direction.
 */
export function parseHours(raw: unknown): OpeningHours {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: Record<string, Window[]> = {};

  for (const day of DAYS) {
    const windows = (raw as Record<string, unknown>)[day];
    if (!Array.isArray(windows)) continue;

    const valid = windows.filter(
      (w): w is Window =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as Window).open === 'string' &&
        typeof (w as Window).close === 'string' &&
        isValidTime((w as Window).open) &&
        isValidTime((w as Window).close) &&
        // A zero-length window is meaningless and would make `isOpenAt` false
        // for an instant nobody can hit. Almost certainly a typo.
        (w as Window).open !== (w as Window).close,
    );

    if (valid.length > 0) out[day] = valid;
  }

  return out as OpeningHours;
}

/** True when no schedule is configured at all. See the header. */
export function hasNoSchedule(hours: OpeningHours): boolean {
  return DAYS.every((d) => (hours[d]?.length ?? 0) === 0);
}

/**
 * The wall-clock day and minute at `instant`, in `timeZone`.
 *
 * Via `Intl` rather than by adding an offset, because an offset is wrong twice
 * a year anywhere with daylight saving. India has none, which is exactly the
 * reason to get this right once now: the first non-IST court would otherwise
 * inherit a bug written under the assumption that offsets are constant.
 */
function localParts(instant: Date, timeZone: string): { day: Day; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));

  const weekday = String(parts['weekday'] ?? '').slice(0, 3).toLowerCase() as Day;
  const day: Day = DAYS.includes(weekday) ? weekday : 'mon';

  // `hour: '2-digit'` with hour12 false yields "24" at midnight in some ICU
  // versions rather than "00". Normalising is cheaper than depending on which.
  const hour = Number(parts['hour'] ?? 0) % 24;
  const minute = Number(parts['minute'] ?? 0);

  return { day, minutes: hour * 60 + minute };
}

function previousDay(d: Day): Day {
  return DAYS[(DAYS.indexOf(d) + DAYS.length - 1) % DAYS.length]!;
}

function nextDay(d: Day): Day {
  return DAYS[(DAYS.indexOf(d) + 1) % DAYS.length]!;
}

export function isOpenAt(hours: OpeningHours, instant: Date, timeZone: string): boolean {
  if (hasNoSchedule(hours)) return true;

  const { day, minutes } = localParts(instant, timeZone);

  for (const w of hours[day] ?? []) {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }

  /*
   * YESTERDAY'S LATE WINDOW MAY STILL BE RUNNING.
   *
   * A stall open 18:00–02:00 on Friday is open at 00:30 on SATURDAY, and
   * Saturday's own windows say nothing about it. Missing this is the bug where
   * the late-night counter disappears from the app at midnight, during the one
   * hour it makes its money.
   */
  for (const w of hours[previousDay(day)] ?? []) {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    if (close < open && minutes < close) return true;
  }

  return false;
}

/**
 * When the stall next opens, as `HH:MM` plus whether it is today.
 *
 * Null when there is no schedule (always open) or when nothing is configured
 * within a week — the latter meaning somebody saved an empty schedule, which is
 * indistinguishable from permanently shut and should read that way rather than
 * as a promise.
 *
 * Searches seven days, so "closed Mondays" answers with Tuesday rather than
 * with nothing.
 */
export function nextOpening(
  hours: OpeningHours,
  instant: Date,
  timeZone: string,
): { at: string; today: boolean; day: Day } | null {
  if (hasNoSchedule(hours)) return null;

  const { day, minutes } = localParts(instant, timeZone);

  // Today, later on.
  const todayLater = (hours[day] ?? [])
    .map((w) => toMinutes(w.open))
    .filter((m) => m > minutes)
    .sort((a, b) => a - b)[0];

  if (todayLater !== undefined) {
    return { at: fromMinutes(todayLater), today: true, day };
  }

  // Then the next six days, in order.
  let cursor = day;
  for (let i = 0; i < 6; i++) {
    cursor = nextDay(cursor);
    const first = (hours[cursor] ?? []).map((w) => toMinutes(w.open)).sort((a, b) => a - b)[0];
    if (first !== undefined) return { at: fromMinutes(first), today: false, day: cursor };
  }

  return null;
}

/**
 * When the window the stall is CURRENTLY inside ends, as `HH:MM`.
 *
 * The mirror of `nextOpening`, and the stall page needs it for the same reason
 * the list needs that one: "Open now" on its own tells a customer nothing about
 * whether the kitchen will still be there in ten minutes, and a food court at
 * 22:50 is full of stalls that are open and about to not be.
 *
 * Null when the stall is shut, and null when there is no schedule — a stall
 * that never closes has no closing time, and inventing "23:59" would put a
 * deadline on a counter that does not have one.
 *
 * ============================================================================
 * WHY YESTERDAY IS SEARCHED FIRST
 * ============================================================================
 *
 * At 00:30 on Saturday, a stall open Friday 18:00–02:00 is open — and the
 * window that is running belongs to FRIDAY. Reading Saturday's rows would
 * either find nothing (and report a closed stall) or find Saturday's own
 * 18:00–02:00 and answer "closes at 02:00" seventeen hours early. `isOpenAt`
 * already had to learn this; the same case has to be checked in the same order
 * here or the two functions disagree at exactly midnight.
 */
export function currentClose(
  hours: OpeningHours,
  instant: Date,
  timeZone: string,
): { at: string; tomorrow: boolean } | null {
  if (hasNoSchedule(hours)) return null;

  const { day, minutes } = localParts(instant, timeZone);

  /*
   * ==========================================================================
   * WINDOWS ARE MERGED BEFORE ANYTHING IS ANSWERED
   * ==========================================================================
   *
   * The obvious implementation — find the window containing `now`, return its
   * close — is wrong twice, and both cases are ordinary vendor data:
   *
   *   OVERLAPPING   09:00–14:00 and 12:00–22:00. At 13:00 both windows match.
   *                 Picking either one alone is a guess; picking the earliest
   *                 close says "shuts at 2pm" about a counter serving until 10.
   *
   *   ADJACENT      11:00–15:00 and 15:00–23:00, which is how a vendor enters
   *                 two shifts with different staff. Only the first window
   *                 contains 12:00, so the naive answer is 15:00 — a closing
   *                 time that does not exist, because the stall never shuts.
   *
   * A genuinely split day — 11:00–15:00 and 18:00–23:00, with a real gap — must
   * still answer 15:00 at noon. Merging handles all three: the question is not
   * "which window am I in" but "when does the open stretch I am in run out".
   *
   * Everything is projected onto one timeline of minutes from today's midnight,
   * so a window from yesterday sits at negative minutes and one running past
   * midnight extends beyond 1440. That removes the day-boundary special cases
   * entirely rather than checking for them.
   */
  const spans: { from: number; to: number }[] = [];

  for (const w of hours[previousDay(day)] ?? []) {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    // Yesterday only reaches today if it ran past midnight.
    if (close <= open) spans.push({ from: open - 1440, to: close });
  }

  for (const w of hours[day] ?? []) {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    spans.push({ from: open, to: close > open ? close : close + 1440 });
  }

  spans.sort((a, b) => a.from - b.from);

  const merged: { from: number; to: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    // `>=`, not `>`: 11:00–15:00 followed by 15:00–23:00 is one stretch, and
    // treating them as two is the adjacent case above.
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }

  const here = merged.find((s) => minutes >= s.from && minutes < s.to);
  if (!here) return null;

  return { at: fromMinutes(here.to % 1440), tomorrow: here.to >= 1440 };
}

function fromMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
