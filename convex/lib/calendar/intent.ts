// Scheduling in the drafter (KTD6): the model extracts, code decides. One small model call reads
// an inbound email for a scheduling intent; this file parses that strictly (anything off is
// "none", an ordinary draft) and decides from calendar data what the card is: an event, a slot
// offer, or nothing. The extraction carries no attendees: an insert invites the sender alone, set
// here, so text in an email can't add invitees. A move keeps its event's attendees untouched.

import type { CalendarClaw } from "../../adapters/ports";
import { atLocalHour, hhmm, localParts, ymd, zonedToMs } from "../time";
import { checkTime, findSlots, formatSlot, type Interval } from "./availability";
import { EVENT_LEAD_MS } from "../proposals/lifecycle";
import { busyFor } from "./busy";

export type Intent =
  | { kind: "none" }
  | { kind: "propose_time"; startMs: number; durationMin?: number; title?: string }
  | { kind: "open"; durationMin?: number; title?: string }
  | { kind: "move"; eventHint: string; newStartMs: number }
  | { kind: "pick"; startMs: number };

/** A row of the stored snapshot (calendar.ts), as move matching needs it. */
export type SnapshotEvent = {
  eventId: string; calendarId: string; title: string; allDay: boolean; startMs: number; endMs: number;
  status: string; attendees: string[]; organizerSelf: boolean;
};

/** What an event card writes (schema meta.event, before it has an event id). */
export type EventCard = {
  op: "insert" | "move"; title: string; startMs: number; endMs: number; timeZone: string; attendees: string[];
  targetEventId?: string; previousStartMs?: number; previousEndMs?: number;
};

export type Decision = { kind: "none" } | { kind: "event"; event: EventCard } | { kind: "offer"; slots: Interval[] };

const NONE = { kind: "none" } as const;
const MIN = 60_000;
const DEFAULT_MIN = 30;
const MAX_MIN = 8 * 60;
const SLOT_DAYS = 15; // covers the slot finder's 10 working days
const MOVE_DAYS = 30;

export const INTENT_SYSTEM =
  "You read one email sent to a business owner and say whether it is about scheduling a meeting with the owner. " +
  "Return JSON, exactly one of: " +
  '{"intent":"none"}; ' +
  '{"intent":"propose_time","start":"YYYY-MM-DDTHH:MM","zone":string|null,"durationMin":number|null,"title":string|null} when they ask for or agree to one specific date and time; ' +
  '{"intent":"open","durationMin":number|null,"title":string|null} when they want to meet but name no exact time; ' +
  '{"intent":"move","eventHint":string,"newStart":"YYYY-MM-DDTHH:MM","zone":string|null} when they ask to move an existing meeting with the owner to one specific new time (eventHint: the words they use for that meeting); ' +
  '{"intent":"pick","start":"YYYY-MM-DDTHH:MM","zone":string|null} when they choose one of the times in offered. ' +
  "Times are wall-clock, with no offset. zone is an IANA zone only when the email states one explicitly " +
  '("2pm ET" is America/New_York); otherwise null and the time is in owner_zone. Resolve weekdays and "tomorrow" against now. ' +
  "title is a short meeting name only if they give one. Never return email addresses or attendees.";

/** "2026-10-20T14:00", wall time in `zone`. */
export function localIso(ms: number, zone: string): string {
  return `${ymd(ms, zone)}T${hhmm(ms, zone)}`;
}

/** The extraction call's user turn. */
export function intentPayload(a: { nowMs: number; timeZone: string; theirMessage: string; prior: string[]; offer?: Interval[] }): string {
  return JSON.stringify({
    now: `${localIso(a.nowMs, a.timeZone)} (${localParts(a.nowMs, a.timeZone).weekdayShort})`,
    owner_zone: a.timeZone,
    their_message: a.theirMessage,
    prior: a.prior,
    offered: a.offer?.length ? a.offer.map((s) => localIso(s.start, a.timeZone)) : null,
  });
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A wall time "YYYY-MM-DDTHH:MM[:SS]" in `zone` to ms; null if malformed or not a real local time. */
export function localToMs(local: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const ms = zonedToMs(y, mo, d, h, mi, zone);
  const back = localParts(ms, zone);
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) return null;
  return ms;
}

