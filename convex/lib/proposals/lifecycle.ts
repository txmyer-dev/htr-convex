// The proposal lifecycle (STEALS: waggle src/proposals/store.ts via HTR src/htr/proposals/store.py).
//
// A proposal is a draft with a status. Approving one is the only path from "the assistant said
// so" to "a message went out as the owner", and it runs through the owner's ruling exactly once.
//
//   pending -> signed -> sending -> sent -> live   (live: a site request the web agent carried out, seen by Firecrawl)
//   pending -> rejected | expired | superseded
//   sending -> failed -> signed (retry)
//
// The table is in convex/schema.ts and the mutations in convex/proposals.ts; this module is the
// part that has no database in it: which moves are legal, and how a proposal is summarised.

export const STATUSES = [
  "pending", "signed", "sending", "sent", "rejected", "expired", "failed", "superseded", "live",
] as const;
export type Status = (typeof STATUSES)[number];

/** from -> the statuses a proposal may move to. Anything else is a no-op, never an error. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  pending: ["signed", "rejected", "expired", "superseded"],
  signed: ["sending"],
  sending: ["sent", "failed"],
  failed: ["signed"],
  sent: ["live", "signed"], // a site request only: live when the page says it; signed again to ask the web agent again. A sent email stays sent (proposals.resend guards the kind).
  live: [],
  rejected: [],
  expired: [],
  superseded: [],
};

export function canMove(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export const TERMINAL: ReadonlySet<Status> = new Set(["live", "rejected", "expired", "superseded"]);

export function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

export function summarize(toName: string | undefined | null, toAddress: string, body: string, kind = "email"): string {
  if (kind === "site") return `Website update: “${oneLine(body, 60)}”`;
  const who = toName || toAddress;
  return `Reply to ${who}: “${oneLine(body, 60)}”`;
}
