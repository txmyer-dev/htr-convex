// The shape of an AgentMail `message.received` event, reduced to what the loop needs.
// `from_` (the API's spelling) and `from` are both accepted.

export type InboundMail = {
  id: string; // AgentMail message_id: the dedupe key, and what a reply threads to
  inboxId: string;
  threadId: string;
  fromAddress: string;
  fromName?: string;
  to: string[];
  subject: string;
  text: string;
  receivedAt: number;
  messageId?: string; // RFC 5322 Message-ID
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
};

const ADDR = /^\s*(?:"?([^"<]*?)"?\s*)?<?([^<>\s@]+@[^<>\s@]+)>?\s*$/;

/** "Sam Lee <sam@x.com>" -> { name: "Sam Lee", address: "sam@x.com" } */
export function parseAddress(s: string): { name?: string; address: string } {
  const m = ADDR.exec(s ?? "");
  if (!m) return { address: (s ?? "").trim().toLowerCase() };
  const name = m[1]?.trim();
  return { name: name || undefined, address: m[2].toLowerCase() };
}

export function parseAgentMailEvent(payload: any): { type: string; mail: InboundMail | null } {
  const type = String(payload?.event_type ?? payload?.type ?? "");
  const m = payload?.message;
  if (!m) return { type, mail: null };
  const from = parseAddress(m.from_ ?? m.from ?? "");
  const to = Array.isArray(m.to) ? m.to.map((t: string) => parseAddress(t).address) : m.to ? [parseAddress(m.to).address] : [];
  const refs = Array.isArray(m.references) ? m.references.join(" ") : m.references;
  return {
    type,
    mail: {
      id: String(m.message_id),
      inboxId: String(m.inbox_id ?? ""),
      threadId: String(m.thread_id ?? ""),
      fromAddress: from.address,
      fromName: from.name,
      to,
      subject: String(m.subject ?? ""),
      text: String(m.text ?? m.preview ?? "").trim(),
      receivedAt: Date.parse(m.timestamp ?? m.created_at ?? "") || Date.now(),
      messageId: m.headers?.["message-id"] ?? m.headers?.["Message-ID"],
      inReplyTo: m.in_reply_to ?? undefined,
      references: refs ?? undefined,
      headers: lowerKeys(m.headers),
    },
  };
}

function lowerKeys(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
  return out;
}
