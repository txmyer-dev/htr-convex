// Event dispatch (U6): an approved event card writes the event or the move on `primary`, then
// replies in thread, once. Covers the re-check at approval (R16), the retry paths (R15), the
// write gate (R14) and the hex event id (KTD5). Offline: Google, Gmail and ntfy are one fake fetch.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { TENANTS } from "../convex/install";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import { eventIdFor } from "../convex/mail";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["HTR_RULING_SECRET", "CONVEX_SITE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "HTR_NTFY_TOPIC"];
const ZONE = "America/New_York";
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 13, 0); // Tue Oct 20 2026, 9:00 AM New York
const START = Date.UTC(2026, 9, 21, 18, 0); // Wed Oct 21 2026, 2:00 PM New York
const END = START + 30 * MIN;
const REPLY = "Wednesday at 2 works, the invite is on its way.";
const WITH_CALENDAR = `${GMAIL_READ} ${GMAIL_SEND} ${CALENDAR_READ} ${CALENDAR_OWNED}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const iso = (ms: number) => new Date(ms).toISOString();

type Stored = { id: string; status: string; start: number; end: number; summary?: string; attendees?: string[] };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };

/**
 * One fake for everything dispatch touches. `primary` holds the events Google has by id (cancelled
 * ones included); `others` is busy time on the family calendar. `onInsert` / `failSend` / `getQueue`
 * script the failures a test needs.
 */
function world(over: {
  primary?: Stored[];
  others?: Array<{ start: number; end: number }>;
  onInsert?: (c: Call) => Response | undefined;
  failSend?: boolean;
  /** Answers for the next GETs of one event id, before the store is consulted. */
  getQueue?: Record<string, Array<Stored | null>>;
} = {}) {
  const primary = new Map((over.primary ?? []).map((e) => [e.id, e]));
  const calls: Call[] = [];
  const pushes: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const raw = (e: Stored) => ({
    id: e.id, status: e.status, summary: e.summary ?? "x", start: { dateTime: iso(e.start) }, end: { dateTime: iso(e.end) },
    attendees: (e.attendees ?? []).map((email) => ({ email })), organizer: { self: true },
  });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.origin === "https://ntfy.sh") {
      pushes.push(body);
      return json({});
    }
    if (url.origin === "https://gmail.googleapis.com") {
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (method === "GET" && path === "/messages/gm-src") {
        return json({ id: "gm-src", threadId: "th-src", payload: { headers: [
          { name: "From", value: "Sam <sam@acme.co>" }, { name: "To", value: "ben@gmail.com" },
          { name: "Subject", value: "Meet?" }, { name: "Message-ID", value: "<orig@acme.co>" },
        ] } });
      }
      if (method === "POST" && path === "/messages/send") {
        if (over.failSend) return json({ error: { message: "mail backend" } }, 500);
        sent.push(body);
        return json({ id: `gm-out-${sent.length}`, threadId: body.threadId ?? "new" });
      }
      return json({ error: { message: `no gmail route ${method} ${path}` } }, 500);
    }
    const path = url.pathname.replace("/calendar/v3", "");
    const c: Call = { method, path, query: url.searchParams, body };
    calls.push(c);
    if (path === "/users/me/calendarList") return json({ items: [{ id: "ben@gmail.com", summary: "Ben", primary: true }, { id: "family@group", summary: "Family" }] });
    if (method === "POST" && path === "/freeBusy") {
      return json({ calendars: { "family@group": { busy: (over.others ?? []).map((b) => ({ start: iso(b.start), end: iso(b.end) })) } } });
    }
    if (method === "GET" && path === "/calendars/primary/events") {
      const lo = Date.parse(url.searchParams.get("timeMin")!);
      const hi = Date.parse(url.searchParams.get("timeMax")!);
      return json({ timeZone: ZONE, items: [...primary.values()].filter((e) => e.start < hi && e.end > lo).map(raw) });
    }
    if (method === "POST" && path === "/calendars/primary/events") {
      const scripted = over.onInsert?.(c);
      if (scripted) return scripted;
      if (primary.has(body.id)) return json({ error: { code: 409, message: "The requested identifier already exists." } }, 409);
      const e: Stored = { id: body.id, status: "confirmed", start: Date.parse(body.start.dateTime), end: Date.parse(body.end.dateTime), summary: body.summary, attendees: body.attendees.map((a: { email: string }) => a.email) };
      primary.set(e.id, e);
      return json(raw(e));
    }
    const one = /^\/calendars\/primary\/events\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (method === "GET") {
        const q = over.getQueue?.[id];
        if (q?.length) {
          const next = q.shift()!;
          return next ? json(raw(next)) : json({ error: { message: "Not Found" } }, 404);
        }
        const e = primary.get(id);
        return e ? json(raw(e)) : json({ error: { message: "Not Found" } }, 404);
      }
      if (method === "PATCH") {
        const e = primary.get(id);
        if (!e) return json({ error: { message: "Not Found" } }, 404);
        e.start = Date.parse(body.start.dateTime);
        e.end = Date.parse(body.end.dateTime);
        return json(raw(e));
      }
    }
    return json({ error: { message: `no calendar route ${method} ${path}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, calls, pushes, sent, primary };
}

