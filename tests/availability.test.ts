import { describe, expect, test } from "vitest";
import { checkTime, findSlots, formatSlot, type Busy } from "../convex/lib/calendar/availability";
import { hhmm, localParts } from "../convex/lib/time";

const TZ = "America/Chicago"; // CDT (UTC-5) until Sun Nov 1 2026, then CST (UTC-6)
const MIN = 60_000;
const HOUR = 60 * MIN;
// Chicago wall clock in October 2026 (CDT) as ms UTC.
const cdt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour + 5, minute);

const free: Busy = { intervals: [], unreadable: false };
const NOW = cdt(20, 10); // Tue Oct 20, 10:00 local

describe("checkTime", () => {
  test("AE3: a 2pm request overlapping a busy interval from a non-primary calendar is busy", () => {
    // The 14:15-15:00 block comes from a subscribed calendar (e.g. therapy), merged in with the rest.
    const busy: Busy = { intervals: [{ start: cdt(21, 9), end: cdt(21, 9, 30) }, { start: cdt(21, 14, 15), end: cdt(21, 15) }], unreadable: false };
    expect(checkTime({ start: cdt(21, 14), end: cdt(21, 14, 30) }, { busy, nowMs: NOW, timeZone: TZ })).toBe("busy");
    expect(checkTime({ start: cdt(21, 13), end: cdt(21, 13, 30) }, { busy, nowMs: NOW, timeZone: TZ })).toBe("clean");
  });

  test("a 6pm weekday request and a Saturday request are outside hours", () => {
    const ctx = { busy: free, nowMs: NOW, timeZone: TZ };
    expect(checkTime({ start: cdt(21, 18), end: cdt(21, 18, 30) }, ctx)).toBe("outside_hours");
    expect(checkTime({ start: cdt(24, 10), end: cdt(24, 10, 30) }, ctx)).toBe("outside_hours");
    // The whole duration must fit: 16:45 for 30 minutes runs past 17:00.
    expect(checkTime({ start: cdt(21, 16, 45), end: cdt(21, 17, 15) }, ctx)).toBe("outside_hours");
    expect(checkTime({ start: cdt(21, 16, 30), end: cdt(21, 17) }, ctx)).toBe("clean");
  });

  test("a past request is past; a free request one hour out is clean (no lead time)", () => {
    const ctx = { busy: free, nowMs: NOW, timeZone: TZ };
    expect(checkTime({ start: cdt(20, 9), end: cdt(20, 9, 30) }, ctx)).toBe("past");
    expect(checkTime({ start: cdt(20, 11), end: cdt(20, 11, 30) }, ctx)).toBe("clean");
  });

  test("unreadable busy data gives unknown", () => {
    const busy: Busy = { intervals: [], unreadable: true };
    expect(checkTime({ start: cdt(21, 14), end: cdt(21, 14, 30) }, { busy, nowMs: NOW, timeZone: TZ })).toBe("unknown");
  });
});

describe("findSlots", () => {
  test("never returns a slot less than two hours out", () => {
    const now = cdt(20, 10, 10);
    const slots = findSlots({ busy: free, nowMs: now, timeZone: TZ });
    expect(slots.length).toBe(3);
    for (const s of slots) expect(s.start).toBeGreaterThanOrEqual(now + 2 * HOUR);
    expect(slots[0].start).toBe(cdt(20, 12, 30)); // 12:10 rounds up to the next half hour
  });

  test("unreadable busy data gives no slots", () => {
    expect(findSlots({ busy: { intervals: [], unreadable: true }, nowMs: NOW, timeZone: TZ })).toEqual([]);
  });

  test("a free week gives three slots on three different days, on the half-hour grid", () => {
    const now = cdt(20, 10, 10);
    const slots = findSlots({ busy: free, nowMs: now, timeZone: TZ });
    expect(slots.map((s) => s.start)).toEqual([cdt(20, 12, 30), cdt(21, 9), cdt(22, 9)]);
    expect(new Set(slots.map((s) => localParts(s.start, TZ).day)).size).toBe(3);
    for (const s of slots) {
      expect(localParts(s.start, TZ).minute % 30).toBe(0);
      expect(s.end - s.start).toBe(30 * MIN);
    }
  });

  test("with only one free day, fills the rest from that day", () => {
    // Busy every day of the window except Wed Oct 21.
    const intervals = [{ start: cdt(20, 0), end: cdt(21, 0) }, { start: cdt(22, 0), end: Date.UTC(2026, 11, 1) }];
    const slots = findSlots({ busy: { intervals, unreadable: false }, nowMs: NOW, timeZone: TZ });
    expect(slots.map((s) => s.start)).toEqual([cdt(21, 9), cdt(21, 9, 30), cdt(21, 10)]);
  });

  test("a 60-minute duration only yields slots with 60 free minutes", () => {
    // Tue afternoon is past the two-hour line from 16:00; Wed has a 30-minute gap at 10:00 and an hour at 13:00.
    const now = cdt(20, 16);
    const intervals = [
      { start: cdt(21, 9), end: cdt(21, 10) },
      { start: cdt(21, 10, 30), end: cdt(21, 13) },
      { start: cdt(21, 14), end: cdt(21, 17) },
    ];
    const busy = { intervals, unreadable: false };
    expect(findSlots({ busy, nowMs: now, timeZone: TZ })[0].start).toBe(cdt(21, 10));
    const long = findSlots({ busy, nowMs: now, timeZone: TZ, durationMin: 60 });
    expect(long[0]).toEqual({ start: cdt(21, 13), end: cdt(21, 14) });
    for (const s of long) {
      expect(s.end - s.start).toBe(60 * MIN);
      for (const b of intervals) expect(b.start < s.end && s.start < b.end).toBe(false);
    }
  });

  test("slots across the DST change land at the right local hour", () => {
    // Fri Oct 30 10:00 CDT; clocks fall back Sun Nov 1, so Monday 09:00 is CST (UTC-6).
    const slots = findSlots({ busy: free, nowMs: cdt(30, 10), timeZone: TZ });
    expect(slots.map((s) => s.start)).toEqual([
      Date.UTC(2026, 9, 30, 17, 0), // Fri 12:00 CDT
      Date.UTC(2026, 10, 2, 15, 0), // Mon 09:00 CST
      Date.UTC(2026, 10, 3, 15, 0), // Tue 09:00 CST
    ]);
    expect(slots.map((s) => hhmm(s.start, TZ))).toEqual(["12:00", "09:00", "09:00"]);
  });
});

describe("formatSlot", () => {
  test("prints the owner's local time, not UTC", () => {
    expect(formatSlot(Date.UTC(2026, 9, 21, 19, 0), TZ)).toBe("Wed Oct 21, 2:00 PM");
    expect(formatSlot(Date.UTC(2026, 9, 21, 19, 0), "UTC")).toBe("Wed Oct 21, 7:00 PM");
    expect(formatSlot(cdt(22, 9, 30), TZ)).toBe("Thu Oct 22, 9:30 AM");
    expect(formatSlot(cdt(22, 12), TZ)).toBe("Thu Oct 22, 12:00 PM");
  });
});
