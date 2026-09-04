// The first reader (STEALS: waggle src/tools/waiting.ts; latestUnanswered from HTR reader/waiting.py).
//
// "What's waiting on me?" is a pure heuristic over recent messages, so the loop can ask one
// question and get the list instead of reading every thread and guessing.
//
// A message is waiting on the owner when it is addressed to them (mentions a name), replies to
// something they wrote, or asks a question, and the owner has not answered it since. Cheap on
// purpose: it is a starting list for drafts the owner will rule on, not a verdict.

export type Msg = {
  id: string;
  sender: string;
  content: string;
  createdAt: number; // ms since epoch
  replyTo?: string;
  rootId?: string;
};

export type Thread = { channelId: string; channelName?: string; messages: Msg[] };

export type Me = { senderIds: Set<string>; names: string[] };

export type WaitingReason = "mention" | "reply-to-you" | "question";

export type WaitingItem = { msg: Msg; channelId: string; channelName?: string; reason: WaitingReason };

const QUESTION_OPENERS =
  /^(does|do|did|can|could|would|will|should|is|are|was|were|who|what|when|where|why|how|any(one|body))\b/i;

export function isQuestion(text: string): boolean {
  return text.includes("?") || QUESTION_OPENERS.test(text.trim());
}

export function waitingOnMe(
  threads: Iterable<Thread>,
  me: Me,
  opts: { since?: number; limit?: number } = {},
): WaitingItem[] {
  const names = me.names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3);
  const out: WaitingItem[] = [];
  for (const th of threads) {
    const ordered = [...th.messages].sort((a, b) => a.createdAt - b.createdAt);
    const mine = ordered.filter((m) => me.senderIds.has(m.sender));
    const myIds = new Set(mine.map((m) => m.id));
    for (const m of ordered) {
      if (me.senderIds.has(m.sender)) continue;
      if (opts.since !== undefined && m.createdAt < opts.since) continue;
      const text = m.content.toLowerCase();
      let reason: WaitingReason | null = null;
      if (names.some((n) => text.includes(n))) reason = "mention";
      else if ((m.replyTo && myIds.has(m.replyTo)) || (m.rootId && myIds.has(m.rootId))) reason = "reply-to-you";
      else if (isQuestion(m.content)) reason = "question";
      if (!reason) continue;
      const threadRoot = m.rootId ?? m.id;
      const answered = mine.some(
        (r) => r.createdAt > m.createdAt && (r.replyTo === m.id || r.rootId === threadRoot || r.rootId === m.id),
      );
      if (answered) continue;
      out.push({ msg: m, channelId: th.channelId, channelName: th.channelName, reason });
    }
  }
  out.sort((a, b) => b.msg.createdAt - a.msg.createdAt);
  return out.slice(0, opts.limit ?? 20);
}

/**
 * The direct-channel case: one counterparty, one thread, no reply ids. The newest inbound
 * message is waiting if nothing went out after it. Every message from a counterparty on a
 * direct channel is addressed to the owner; the question heuristic is not required.
 */
export function latestUnanswered(inbound: Msg[], outbound: Msg[]): Msg | null {
  if (inbound.length === 0) return null;
  const newest = inbound.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  if (outbound.some((o) => o.createdAt > newest.createdAt)) return null;
  return newest;
}