/** Strict: the whole content is one JSON object (fences allowed), every field the right shape, or none. */
export function parseIntent(content: string, timeZone: string): Intent {
  let data: unknown;
  try {
    data = JSON.parse(content.trim().replace(/^```[a-zA-Z]*\s*|\s*```$/g, ""));
  } catch {
    return NONE;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return NONE;
  const o = data as Record<string, unknown>;
  const absent = (x: unknown) => x === undefined || x === null;
  const bad = Symbol("bad");
  const zoneOf = (): string | typeof bad => (absent(o.zone) ? timeZone : typeof o.zone === "string" && validZone(o.zone) ? o.zone : bad);
  const time = (x: unknown): number | typeof bad => {
    const zone = zoneOf();
    if (zone === bad || typeof x !== "string") return bad;
    return localToMs(x, zone) ?? bad;
  };
  const duration = (): number | undefined | typeof bad =>
    absent(o.durationMin) ? undefined : Number.isInteger(o.durationMin) && (o.durationMin as number) > 0 && (o.durationMin as number) <= MAX_MIN ? (o.durationMin as number) : bad;
  const title = (): string | undefined | typeof bad => {
    if (absent(o.title)) return undefined;
    if (typeof o.title !== "string") return bad;
    const t = o.title.replace(/\s+/g, " ").trim().slice(0, 120);
    return t || undefined;
  };
  const extras = () => {
    const d = duration();
    const t = title();
    return d === bad || t === bad ? bad : { ...(d !== undefined ? { durationMin: d } : {}), ...(t !== undefined ? { title: t } : {}) };
  };

  switch (o.intent) {
    case "propose_time": {
      const startMs = time(o.start);
      const x = extras();
      return startMs === bad || x === bad ? NONE : { kind: "propose_time", startMs, ...x };
    }
    case "open": {
      const x = extras();
      return x === bad ? NONE : { kind: "open", ...x };
    }
    case "move": {
      const newStartMs = time(o.newStart);
      const hint = typeof o.eventHint === "string" ? o.eventHint.trim() : "";
      return newStartMs === bad || !hint ? NONE : { kind: "move", eventHint: hint.slice(0, 200), newStartMs };
    }
    case "pick": {
      const startMs = time(o.start);
      return startMs === bad ? NONE : { kind: "pick", startMs };
    }
    default:
      return NONE;
  }
}

export type DecideInput = {
  intent: Intent;
  claw: CalendarClaw;
  nowMs: number;
  timeZone: string;
  sender: string; // the inbound message's address: an insert's only attendee
  name: string; // what to call them in a default title
  offer?: Interval[]; // the slots on the last offer sent in this thread
  events?: SnapshotEvent[]; // primary's events in the next 30 days, for a move
};

/**
 * KTD6/KTD7, from calendar data alone. A proposed or picked time that is clean is an event; one
 * that isn't, or an open request, is an offer of free slots; an unreadable calendar or no slots is
 * an ordinary reply. A pick takes the offered slot whole; a time that wasn't offered is a proposal.
 */
export async function decide(a: DecideInput): Promise<Decision> {
  const { intent, claw, nowMs, timeZone } = a;
  if (intent.kind === "none") return NONE;
  if (intent.kind === "move") return decideMove(a, intent);

  const durationMin = intent.kind === "pick" ? DEFAULT_MIN : intent.durationMin ?? DEFAULT_MIN;
  const title = (intent.kind !== "pick" && intent.title) || `Meeting with ${a.name}`;
  const want: Interval | null =
    intent.kind === "open" ? null
      : intent.kind === "pick" ? a.offer?.find((s) => s.start === intent.startMs) ?? { start: intent.startMs, end: intent.startMs + DEFAULT_MIN * MIN }
        : { start: intent.startMs, end: intent.startMs + durationMin * MIN };

  // One read covers the asked time and every slot the finder may offer.
  const window = { start: nowMs, end: Math.max(atLocalHour(nowMs, timeZone, SLOT_DAYS, 0), want?.end ?? 0) };
  const busy = await busyFor(claw, window);
  // A card for a time under two hours away would expire as it was drafted (KTD9): offer slots instead.
  if (want && want.start - nowMs >= EVENT_LEAD_MS && checkTime(want, { busy, nowMs, timeZone }) === "clean") {
    return { kind: "event", event: { op: "insert", title, startMs: want.start, endMs: want.end, timeZone, attendees: [a.sender.toLowerCase()] } };
  }
  const slots = findSlots({ busy, nowMs, timeZone, durationMin: want ? Math.round((want.end - want.start) / MIN) : durationMin });
  return slots.length ? { kind: "offer", slots } : NONE;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/** The one candidate, or the single best title match on the hint; a tie is no match. */
function bestMatch(candidates: SnapshotEvent[], hint: string): SnapshotEvent | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const h = words(hint);
  const scored = candidates.map((e) => ({ e, score: [...words(e.title)].filter((w) => h.has(w)).length })).sort((x, y) => y.score - x.score);
  return scored[0].score > 0 && scored[0].score > scored[1].score ? scored[0].e : null;
}

/** A move: one primary-calendar event the owner organises, with the sender attending, in the next 30 days. */
async function decideMove(a: DecideInput, intent: Extract<Intent, { kind: "move" }>): Promise<Decision> {
  const { claw, nowMs, timeZone } = a;
  let primaryId: string | undefined;
  try {
    primaryId = (await claw.calendars()).find((c) => c.primary)?.id;
  } catch {
    return NONE;
  }
  const sender = a.sender.toLowerCase();
  const horizon = nowMs + MOVE_DAYS * 86_400_000;
  const candidates = (a.events ?? []).filter((e) =>
    e.calendarId === primaryId && e.organizerSelf && !e.allDay && e.status !== "cancelled" &&
    e.startMs > nowMs && e.startMs < horizon && e.attendees.includes(sender));
  const target = bestMatch(candidates, intent.eventHint);
  if (!target) return NONE;
  const want = { start: intent.newStartMs, end: intent.newStartMs + (target.endMs - target.startMs) };
  if (want.start - nowMs < EVENT_LEAD_MS) return NONE; // the card would be born expired (KTD9)
  const busy = await busyFor(claw, want, target.eventId);
  if (checkTime(want, { busy, nowMs, timeZone }) !== "clean") return NONE;
  return {
    kind: "event",
    event: {
      op: "move", title: target.title, startMs: want.start, endMs: want.end, timeZone, attendees: target.attendees,
      targetEventId: target.eventId, previousStartMs: target.startMs, previousEndMs: target.endMs,
    },
  };
}

/** The decision as the draft call sees it, so the reply text matches the card. */
export function scheduleNote(d: Decision, timeZone: string): Record<string, unknown> | undefined {
  if (d.kind === "offer") return { decision: "offer_slots", slots: d.slots.map((s) => formatSlot(s.start, timeZone)), zone: timeZone };
  if (d.kind !== "event") return undefined;
  const e = d.event;
  const durationMin = Math.round((e.endMs - e.startMs) / MIN);
  if (e.op === "move") return { decision: "confirm_move", title: e.title, from: formatSlot(e.previousStartMs!, timeZone), to: formatSlot(e.startMs, timeZone), duration_min: durationMin, zone: timeZone };
  return { decision: "accept_time", title: e.title, time: formatSlot(e.startMs, timeZone), duration_min: durationMin, zone: timeZone };
}
