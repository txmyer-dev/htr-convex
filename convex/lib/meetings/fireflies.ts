// Fireflies over GraphQL (https://docs.fireflies.ai). The webhook says a meeting is ready; this
// reads it back: title, who was there, the overview, and the action items, which Fireflies
// writes as one string grouped under each person's name.

export const API = "https://api.fireflies.ai/graphql";
type Fetch = typeof fetch;

export type ActionItem = { who?: string; what: string };

export type Meeting = {
  id: string;
  title: string;
  at: number; // ms UTC, when it started
  durationMin?: number;
  attendees: string[];
  organizer?: string;
  overview?: string;
  bullets?: string;
  actionItems: ActionItem[];
  url?: string;
};

// ---- the webhook ---------------------------------------------------------------------------------

/** Both shapes: v1 { meetingId, eventType } and v2 { event, meeting_id }. Null when it isn't about a meeting. */
export function parseWebhook(payload: unknown): { meetingId: string; event: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const meetingId = p.meeting_id ?? p.meetingId;
  const event = p.event ?? p.eventType;
  if (typeof meetingId !== "string" || !meetingId || typeof event !== "string") return null;
  return { meetingId, event };
}

/** Events that mean the notes are there to read. A bot joining is not one. */
export function isReady(event: string): boolean {
  return /^(meeting\.(transcribed|summarized)|transcription completed)$/i.test(event.trim());
}

const enc = new TextEncoder();

/** X-Hub-Signature: hex HMAC-SHA256 of the raw body, with or without the "sha256=" prefix (v2 adds it, v1 didn't). */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const got = header.trim().replace(/^sha256=/i, "").toLowerCase();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const want = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// ---- action items --------------------------------------------------------------------------------

const HEADER = /^\s*(?:\*\*|__)\s*(.+?)\s*(?:\*\*|__)\s*:?\s*$/; // **Ben Hidalgo**
const TIMESTAMP = /\s*\(?\b\d{1,2}:\d{2}(?::\d{2})?\)?\s*$/; // (12:34) at the end

/** "**Ben**\nSend the deck (03:12)\n- Book the room" -> [{ who: "Ben", what: "Send the deck" }, ...]. */
export function parseActionItems(text: string | null | undefined): ActionItem[] {
  const out: ActionItem[] = [];
  let who: string | undefined;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const head = HEADER.exec(raw);
    if (head) {
      who = head[1].replace(/[*_]/g, "").trim() || undefined;
      continue;
    }
    const what = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(TIMESTAMP, "").replace(/\*\*/g, "").trim();
    if (what.length >= 3) out.push({ who, what });
  }
  return out;
}

// ---- the API -------------------------------------------------------------------------------------

const QUERY = `query Transcript($id: String!) {
  transcript(id: $id) {
    id title date duration organizer_email transcript_url participants
    meeting_attendees { displayName email name }
    summary { overview action_items shorthand_bullet }
  }
}`;

type Raw = {
  id: string; title?: string; date?: number | string; duration?: number; organizer_email?: string; transcript_url?: string;
  participants?: string[]; meeting_attendees?: Array<{ displayName?: string; email?: string; name?: string }>;
  summary?: { overview?: string; action_items?: string; shorthand_bullet?: string } | null;
};

async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown>, f: Fetch): Promise<T> {
  const res = await f(API, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fireflies ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new Error(`Fireflies: ${j.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  return j.data as T;
}

export function toMeeting(r: Raw): Meeting {
  const people = new Map<string, string>();
  for (const a of r.meeting_attendees ?? []) {
    const label = a.displayName || a.name || a.email;
    if (label) people.set((a.email || label).toLowerCase(), label);
  }
  for (const p of r.participants ?? []) for (const one of p.split(/\s*,\s*/)) if (one && !people.has(one.toLowerCase())) people.set(one.toLowerCase(), one);
  const at = typeof r.date === "number" ? r.date : Date.parse(String(r.date ?? "")) || Date.now();
  return {
    id: r.id,
    title: r.title?.trim() || "Untitled meeting",
    at,
    durationMin: typeof r.duration === "number" ? Math.round(r.duration) : undefined,
    attendees: [...people.values()],
    organizer: r.organizer_email,
    overview: r.summary?.overview?.trim() || undefined,
    bullets: r.summary?.shorthand_bullet?.trim() || undefined,
    actionItems: parseActionItems(r.summary?.action_items),
    url: r.transcript_url,
  };
}

export async function getMeeting(apiKey: string, id: string, f: Fetch = fetch): Promise<Meeting | null> {
  const d = await graphql<{ transcript: Raw | null }>(apiKey, QUERY, { id }, f);
  return d.transcript ? toMeeting(d.transcript) : null;
}

/** The cheapest call that proves the key. */
export async function whoAmI(apiKey: string, f: Fetch = fetch): Promise<string> {
  const d = await graphql<{ user: { email: string } | null }>(apiKey, "query { user { email } }", {}, f);
  return d.user?.email ?? "";
}
