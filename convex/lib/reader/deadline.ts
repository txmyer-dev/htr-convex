// A cheap deadline reader (STEALS: HTR src/htr/reader/deadline.py). If the message names a
// day, the draft carries that deadline and the digest shows it; otherwise the owner's default
// applies. Deliberately small: "Friday", "tomorrow", "today", "by Thursday". Anything subtler
// is the owner's call.

import { atLocalHour, localParts } from "../time";

export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b/i;
const REL = /\b(today|tomorrow|tonight|asap|end of day|eod)\b/i;
const END_OF_DAY_HOUR = 17;

export type Deadline = { deadline: number; hint: string };

/** The deadline (ms UTC, five o'clock local on that day) and the hint as the sender said it. */
export function findDeadline(text: string, nowMs: number, timeZone = "UTC"): Deadline | null {
  const rel = REL.exec(text);
  if (rel) {
    const days = rel[1].toLowerCase() === "tomorrow" ? 1 : 0;
    return { deadline: atLocalHour(nowMs, timeZone, days, END_OF_DAY_HOUR), hint: rel[1] };
  }
  const day = DAY.exec(text);
  if (day) {
    const stem = day[1].toLowerCase().slice(0, 3);
    const idx = DAYS.findIndex((d) => d.startsWith(stem));
    let ahead = (idx - localParts(nowMs, timeZone).weekday + 7) % 7;
    if (ahead === 0) ahead = 7; // "Friday" said on a Friday means next week
    const name = DAYS[idx];
    return { deadline: atLocalHour(nowMs, timeZone, ahead, END_OF_DAY_HOUR), hint: name[0].toUpperCase() + name.slice(1) };
  }
  return null;
}