/** The non-read calendar requests: everything except GETs and the free/busy query. */
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/freeBusy");

let rt = 0;
async function setup(scope = WITH_CALENDAR) {
  Object.assign(process.env, {
    HTR_RULING_SECRET: "test-secret", CONVEX_SITE_URL: "https://test.convex.site",
    GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec", HTR_NTFY_TOPIC: "htr-test",
  });
  const t = convexTest(schema, modules);
  const base = { ...TENANTS[0], timeZone: ZONE, business: { agentName: "Ekko" }, tasks: undefined } as Omit<Doc<"tenants">, "_id" | "_creationTime">;
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      ...base, slug: "ben", owner: { ...base.owner, email: "ben@gmail.com" }, adapters: { mail: { kind: "gmail" } },
      channels: { gmail: { address: "ben@gmail.com", refreshToken: `rt-dispatch-${++rt}`, grantedAt: 1, scope } },
    });
    const messageId = await ctx.db.insert("messages", {
      tenantId, channel: "email", direction: "in", fromAddress: "sam@acme.co", toAddress: "ben@gmail.com", body: "Can we do Wednesday at 2?",
      at: NOW - 60 * MIN, vendorRef: "gm-src", threadId: "th-src", meta: { subject: "Meet?", messageId: "<orig@acme.co>", name: "Sam" },
    });
    return { tenantId, messageId };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
type CardEvent = NonNullable<Doc<"proposals">["meta"]["event"]>;
const insertEvent: CardEvent = { op: "insert", title: "Call with Sam", startMs: START, endMs: END, timeZone: ZONE, attendees: ["sam@acme.co"] };

async function card(t: T, tenantId: Id<"tenants">, messageId: Id<"messages">, event: Partial<CardEvent> = {}, over: Partial<Doc<"proposals">> = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("proposals", {
      tenantId, kind: "event", toAddress: "sam@acme.co", toName: "Sam", body: REPLY, basis: [], summary: "Event", status: "signed",
      edited: false, createdAt: NOW, sourceKind: "email", sourceId: messageId,
      meta: { subject: "Meet?", threadId: "th-src", messageId: "gm-src", event: { ...insertEvent, ...event } }, ...over,
    }),
  );
}

const get = (t: T, id: Id<"proposals">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const scheduled = (t: T, name: string) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes(name)));
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

describe("the event id", () => {
  test("a proposal id with w-z in it becomes lowercase hex inside Google's alphabet, the same every time", () => {
    const id = "jd7wxyz2k9vq0z1mwxyzt8e3c17r6abc";
    expect(eventIdFor(id)).toBe(hex(id));
    expect(eventIdFor(id)).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(eventIdFor(id)).toBe(eventIdFor(id));
  });
});

