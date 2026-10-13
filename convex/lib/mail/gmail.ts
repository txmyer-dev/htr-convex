// Gmail over REST with an OAuth refresh token (Python HTR's adapters/mail_gmail.py + gmail_auth.py).
// No Google SDK: a handful of endpoints do not justify one, and Web APIs alone keep it in the
// default Convex runtime. Scopes: gmail.readonly (intake) and gmail.send (dispatch as the owner),
// nothing wider. Each install brings its own Google Cloud OAuth client (Web application, testing mode).

import { parseAddress, type InboundMail } from "./inbound";

export const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Gmail's own categorisation is the strongest signal: only Primary (or uncategorised) mail is a
// person writing to you. The owner's own mail is never intake.
export const PULL_QUERY = "in:inbox -from:me -category:promotions -category:social -category:updates -category:forums";
const MAX_IDS = 200; // per pull; anything older waits for the next one (the cursor only moves on success)

export type GmailCreds = { clientId: string; clientSecret: string; refreshToken: string };
type Fetch = typeof fetch;

type Header = { name: string; value: string };
export type GmailPart = { mimeType?: string; headers?: Header[]; body?: { data?: string; size?: number }; parts?: GmailPart[] };
export type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart };

// ---- encoding ------------------------------------------------------------------------------------

const utf8 = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64url(text: string): string {
  return b64(utf8.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** RFC 2047 for a header value that isn't plain ASCII. */
function headerValue(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(utf8.encode(clean))}?=`;
}

function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, "$&\r\n");
}

export type Outgoing = {
  from: string; to: string[]; cc?: string[]; subject: string; text: string; html?: string;
  headers?: Record<string, string>; inReplyTo?: string; references?: string;
};

/** The RFC 5322 message Gmail's send endpoint takes, base64url-encoded. */
export function buildRaw(m: Outgoing): string {
  const line = (s: string) => s.replace(/[\r\n]+/g, " "); // nothing a sender wrote can start a header of its own
  const head: string[] = [`From: ${line(m.from)}`, `To: ${line(m.to.join(", "))}`];
  if (m.cc?.length) head.push(`Cc: ${line(m.cc.join(", "))}`);
  head.push(`Subject: ${headerValue(m.subject)}`);
  if (m.inReplyTo) {
    head.push(`In-Reply-To: ${line(m.inReplyTo)}`);
    head.push(`References: ${line([m.references, m.inReplyTo].filter(Boolean).join(" "))}`);
  }
  for (const [k, v] of Object.entries(m.headers ?? {})) if (/^[\x21-\x39\x3b-\x7e]+$/.test(k)) head.push(`${k}: ${headerValue(v)}`);
  head.push("MIME-Version: 1.0");
  const typed = (type: string) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64"];
  const encoded = (s: string) => wrap76(b64(utf8.encode(s)));
  let body: string;
  if (m.html) {
    const boundary = `htr-${crypto.randomUUID()}`;
    head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const part = (type: string, s: string) => `--${boundary}\r\n${typed(type).join("\r\n")}\r\n\r\n${encoded(s)}`;
    body = `${part("text/plain", m.text)}${part("text/html", m.html)}--${boundary}--\r\n`;
  } else {
    head.push(...typed("text/plain"));
    body = encoded(m.text);
  }
  return b64url(`${head.join("\r\n")}\r\n\r\n${body}`);
}

// ---- decoding ------------------------------------------------------------------------------------

/** The text/plain part, or a crude strip of text/html, walking multipart bodies. */
export function textOf(p: GmailPart | undefined): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return unb64url(p.body.data);
  for (const part of p.parts ?? []) {
    const t = textOf(part);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    const html = unb64url(p.body.data).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
    return html.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
  }
  return "";
}

/** Split an address list on the commas that separate addresses, not those inside quoted names. */
function addresses(s: string | undefined): string[] {
  return (s ?? "").match(/(?:"[^"]*"|[^,])+/g)?.map((a) => parseAddress(a).address).filter((a) => a.includes("@")) ?? [];
}

function headersOf(p: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of p?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (/^[\x21-\x7e]+$/.test(k) && !/^[$_]/.test(k)) out[k] = h.value.slice(0, 1000);
  }
  return out;
}

/** A Gmail message as the loop's InboundMail. The Gmail id is the dedupe key and what a reply threads to. */
export function toInbound(j: GmailMessage, ownAddress: string): InboundMail {
  const h = headersOf(j.payload);
  const from = parseAddress(h["from"] ?? "");
  return {
    id: j.id,
    inboxId: ownAddress,
    threadId: j.threadId ?? j.id,
    fromAddress: from.address,
    fromName: from.name,
    to: addresses(h["to"]),
    subject: h["subject"] ?? "",
    text: textOf(j.payload).trim(),
    receivedAt: Number(j.internalDate) || Date.now(),
    messageId: h["message-id"],
    inReplyTo: h["in-reply-to"],
    references: h["references"],
    headers: h,
  };
}

const reSubject = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s || "your message"}`);

// ---- OAuth ---------------------------------------------------------------------------------------

/** Where the owner consents. `redirectUri` must be byte for byte what the OAuth client registered. */
export function consentUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GMAIL_SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
  });
  return `${AUTH_URL}?${q}`;
}

