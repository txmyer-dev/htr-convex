// The proposal lifecycle (STEALS: waggle src/proposals/store.ts via HTR src/htr/proposals/store.py).
//
// A proposal is a draft with a status. Approving one is the only path from "the assistant said
// so" to "a message went out as the owner", and it runs through the owner's ruling exactly once.
//
//   pending -> signed -> sending -> sent -> live   (live: a site request the web agent carried out, seen by Firecrawl;
//                                                   a task its owner marked done in ClickUp)
//   pending -> rejected | expired | superseded
//   sending -> failed -> signed (retry)
//   sent -> failed (a site request only: the web agent said it could not, or the site never showed it)
//   failed -> signed (ask the web agent again) | sent (look at the site again)
//   failed -> rejected (an event card only: Skip, so "on your calendar, reply not sent" can be dismissed)
//
// The table is in convex/schema.ts and the mutations in convex/proposals.ts; this module is the
// part that has no database in it: which moves are legal, and how a proposal is summarised.

import { formatSlot } from "../calendar/availability";

export const STATUSES = [
  "pending", "signed", "sending", "sent", "rejected", "expired", "failed", "superseded", "live",
] as const;
export type Status = (typeof STATUSES)[number];

/** from -> the statuses a proposal may move to. Anything else is a no-op, never an error. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  pending: ["signed", "rejected", "expired", "superseded"],
  signed: ["sending"],
  sending: ["sent", "failed"],
  failed: ["signed", "sent", "rejected"], // signed: send again. sent: a site request only, to read the site again without asking the web agent again (facts.retrySite guards the kind). rejected: an event card only (rulings.skipFailed guards the kind, via skippableWhenFailed).
  sent: ["live", "signed", "failed"], // a site request only: live when the page says it; signed again to ask the web agent again; failed when the agent says it could not, or the site never showed it. A sent email stays sent (proposals.resend and facts.ts guard the kind).
  live: [],
  rejected: [],
  expired: [],
  superseded: [],
};

export function canMove(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Which kinds may be skipped once failed: an event card, whose calendar write may already have landed. */
export function skippableWhenFailed(kind: string): boolean {
  return kind === "event";
}

export const TERMINAL: ReadonlySet<Status> = new Set(["live", "rejected", "expired", "superseded"]);

export function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** The slice of meta.event (convex/schema.ts) the cards show. */
export type CardEvent = {
  op: "insert" | "move";
  title: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  attendees: string[];
  previousStartMs?: number;
};

export function summarize(
  toName: string | undefined | null,
  toAddress: string,
  body: string,
  kind = "email",
  event?: CardEvent | null,
): string {
  if (kind === "site") return `Website update: “${oneLine(body, 60)}”`;
  if (kind === "task") return `Task: “${oneLine(body, 60)}”`;
  const who = toName || toAddress;
  if (kind === "event" && event) {
    const to = formatSlot(event.startMs, event.timeZone);
    if (event.op === "move") return `Move: ${event.previousStartMs !== undefined ? `${formatSlot(event.previousStartMs, event.timeZone)} to ` : "to "}${to} with ${who}`;
    return `Event: ${to} with ${who}`;
  }
  return `Reply to ${who}: “${oneLine(body, 60)}”`;
}

/** "Wed Oct 21, 2:00 PM · 30 min", and where a moved event sits now. */
export function eventWhen(e: CardEvent): string {
  const min = Math.round((e.endMs - e.startMs) / 60_000);
  const was = e.op === "move" && e.previousStartMs !== undefined ? ` (was ${formatSlot(e.previousStartMs, e.timeZone)})` : "";
  return `${formatSlot(e.startMs, e.timeZone)} · ${min} min${was}`;
}

/** Everyone Google will notify on approval: an invite for a new event, an update for a move. */
export function eventWho(e: CardEvent): string {
  return `Google ${e.op === "move" ? "updates" : "invites"}: ${e.attendees.join(", ") || "nobody"}`;
}

/** The approve button's words. */
export function signLabel(kind: string, event?: CardEvent | null): string {
  if (kind === "task") return "Add task";
  if (kind === "event") return event?.op === "move" ? "Move + send" : "Add + send";
  return "Send";
}
