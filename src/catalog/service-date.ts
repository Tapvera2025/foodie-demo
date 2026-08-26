/**
 * The service date — which day's stock an order belongs to.
 *
 * A food court closes at 22:00 IST. An order placed at 23:30 IST belongs to
 * that day's count, and a UTC date would say it belongs to the next one,
 * because 23:30 IST is 18:00 UTC and 00:30 IST is 19:00 UTC on the previous
 * day. Every night, for about five and a half hours, a UTC service date is
 * simply wrong — and the busiest of those hours is dinner.
 *
 * So the date is always computed in the COURT'S timezone, which is a column on
 * `food_court` rather than a constant, because a platform that works in one
 * city and silently miscounts in another is worse than one that works nowhere.
 *
 * PRD §6.
 */

const CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = CACHE.get(timezone);
  if (f === undefined) {
    // 'en-CA' is the shortest route to an ISO-shaped YYYY-MM-DD out of Intl.
    // Doing it by hand means reimplementing DST, which is a category of bug
    // nobody wins.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    CACHE.set(timezone, f);
  }
  return f;
}

/**
 * `YYYY-MM-DD` in the given IANA zone.
 *
 * Throws on an unknown timezone rather than falling back to UTC. A fallback
 * here would put the whole court's stock on the wrong day and report nothing —
 * PRD §2.2, a check whose failure mode is silence.
 */
export function serviceDateFor(at: Date, timezone: string): string {
  return formatterFor(timezone).format(at);
}

/**
 * Where the service day begins, for the sweeper that clears yesterday's
 * sold-out flags. Not midnight UTC, for the same reason as above.
 */
export function isSameServiceDate(a: Date, b: Date, timezone: string): boolean {
  return serviceDateFor(a, timezone) === serviceDateFor(b, timezone);
}
