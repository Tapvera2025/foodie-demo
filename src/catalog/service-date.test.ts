import { describe, it, expect } from 'vitest';

import { isSameServiceDate, serviceDateFor } from './service-date.js';

const IST = 'Asia/Kolkata';

describe('the service date is the court’s date, not UTC', () => {
  it('puts a late dinner order on the day the kitchen thinks it is', () => {
    // 23:30 IST on the 17th is 18:00 UTC on the 17th — same day, no drama.
    expect(serviceDateFor(new Date('2026-08-17T18:00:00Z'), IST)).toBe('2026-08-17');
  });

  it('is the case that actually bites: after midnight UTC, still today in India', () => {
    // 00:30 UTC on the 18th is 06:00 IST on the 18th. Fine.
    // But 20:00 UTC on the 17th is 01:30 IST on the 18th — a UTC date would
    // file a 1:30am order under the 17th while the court has moved on.
    expect(serviceDateFor(new Date('2026-08-17T20:00:00Z'), IST)).toBe('2026-08-18');
  });

  it('disagrees with UTC for five and a half hours every night', () => {
    // The window is 18:30-24:00 UTC, which is 00:00-05:30 IST. Any stock count
    // keyed on a UTC date is wrong for the whole of it.
    const late = new Date('2026-08-17T19:00:00Z');
    expect(serviceDateFor(late, IST)).not.toBe(late.toISOString().slice(0, 10));
  });

  it('handles a court in a zone with daylight saving', () => {
    // Not a food court we have, but the function must not be secretly IST-only.
    // 2026-03-29 01:30 UTC is 02:30 CET; Europe/Berlin springs forward at 02:00.
    expect(serviceDateFor(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin')).toBe('2026-03-29');
  });

  it('always produces a sortable YYYY-MM-DD', () => {
    for (const iso of ['2026-01-05T00:00:00Z', '2026-12-31T23:59:59Z']) {
      expect(serviceDateFor(new Date(iso), IST)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('groups a lunch rush and a dinner rush into one service day', () => {
    const lunch = new Date('2026-08-17T07:00:00Z'); // 12:30 IST
    const dinner = new Date('2026-08-17T14:30:00Z'); // 20:00 IST
    expect(isSameServiceDate(lunch, dinner, IST)).toBe(true);
  });

  it('throws on an unknown timezone rather than falling back to UTC', () => {
    // A fallback would put a whole court's stock on the wrong day and report
    // nothing — a check whose failure mode is silence.
    expect(() => serviceDateFor(new Date(), 'Mars/Olympus_Mons')).toThrow();
  });
});
