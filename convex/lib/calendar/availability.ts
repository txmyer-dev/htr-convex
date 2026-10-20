// When the owner is free. Pure: callers hand in busy intervals merged from every subscribed
// calendar (KTD7); nothing here reads Google. All instants are ms since epoch, UTC.
import { atLocalHour, localParts } from "../time";

export type Interval = { start: number; end: number };

/** Busy time across the calendars. `unreadable` means at least one calendar failed, so no time is known free. */
export type Busy = { intervals: Interval[]; unreadable: boolean };

/** Working days (0 = Monday ... 6 = Sunday) and the local window, as minutes after midnight. */
export type WorkingHours = { days: number[]; startMinute: number; endMinute: number };

export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [0, 1, 2, 3, 4], startMinute: 9 * 60, endMinute: 17 * 60 };

export type Verdict = "clean" | "busy" | "outside_hours" | "past" | "unknown";

export type AvailabilityContext = {
  busy: Busy;
  nowMs: number;
  timeZone: string;
  hours?: WorkingHours;
};

const MIN = 60_000;
const SLOT_LEAD_MS = 2 * 60 * MIN;
const GRID_MS = 30 * MIN;
const WORKING_DAYS_AHEAD = 10;

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** The working window on the local day `daysAhead` from `fromMs`, or null on a day off. */
function windowOn(fromMs: number, timeZone: string, daysAhead: number, hours: WorkingHours): Interval | null {
  const start = atLocalHour(fromMs, timeZone, daysAhead, 0, hours.startMinute);
  if (!hours.days.includes(localParts(start, timeZone).weekday)) return null;
  return { start, end: atLocalHour(fromMs, timeZone, daysAhead, 0, hours.endMinute) };
}

/** R4: clean = future, wholly inside working hours, and free on every calendar. No lead time. */
export function checkTime(req: Interval, ctx: AvailabilityContext): Verdict {
  if (req.start <= ctx.nowMs) return "past";
  const win = windowOn(req.start, ctx.timeZone, 0, ctx.hours ?? DEFAULT_WORKING_HOURS);
  if (!win || req.start < win.start || req.end > win.end) return "outside_hours";
  if (ctx.busy.unreadable) return "unknown";
  return ctx.busy.intervals.some((b) => overlaps(b, req)) ? "busy" : "clean";
}

/**
 * KTD7: the first `count` free starts of `durationMin` on the half-hour local grid, at least two
 * hours out, within the next 10 working days. One per day first, then filled from the earliest
 * days; returned in time order. Unreadable busy data gives none.
 */
export function findSlots(ctx: AvailabilityContext & { durationMin?: number; count?: number }): Interval[] {
  if (ctx.busy.unreadable) return [];
  const hours = ctx.hours ?? DEFAULT_WORKING_HOURS;
  const duration = (ctx.durationMin ?? 30) * MIN;
  const count = ctx.count ?? 3;
  const earliest = ctx.nowMs + SLOT_LEAD_MS;

  const perDay: Interval[][] = [];
  // A working day can't be more than a week away, so this bound always covers 10 of them.
  for (let d = 0, seen = 0; seen < WORKING_DAYS_AHEAD && d < WORKING_DAYS_AHEAD * 7; d++) {
    const win = windowOn(ctx.nowMs, ctx.timeZone, d, hours);
    if (!win) continue;
    seen++;
    const free: Interval[] = [];
    // The window opens on the local grid and DST shifts happen outside working hours, so fixed steps stay on it.
    for (let s = win.start; s + duration <= win.end; s += GRID_MS) {
      const slot = { start: s, end: s + duration };
      if (s >= earliest && !ctx.busy.intervals.some((b) => overlaps(b, slot))) free.push(slot);
    }
    if (free.length) perDay.push(free);
  }

  const picked = perDay.map((day) => day[0]).slice(0, count);
  for (const day of perDay) {
    for (const slot of day.slice(1)) {
      if (picked.length >= count) break;
      picked.push(slot);
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** "Wed Oct 21, 2:00 PM" in the owner's zone. */
export function formatSlot(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  return `${p.weekdayShort} ${p.monthShort} ${p.day}, ${h12}:${String(p.minute).padStart(2, "0")} ${ampm}`;
}