describe("insert", () => {
  test("AE1: a signed card writes one event under the derived id with sendUpdates=all, then replies in the source thread", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world();
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");

    const inserts = writes(w.calls);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].path).toBe("/calendars/primary/events");
    expect(inserts[0].query.get("sendUpdates")).toBe("all");
    expect(inserts[0].body).toMatchObject({
      id: hex(id), summary: "Call with Sam", attendees: [{ email: "sam@acme.co" }],
      start: { dateTime: iso(START), timeZone: ZONE }, end: { dateTime: iso(END), timeZone: ZONE },
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].threadId).toBe("th-src");
    const mime = Buffer.from(String(w.sent[0].raw), "base64url").toString();
    expect(mime).toContain("To: sam@acme.co");
    expect(mime).toContain(Buffer.from(REPLY).toString("base64")); // the body part is base64 too

    const p = await get(t, id);
    expect(p.status).toBe("sent");
    expect(p.meta.event?.eventId).toBe(hex(id));
    expect(await scheduled(t, "calendar:refresh")).toHaveLength(1);
  });

  test("AE4: a pending, rejected or expired card dispatches nothing", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world();
    vi.stubGlobal("fetch", w.f);
    for (const status of ["pending", "rejected", "expired"] as const) {
      const id = await card(t, tenantId, messageId, {}, { status });
      expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("nothing to do");
      expect((await get(t, id)).status).toBe(status);
    }
    expect(w.calls).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  test("AE4: dispatching a signed card twice writes one event and sends one reply", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world();
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    await Promise.all([t.action(internal.mail.dispatch, { proposalId: id }), t.action(internal.mail.dispatch, { proposalId: id })]);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("nothing to do");
    expect(writes(w.calls)).toHaveLength(1);
    expect(w.primary.size).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  test("AE6: an insert that fails sends no reply, the card fails with the reason, and a retry completes both", async () => {
    const { t, tenantId, messageId } = await setup();
    let down = true;
    const w = world({ onInsert: () => (down ? json({ error: { message: "backend error" } }, 503) : undefined) });
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow("503");
    let p = await get(t, id);
    expect(p.status).toBe("failed");
    expect(p.error).toContain("503");
    expect(p.meta.event?.eventId).toBeUndefined();
    expect(w.sent).toEqual([]);
    expect(w.pushes.map((n) => n.title)).toEqual(["Not sent: Call with Sam"]);

    down = false;
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");
    p = await get(t, id);
    expect(p.status).toBe("sent");
    expect(w.primary.size).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  test("the event is written, the reply fails; a retry sends only the reply, with no second insert", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world({ failSend: true });
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow("Gmail");
    let p = await get(t, id);
    expect(p.status).toBe("failed");
    expect(p.meta.event?.eventId).toBe(hex(id)); // on the calendar already

    const w2 = world({ primary: [...w.primary.values()] });
    vi.stubGlobal("fetch", w2.f);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");
    expect(w2.calls).toEqual([]); // the recorded id: no GET, no re-check, no write
    expect(w2.sent).toHaveLength(1);
    p = await get(t, id);
    expect(p.status).toBe("sent");
  });

  test("the event was written but its id never recorded (a crash): the retry replies, not 'no longer free'", async () => {
    const { t, tenantId, messageId } = await setup();
    const id = await card(t, tenantId, messageId);
    // Google has the event at the card's time, and the invite shows on the family calendar too.
    const w = world({ primary: [{ id: hex(id), status: "confirmed", start: START, end: END }], others: [{ start: START, end: END }] });
    vi.stubGlobal("fetch", w.f);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");
    expect(writes(w.calls)).toEqual([]);
    expect(w.sent).toHaveLength(1);
    const p = await get(t, id);
    expect(p.status).toBe("sent");
    expect(p.meta.event?.eventId).toBe(hex(id));
  });

  test("a 409 whose GET returns a live event counts as written", async () => {
    const { t, tenantId, messageId } = await setup();
    const id = await card(t, tenantId, messageId);
    const live: Stored = { id: hex(id), status: "confirmed", start: START, end: END };
    // The first GET sees nothing (written by a racing dispatch a moment later), the insert collides.
    const w = world({ primary: [live], getQueue: { [hex(id)]: [null] } });
    vi.stubGlobal("fetch", w.f);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");
    expect(writes(w.calls)).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
    expect((await get(t, id)).meta.event?.eventId).toBe(hex(id));
  });

  test("a 409 whose GET returns a cancelled event fails the card, with no reply", async () => {
    const { t, tenantId, messageId } = await setup();
    const id = await card(t, tenantId, messageId);
    const w = world({ primary: [{ id: hex(id), status: "cancelled", start: START, end: END }] });
    vi.stubGlobal("fetch", w.f);
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow("deleted on your calendar");
    const p = await get(t, id);
    expect(p.status).toBe("failed");
    expect(p.error).toContain("this event was deleted on your calendar");
    expect(p.meta.event?.eventId).toBeUndefined();
    expect(w.sent).toEqual([]);
  });

  test("calendar not connected: the card fails saying so, nothing written or sent", async () => {
    const { t, tenantId, messageId } = await setup(`${GMAIL_READ} ${GMAIL_SEND}`);
    const w = world();
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow("calendar not connected");
    expect((await get(t, id)).status).toBe("failed");
    expect(w.calls).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});

describe("no longer free", () => {
  test("AE7: a time booked on another calendar closes the card as expired, writes and sends nothing, and redrafts", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world({ others: [{ start: START, end: START + 60 * MIN }] });
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("no longer free");

    expect(writes(w.calls)).toEqual([]);
    expect(w.sent).toEqual([]);
    const p = await get(t, id);
    expect(p.status).toBe("expired");
    expect(p.error).toBe("Wed Oct 21, 2:00 PM is no longer free");
    expect(w.pushes).toHaveLength(1);
    expect(String(w.pushes[0].message)).toContain("Wed Oct 21, 2:00 PM is no longer free");
    const drafts = await scheduled(t, "drafter:draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].args[0]).toEqual({ messageId });
    expect(await scheduled(t, "calendar:refresh")).toHaveLength(0);
  });

  test("outside working hours at approval is not clean either", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world();
    vi.stubGlobal("fetch", w.f);
    const evening = Date.UTC(2026, 9, 21, 23, 0); // 7:00 PM New York
    const id = await card(t, tenantId, messageId, { startMs: evening, endMs: evening + 30 * MIN });
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("no longer free");
    expect((await get(t, id)).error).toBe("Wed Oct 21, 7:00 PM is no longer free");
    expect(writes(w.calls)).toEqual([]);
  });
});

describe("move", () => {
  const OLD = Date.UTC(2026, 9, 21, 17, 30); // Wed 1:30 PM New York, 60 minutes
  const target = (): Stored => ({ id: "evt-weekly", status: "confirmed", start: OLD, end: OLD + 60 * MIN, attendees: ["sam@acme.co", "ann@y.co"] });
  const moveTo = { op: "move" as const, title: "Weekly sync", targetEventId: "evt-weekly", startMs: START, endMs: START + 60 * MIN, previousStartMs: OLD, previousEndMs: OLD + 60 * MIN };

  test("a 60-minute move shifted by 30 minutes isn't blocked by its own old slot; only start and end are patched", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world({ primary: [target()] });
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId, moveTo);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");

    const ws = writes(w.calls);
    expect(ws).toHaveLength(1);
    expect(ws[0].method).toBe("PATCH");
    expect(ws[0].path).toBe("/calendars/primary/events/evt-weekly");
    expect(ws[0].query.get("sendUpdates")).toBe("all");
    expect(Object.keys(ws[0].body!).sort()).toEqual(["end", "start"]);
    expect(w.primary.get("evt-weekly")).toMatchObject({ start: START, end: START + 60 * MIN, attendees: ["sam@acme.co", "ann@y.co"] });
    expect(w.sent).toHaveLength(1);
    const p = await get(t, id);
    expect(p.status).toBe("sent");
    expect(p.meta.event?.eventId).toBe("evt-weekly");
  });

  test("on retry with the target already at the new time, the patch is skipped and only the reply goes", async () => {
    const { t, tenantId, messageId } = await setup();
    const w = world({ primary: [{ ...target(), start: START, end: START + 60 * MIN }] });
    vi.stubGlobal("fetch", w.f);
    const id = await card(t, tenantId, messageId, moveTo);
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("sent");
    expect(writes(w.calls)).toEqual([]);
    expect(w.calls.filter((c) => c.path === "/calendars/primary/events/evt-weekly")).toHaveLength(1); // the GET
    expect(w.sent).toHaveLength(1);
  });

  test("a move whose target was deleted fails the card without inserting a new event", async () => {
    const { t, tenantId, messageId } = await setup();
    for (const primary of [[], [{ ...target(), status: "cancelled" }]]) {
      const w = world({ primary });
      vi.stubGlobal("fetch", w.f);
      const id = await card(t, tenantId, messageId, moveTo);
      await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow("deleted on your calendar");
      expect((await get(t, id)).status).toBe("failed");
      expect(writes(w.calls)).toEqual([]);
      expect(w.sent).toEqual([]);
    }
  });
});

describe("the newest proposal for a source", () => {
  test("bySource returns the newest card once a redraft exists, and propose makes a new one past an expired event card", async () => {
    const { t, tenantId, messageId } = await setup();
    const first = await card(t, tenantId, messageId, {}, { status: "expired", createdAt: NOW - 1000 });
    const second = await t.run(async (ctx) => {
      const { propose } = await import("../convex/proposals");
      return (await propose(ctx, { tenantId, toAddress: "sam@acme.co", body: "Here are three times.", sourceKind: "email", sourceId: messageId }))._id;
    });
    expect(second).not.toBe(first);
    const newest = await t.run(async (ctx) => {
      const { bySource } = await import("../convex/proposals");
      return (await bySource(ctx, tenantId, "email", messageId))?._id;
    });
    expect(newest).toBe(second);
  });
});
