// Local time without a library. Convex functions run on V8 with full Intl, so a tenant's
// timezone is one Intl.DateTimeFormat away. Everything stored is ms since epoch, UTC.

export type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Monday ... 6 = Sunday
  weekdayShort: string;
  monthShort: string;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function localParts(ms: number, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    month: "short",
    year: "numeric",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: MONTHS.indexOf(parts.month) + 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
    weekdayShort: parts.weekday,
    monthShort: parts.month,
  };
}

/** The zone's UTC offset in ms at instant `ms` (positive east of Greenwich). */
export function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  return wall - Math.floor(ms / 60000) * 60000;
}

/** The instant (ms UTC) of `hour`:00 local, `daysAhead` local days from now. */
export function atLocalHour(nowMs: number, timeZone: string, daysAhead: number, hour: number, minute = 0): number {
  const p = localParts(nowMs, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day + daysAhead, hour, minute, 0, 0);
  // Two passes handle a DST change between now and the target day.
  const first = wall - offsetAt(nowMs, timeZone);
  return wall - offsetAt(first, timeZone);
}

export function sameLocalDay(a: number, b: number, timeZone: string): boolean {
  const x = localParts(a, timeZone);
  const y = localParts(b, timeZone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Whole local days from `from` to `to`; negative when `to` is earlier. */
export function localDaysBetween(from: number, to: number, timeZone: string): number {
  const x = localParts(from, timeZone);
  const y = localParts(to, timeZone);
  return Math.round((Date.UTC(y.year, y.month - 1, y.day) - Date.UTC(x.year, x.month - 1, x.day)) / 86400000);
}

/** "HH:MM" local. */
export function hhmm(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
