// The Gmail claw (phase 3): the wire against a stubbed Google, the pull into the shared receive
// path, and consent as an HTTP route. Offline like the rest.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { clawsOf, mailClaw } from "../convex/adapters/resolve";
import { mintState, readState } from "../convex/gmail";
import { TENANTS } from "../convex/install";
import { b64url, buildRaw, Gmail, PULL_QUERY, textOf, toInbound, unb64url, type GmailMessage } from "../convex/lib/mail/gmail";
import schema from "../convex/schema";
import { surfaceKey } from "../convex/surface";

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GMAIL_ADDRESS", "AGENTMAIL_API_KEY"];

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The raw message's header block and decoded text/plain body. */
function decode(raw: string): { headers: string; body: string } {
  const msg = unb64url(raw);
  const [headers, ...rest] = msg.split("\r\n\r\n");
  return { headers, body: unb64url(rest.join("\r\n\r\n").replace(/\r\n/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) };
}

function message(id: string, over: { from?: string; subject?: string; text?: string; at?: number; headers?: Array<{ name: string; value: string }>; threadId?: string } = {}): GmailMessage {
  return {
    id, threadId: over.threadId ?? `th-${id}`, internalDate: String(over.at ?? 1_791_000_000_000),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: over.from ?? "Sam Lee <sam@acme.co>" },
        { name: "To", value: "Ben Hidalgo <ben@gmail.com>" },
        { name: "Subject", value: over.subject ?? "Quote for the deck" },
        { name: "Message-ID", value: `<${id}@mail.acme.co>` },
        ...(over.headers ?? []),
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url(over.text ?? "Can you send the quote by Friday?") } },
        { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
      ],
    },
  };
}

/** A stubbed Google: token refresh, list, get, send. Records every call. */
function google(o: { list?: string[]; messages?: Record<string, GmailMessage>; profile?: string } = {}) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const sent: Array<{ raw: string; threadId?: string }> = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : init.body ? String(init.body) : undefined });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init.body));
      if (p.get("grant_type") === "authorization_code") {
        return json({ access_token: "at-code", refresh_token: "rt-new", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" });
      }
      return json({ access_token: `at-${p.get("refresh_token")}`, expires_in: 3600 });
    }
    const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: o.profile ?? "ben@gmail.com" });
    if (path.startsWith("/messages?")) return json({ messages: (o.list ?? []).map((id) => ({ id })) });
    if (path === "/messages/send") {
      const b = JSON.parse(String(init.body));
      sent.push(b);
      return json({ id: `sent-${sent.length}`, threadId: b.threadId ?? "new-thread" });
    }
    const m = /^\/messages\/([^?]+)/.exec(path);
    if (m && o.messages?.[decodeURIComponent(m[1])]) return json(o.messages[decodeURIComponent(m[1])]);
    return json({ error: "not found" }, 404);
  });
  return { f: f as unknown as typeof fetch, calls, sent };
}

let rt = 0;
const creds = () => ({ clientId: "cid", clientSecret: "csec", refreshToken: `rt-${++rt}` }); // fresh token each test: the access-token cache is per refresh token

describe("the wire", () => {
  test("a plain message: UTF-8 subject encoded, body base64, threading headers, no header injection", () => {
    const raw = buildRaw({
      from: "ben@gmail.com", to: ["sam@acme.co\r\nBcc: evil@x.com"], subject: "Café — the quote", text: "Hi Sam,\n\nAttached. ✓",
      inReplyTo: "<a@acme.co>", references: "<z@acme.co>", headers: { "X-HTR-Site": "ben:p1:tok", "Bad\r\nHeader": "x" },
    });
    const { headers, body } = decode(raw);
    expect(headers).toContain("From: ben@gmail.com");
    expect(headers).toContain("To: sam@acme.co Bcc: evil@x.com"); // one header, not two
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/m);
    expect(headers).toContain("In-Reply-To: <a@acme.co>");
    expect(headers).toContain("References: <z@acme.co> <a@acme.co>");
    expect(headers).toContain("X-HTR-Site: ben:p1:tok");
    expect(headers).not.toContain("Bad");
    expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toBe("Hi Sam,\n\nAttached. ✓");
  });

  test("with html: multipart/alternative carrying both", () => {
    const msg = unb64url(buildRaw({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "plain", html: "<b>rich</b>" }));
    expect(msg).toMatch(/Content-Type: multipart\/alternative; boundary="htr-/);
    expect(msg.match(/Content-Type: text\/(plain|html); charset=UTF-8/g)).toHaveLength(2);
  });

  test("text: text/plain first, html stripped as a fallback", () => {
    expect(textOf(message("m1").payload)).toBe("Can you send the quote by Friday?");
    expect(textOf({ mimeType: "text/html", body: { data: b64url("<style>x{}</style><p>Hello&nbsp;there</p>") } }).trim()).toBe("Hello there");
  });

  test("toInbound: addresses, lowercased headers, Gmail id as the dedupe key", () => {
    const m = toInbound(message("m1", { headers: [{ name: "List-Unsubscribe", value: "<mailto:u@x>" }, { name: "Cc", value: '"Lee, Sam" <s@x.co>' }] }), "ben@gmail.com");
    expect(m).toMatchObject({ id: "m1", inboxId: "ben@gmail.com", threadId: "th-m1", fromAddress: "sam@acme.co", fromName: "Sam Lee", to: ["ben@gmail.com"], messageId: "<m1@mail.acme.co>" });
    expect(m.headers?.["list-unsubscribe"]).toBe("<mailto:u@x>");
  });
});