/** The consent's code for a refresh token, and whose mailbox it opens. */
export async function exchangeCode(
  o: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  f: Fetch = fetch,
): Promise<{ refreshToken: string; address: string; scope: string }> {
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: "authorization_code" }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google token exchange ${res.status}: ${j.error_description ?? j.error ?? "no access token"}`);
  if (!j.refresh_token) throw new Error("Google returned no refresh token; remove the app at myaccount.google.com/permissions and connect again");
  const me = await f(`${API}/profile`, { headers: { authorization: `Bearer ${j.access_token}` } });
  if (!me.ok) throw new Error(`Gmail profile ${me.status}: ${(await me.text()).slice(0, 200)}`);
  const { emailAddress } = (await me.json()) as { emailAddress: string };
  return { refreshToken: j.refresh_token, address: emailAddress.toLowerCase(), scope: j.scope ?? "" };
}

// ---- the client ----------------------------------------------------------------------------------

// Access tokens live an hour; an isolate that stays warm reuses one instead of refreshing per call.
const tokens = new Map<string, { token: string; exp: number }>();

export class Gmail {
  constructor(
    private readonly creds: GmailCreds,
    private address: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    const hit = tokens.get(this.creds.refreshToken);
    if (hit && Date.now() < hit.exp - 60_000) return hit.token;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId, client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken, grant_type: "refresh_token",
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google token refresh ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { access_token: string; expires_in?: number };
    tokens.set(this.creds.refreshToken, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gmail ${method} ${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async profile(): Promise<{ emailAddress: string }> {
    return await this.call("GET", "/profile");
  }

  private async own(): Promise<string> {
    this.address ??= (await this.profile()).emailAddress.toLowerCase();
    return this.address;
  }

  /**
   * Inbox mail since `sinceMs` (Gmail's `after:` is whole seconds), oldest first. `seen` names the
   * ids already taken in, so they aren't fetched again.
   */
  async pull(sinceMs: number, seen: (ids: string[]) => Promise<string[]> = async () => []): Promise<InboundMail[]> {
    const q = `${PULL_QUERY} after:${Math.floor(sinceMs / 1000)}`;
    const ids: string[] = [];
    let page: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: "100", ...(page ? { pageToken: page } : {}) });
      const r = await this.call<{ messages?: Array<{ id: string }>; nextPageToken?: string }>("GET", `/messages?${params}`);
      ids.push(...(r.messages ?? []).map((m) => m.id));
      page = r.nextPageToken;
    } while (page && ids.length < MAX_IDS);
    const already = new Set(await seen(ids));
    const own = await this.own();
    const out: InboundMail[] = [];
    for (const id of ids.slice(0, MAX_IDS).reverse()) {
      if (already.has(id)) continue;
      out.push(toInbound(await this.call<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}?format=full`), own));
    }
    return out;
  }

  async send(m: Omit<Outgoing, "from">, threadId?: string): Promise<{ messageId: string; threadId: string }> {
    const raw = buildRaw({ ...m, from: await this.own() });
    const r = await this.call<{ id: string; threadId: string }>("POST", "/messages/send", threadId ? { raw, threadId } : { raw });
    return { messageId: r.id, threadId: r.threadId };
  }

  /**
   * A reply in the thread of Gmail message `id`: to its Reply-To (else its From), subject and
   * References carried on. Replying to the owner's own message answers whoever it went to.
   */
  async reply(id: string, m: { text: string; html?: string }): Promise<{ messageId: string; threadId: string }> {
    const want = ["From", "Reply-To", "To", "Subject", "Message-ID", "References"].map((h) => `metadataHeaders=${h}`).join("&");
    const orig = await this.call<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}?format=metadata&${want}`);
    const h = headersOf(orig.payload);
    const own = await this.own();
    const sender = parseAddress(h["reply-to"] ?? h["from"] ?? "").address;
    const to = sender && sender !== own ? [sender] : addresses(h["to"]).filter((a) => a !== own);
    if (!to.length) throw new Error(`Gmail message ${id} has no one to reply to`);
    return await this.send(
      { to, subject: reSubject(h["subject"] ?? ""), text: m.text, html: m.html, inReplyTo: h["message-id"], references: h["references"] },
      orig.threadId,
    );
  }
}
