// Priority, not just automated or not (merge plan, phase 3). A score from what the reader
// already knows at the moment a message lands, before any LLM has seen it: is it waiting on the
// owner, does it name a day, do we know them, has the owner ruled in this thread before. High
// goes to the phone at once; the rest wait for the draft and the digest. Cheap on purpose, and
// every point carries its reason, so the owner can see why something interrupted them.

import { atLocalHour, localParts } from "../time";
import { findDeadline } from "./deadline";
import { isQuestion } from "./waiting";

export type Level = "high" | "normal" | "low";
export type Priority = { score: number; level: Level; reasons: string[] };

export type Signals = {
  subject?: string;
  text: string;
  automated: boolean;
  ownerNames: string[];
  /** Messages from this sender before this one (the contacts row's count). */
  priorFromSender: number;
  /** The owner wrote in this thread before this message: it answers us. */
  repliesToOwner: boolean;
  /** How the owner ruled on earlier drafts in this thread. */
  threadRulings: { agreed: number; skipped: number };
  nowMs: number;
  timeZone: string;
};

export const HIGH = 6;
export const NORMAL = 2;

const URGENT = /\b(urgent|asap|emergency|time[- ]sensitive|immediately|right away|critical)\b/i;
const ASK = /\b(can|could|would|will) you\b|\bplease\b|\blet me know\b|\b(i|we) need\b|\bneed (you|your)\b/i;
const HOUR = 3_600_000;

export function score(s: Signals): Priority {
  if (s.automated) return { score: 0, level: "low", reasons: ["automated"] };
  const words = `${s.subject ?? ""}\n${s.text}`;
  const reasons: string[] = [];
  let n = 0;
  const add = (pts: number, why: string) => {
    n += pts;
    reasons.push(why);
  };

  if (isQuestion(s.text) || ASK.test(s.text)) add(2, "asks you something");
  const names = s.ownerNames.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 3);
  if (names.some((x) => s.text.toLowerCase().includes(x))) add(1, "names you");
  if (s.repliesToOwner) add(2, "answers your mail");

  if (URGENT.test(words)) add(2, "says it's urgent");
  const due = findDeadline(words, s.nowMs, s.timeZone);
  if (due && due.deadline > s.nowMs) {
    const left = due.deadline - s.nowMs;
    if (left <= 24 * HOUR) add(3, `due ${due.hint}`);
    else if (left <= 72 * HOUR) add(2, `due ${due.hint}`);
    else add(1, `due ${due.hint}`);
  }

  if (s.priorFromSender >= 5) add(2, "someone you hear from often");
  else if (s.priorFromSender >= 1) add(1, "known sender");

  if (s.threadRulings.agreed > 0) add(2, "you've answered this thread before");
  else if (s.threadRulings.skipped > 0) add(-2, "you skipped this thread before");

  const level: Level = n >= HIGH ? "high" : n >= NORMAL ? "normal" : "low";
  return { score: n, level, reasons };
}

/**
 * When an alert may ring: now, or when the owner's quiet hours end. `quiet` is ["21:00", "08:00"]
 * local and may wrap midnight; absent or malformed means never quiet.
 */
export function alertAt(nowMs: number, quiet: string[] | undefined, timeZone: string): number {
  const [from, to] = (quiet ?? []).map((t) => /^(\d{1,2}):(\d{2})$/.exec(t)).map((m) => (m ? Number(m[1]) * 60 + Number(m[2]) : NaN));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return nowMs;
  const p = localParts(nowMs, timeZone);
  const minute = p.hour * 60 + p.minute;
  const quietNow = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!quietNow) return nowMs;
  const daysAhead = minute >= to ? 1 : 0; // before midnight, the quiet ends tomorrow
  return atLocalHour(nowMs, timeZone, daysAhead, Math.floor(to / 60), to % 60);
}