describe("the client", () => {
  test("pull: Primary inbox only, after the cursor, oldest first, seen ids never fetched; one token refresh", async () => {
    const g = google({ list: ["m3", "m2", "m1"], messages: { m1: message("m1"), m2: message("m2"), m3: message("m3") } });
    const out = await new Gmail(creds(), "ben@gmail.com", g.f).pull(1_791_000_000_999, async (ids) => ids.filter((i) => i === "m2"));
    expect(out.map((m) => m.id)).toEqual(["m1", "m3"]);
    const list = new URL(g.calls.find((c) => c.url.includes("/messages?"))!.url);
    expect(list.searchParams.get("q")).toBe(`${PULL_QUERY} after:1791000000`);
    expect(PULL_QUERY).toMatch(/-from:me/);
    for (const c of ["promotions", "social", "updates", "forums"]) expect(PULL_QUERY).toContain(`-category:${c}`);
    expect(g.calls.filter((c) => c.url.includes("/messages/m2"))).toHaveLength(0);
    expect(g.calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  test("reply: to Reply-To, in the thread, Re: subject, References carried", async () => {
    const g = google({ messages: { m1: message("m1", { threadId: "th-9", headers: [{ name: "Reply-To", value: "Desk <desk@acme.co>" }, { name: "References", value: "<r0@acme.co>" }] }) } });
    const r = await new Gmail(creds(), "ben@gmail.com", g.f).reply("m1", { text: "Friday works." });
    expect(r).toEqual({ messageId: "sent-1", threadId: "th-9" });
    expect(g.sent[0].threadId).toBe("th-9");
    const { headers, body } = decode(g.sent[0].raw);
    expect(headers).toContain("To: desk@acme.co");
    expect(headers).toContain("Subject: Re: Quote for the deck");
    expect(headers).toContain("In-Reply-To: <m1@mail.acme.co>");
    expect(headers).toContain("References: <r0@acme.co> <m1@mail.acme.co>");
    expect(body).toBe("Friday works.");
  });

  test("reply to the owner's own message answers whoever it went to", async () => {
    const own = message("m1", { from: "Ben <BEN@gmail.com>" });
    own.payload!.headers = own.payload!.headers!.map((h) => (h.name === "To" ? { name: "To", value: "sam@acme.co" } : h));
    const g2 = google({ messages: { m1: own } });
    await new Gmail(creds(), "ben@gmail.com", g2.f).reply("m1", { text: "Following up." });
    expect(decode(g2.sent[0].raw).headers).toContain("To: sam@acme.co");
  });

  test("no address configured: the profile names the sender", async () => {
    const g = google({ profile: "Ben@Gmail.com" });
    await new Gmail(creds(), undefined, g.f).send({ to: ["sam@acme.co"], subject: "Hi", text: "x" });
    expect(decode(g.sent[0].raw).headers).toContain("From: ben@gmail.com");
  });
});

function tenant(over: Partial<Doc<"tenants">> = {}): Doc<"tenants"> {
  return { _id: "t1" as Doc<"tenants">["_id"], _creationTime: 0, ...TENANTS[0], channels: {}, ...over } as Doc<"tenants">;
}

describe("resolve", () => {
  test("gmail: the OAuth client from env, the refresh token from the grant; says what's missing", () => {
    const t = tenant({ adapters: { mail: { kind: "gmail" } } });
    expect(() => mailClaw(t)).toThrow("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET");
    Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec" });
    expect(() => mailClaw(t)).toThrow("has not connected Gmail");
    const granted = tenant({ adapters: { mail: { kind: "gmail" } }, channels: { gmail: { address: "ben@gmail.com", refreshToken: "rt", grantedAt: 1 } } });
    expect(mailClaw(granted).name).toBe("gmail");
    expect(clawsOf(granted).find((c) => c.port === "mail")?.claw?.name).toBe("gmail");
  });

  test("an unconnected Gmail shows on the heartbeat as down, with the reason", () => {
    const t = tenant({ adapters: { mail: { kind: "gmail" } } });
    const mail = clawsOf(t).find((c) => c.port === "mail")!;
    expect(mail.claw).toBeNull();
    expect(mail.error).toMatch(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});

describe("consent state", () => {
  test("binds tenant and time; expired, tampered or forged states are refused", async () => {
    process.env.HTR_RULING_SECRET = "test-secret";
    const now = 1_791_000_000_000;
    const s = await mintState("ben", now);
    expect(await readState(s, now + 60_000)).toBe("ben");
    expect(await readState(s, now + 16 * 60_000)).toBeNull();
    expect(await readState(s.replace(/^ben/, "tony"), now)).toBeNull();
    expect(await readState("ben.1.abc", now)).toBeNull();
    expect(await readState("", now)).toBeNull();
  });
});

async function setup(grant = true) {
  Object.assign(process.env, { HTR_RULING_SECRET: "test-secret", CONVEX_SITE_URL: "https://ben.example.com", GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec" });
  const t = convexTest(schema, modules);
  const tenantId = await t.run(async (ctx) => {
    const { _id, _creationTime, ...base } = tenant();
    return await ctx.db.insert("tenants", {
      ...base, slug: "ben", owner: { ...base.owner, email: "ben@gmail.com" }, adapters: { mail: { kind: "gmail" } }, tasks: undefined,
      business: { agentName: "Ekko" },
      channels: grant ? { gmail: { address: "ben@gmail.com", refreshToken: `rt-pull-${++rt}`, grantedAt: Date.now() } } : {},
    });
  });
  return { t, tenantId };
}

describe("the pull", () => {
  test("new mail lands in receive once: a person is drafted, a newsletter is recorded, a second pull takes nothing", async () => {
    const { t, tenantId } = await setup();
    const g = google({
      list: ["n1", "p1"],
      messages: {
        p1: message("p1", { at: Date.now() - 60_000 }),
        n1: message("n1", { from: "news@updates.vendor.com", subject: "This week", headers: [{ name: "List-Unsubscribe", value: "<u>" }] }),
      },
    });
    vi.stubGlobal("fetch", g.f);
    expect(await t.action(internal.gmail.pullAll, {})).toBe(2);
    const msgs = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    expect(msgs.map((m) => [m.vendorRef, m.meta.automated])).toEqual([["p1", false], ["n1", true]]);
    const drafts = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes("drafter")));
    expect(drafts).toHaveLength(1);
    const cursor = await t.query(internal.gmail.cursor, { tenantId });
    expect(cursor).toBeGreaterThan(0);

    const fetched = g.calls.filter((c) => /\/messages\/(p1|n1)/.test(c.url)).length;
    expect(await t.action(internal.gmail.pullAll, {})).toBe(0);
    expect(g.calls.filter((c) => /\/messages\/(p1|n1)/.test(c.url)).length).toBe(fetched); // seen: not fetched again
    const list = g.calls.filter((c) => c.url.includes("/messages?")).map((c) => Number(new URL(c.url).searchParams.get("q")!.split("after:")[1]));
    expect(list[1] * 1000).toBeLessThanOrEqual(cursor!); // the overlap re-lists, the dedupe holds
  });

  test("a failing tenant doesn't stop the cron", async () => {
    const { t } = await setup(false); // no grant: mailClaw throws
    vi.stubGlobal("fetch", google().f);
    expect(await t.action(internal.gmail.pullAll, {})).toBe(0);
  });
});

describe("consent over HTTP", () => {
  test("start needs the surface key, and sends Google the exact redirect", async () => {
    const { t } = await setup(false);
    expect((await t.fetch("/oauth/google/ben/start?k=nope")).status).toBe(401);
    const res = await t.fetch(`/oauth/google/ben/start?k=${await surfaceKey("ben")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe("https://ben.example.com/oauth/google/callback");
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(await readState(to.searchParams.get("state")!)).toBe("ben");
  });

  test("the callback keeps the grant on the tenant; a forged state keeps nothing", async () => {
    const { t, tenantId } = await setup(false);
    vi.stubGlobal("fetch", google().f);
    expect((await t.fetch("/oauth/google/callback?code=c&state=ben.1.forged")).status).toBe(400);
    const ok = await t.fetch(`/oauth/google/callback?code=c&state=${encodeURIComponent(await mintState("ben"))}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Gmail connected");
    const after = await t.run(async (ctx) => await ctx.db.get(tenantId));
    expect(after?.channels.gmail).toMatchObject({ address: "ben@gmail.com", refreshToken: "rt-new" });
  });
});
