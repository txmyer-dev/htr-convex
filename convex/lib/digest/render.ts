// The numbered digest (STEALS: HTR src/htr/digest/render.py): what waits, as one message the
// owner can rule on line by line.
//
//     3 waiting on you.
//
//     1 Marco (email, Fri): "Do you have a leather bag under $200?" → Yes, the Harlow, $185...
//     2 sam@example.com (email): "Are you open Saturday?" → Hi there, thanks for your message...
//
//     Reply with the number and ✅, no, or better words. "all" sends everything.
//
// One message, not one per draft: a single message keeps the numbering together on the owner's
// screen. Past the cap the tail is counted, not dropped silently. The same text is the plain
// part of the digest email; the ruling page renders the same items as a list.

import { localDaysBetween, localParts, sameLocalDay } from "../time";

export const HELP_LINE = 'Reply with the number and ✅, no, or better words. "all" sends everything.';
export const MAX_CHARS = 1500;

/** The slice of a proposal the digest needs. Any table row with these fields will do. */
export type DigestItem = {
  toAddress: string;
  toName?: string | null;
  body: string;
  basis: string[];
  kind: string; // email | sms
  sourceKind?: string | null; // call_message | email | sms | relist
  deadline?: number | null; // ms UTC
  gap?: string | null; // what they asked that the room could not answer
};

export const GAP_LINE = "Where it says \"you haven't told me\", reply with the number and the answer; it goes out as your words and I remember it.";

export function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

export function who(p: DigestItem): string {
  return p.toName || p.toAddress;
}

export function channelOf(p: DigestItem): string {
  if ((p.sourceKind ?? "").startsWith("call")) return "call";
  if (p.kind === "site") return "site";
  return p.kind === "email" ? "email" : "sms";
}

export function when(p: DigestItem, timeZone: string, nowMs: number): string {
  if (!p.deadline) return "";
  if (sameLocalDay(p.deadline, nowMs, timeZone)) return ", today";
  const days = localDaysBetween(nowMs, p.deadline, timeZone);
  const parts = localParts(p.deadline, timeZone);
  if (days < 7) return `, ${parts.weekdayShort}`;
  return `, ${parts.monthShort} ${parts.day}`;
}

export function renderLine(n: number, p: DigestItem, timeZone: string, nowMs: number): string {
  const ask = p.basis.length ? oneLine(p.basis[0], 80) : "";
  const askPart = ask ? ` "${ask}"` : "";
  const gap = p.gap ? ` · you haven't told me: ${oneLine(p.gap, 60)}` : "";
  return `${n} ${who(p)} (${channelOf(p)}${when(p, timeZone, nowMs)}):${askPart} → ${oneLine(p.body, 160)}${gap}`;
}

/** items: (digest number, proposal), already numbered by the caller. */
export function renderDigest(
  items: Array<[number, DigestItem]>,
  opts: { timeZone?: string; nowMs?: number } = {},
): string {
  const timeZone = opts.timeZone ?? "UTC";
  const nowMs = opts.nowMs ?? Date.now();
  if (items.length === 0) return "Nothing waiting on you.";
  const head = items.length > 1 ? `${items.length} waiting on you.` : "1 waiting on you.";
  const lines = [head, ""];
  const gapLine = items.some(([, p]) => p.gap) ? GAP_LINE : "";
  let budget = MAX_CHARS - head.length - HELP_LINE.length - gapLine.length - 4;
  let shown = 0;
  for (const [n, p] of items) {
    const line = renderLine(n, p, timeZone, nowMs);
    if (budget - line.length - 1 < 0 && shown > 0) break;
    lines.push(line);
    budget -= line.length + 1;
    shown += 1;
  }
  if (shown < items.length) lines.push(`…and ${items.length - shown} more; reply ? after ruling to see them.`);
  lines.push("", HELP_LINE);
  if (gapLine) lines.push(gapLine);
  return lines.join("\n");
}

/**
 * Split on line boundaries so numbering survives a carrier that will not concatenate.
 * A single line longer than the limit is hard-split.
 */
export function segments(text: string, limit = 160): string[] {
  const out: string[] = [];
  let cur = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > limit) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter((s) => s.trim()).map((s) => s.replace(/^\n+|\n+$/g, ""));
}
