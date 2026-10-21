// The desk's calendar snapshot (U4): the refresh cron over a fake Google, replace-not-append, a
// mail-only tenant left alone, a failed refresh keeping the last snapshot, and the surface query.
// Offline: every request goes to the fake below.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { TENANTS } from "../convex/install";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import { atLocalHour, localParts } from "../convex/lib/time";
import schema from "../convex/schema";
import { surfaceKey } from "../convex/surface";

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["HTR_RULING_SECRET", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
const ZONE = "America/New_York";
const MAIL_ONLY = `${GMAIL_READ} ${GMAIL_SEND}`;
const WITH_CALENDAR = `${MAIL_ONLY} ${CALENDAR_READ} ${CALENDAR_OWNED}`;

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Raw = { id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; attendees?: Array<{ email: string; self?: boolean; responseStatus?: string }>; organizer?: { self?: boolean } };

/** A fake Google: two calendars, each with the events `events` holds; `fail` makes every events read a 500. */
function google(state: { events: Record<string, Raw[]>; fail?: boolean }) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    calls.push(url.pathname);
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      return json({ items: [{ id: "ben@gmail.com", summary: "Ben", primary: true }, { id: "family@group", summary: "Family" }, { id: "hidden@group", summary: "Hidden", hidden: true }] });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (m) {
      if (state.fail) return json({ error: { message: "backend error" } }, 500);
      return json({ timeZone: ZONE, items: state.events[decodeURIComponent(m[1])] ?? [] });
    }
    return json({ error: { message: `no route for ${url.pathname}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const iso = (ms: number) => new Date(ms).toISOString();
const ymd = (ms: number) => {
  const p = localParts(ms, ZONE);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

let rt = 0;
async function setup() {
  Object.assign(process.env, { HTR_RULING_SECRET: "test-secret", GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec" });
  const t = convexTest(schema, modules);
  const base = { ...TENANTS[0], timeZone: ZONE, business: { agentName: "Ekko" }, tasks: undefined } as Omit<Doc<"tenants">, "_id" | "_creationTime">;
  const ids = await t.run(async (ctx) => ({
    ben: await ctx.db.insert("tenants", {
      ...base, slug: "ben", adapters: { mail: { kind: "gmail" } },
      channels: { gmail: { address: "ben@gmail.com", refreshToken: `rt-snap-${++rt}`, grantedAt: 1, scope: WITH_CALENDAR } },
    }),
    mailOnly: await ctx.db.insert("tenants", {
      ...base, slug: "mo", adapters: { mail: { kind: "gmail" } },
      channels: { gmail: { address: "mo@gmail.com", refreshToken: `rt-snap-${++rt}`, grantedAt: 1, scope: MAIL_ONLY } },
    }),
    agentMail: await ctx.db.insert("tenants", { ...base, slug: "am", adapters: { mail: { kind: "agentmail" } }, channels: { inboxId: "inb" } }),
  }));
  return { t, ...ids };
}

const rowsOf = (t: ReturnType<typeof convexTest>, tenantId: Doc<"tenants">["_id"]) =>
  t.run(async (ctx) => await ctx.db.query("calendarEvents").withIndex("by_tenant_start", (q) => q.eq("tenantId", tenantId)).collect());

// Tomorrow 10:00 local, a timed meeting on Ben's calendar; the day after tomorrow, a two-day all-day event on Family.
const now = Date.now();
const MEET = atLocalHour(now, ZONE, 1, 10);
const OFFSITE = atLocalHour(now, ZONE, 2, 0);
const firstEvents = (): Record<string, Raw[]> => ({
  "ben@gmail.com": [{
    id: "m1", summary: "Quote review", start: { dateTime: iso(MEET) }, end: { dateTime: iso(MEET + 30 * 60_000) },
    attendees: [{ email: "Sam@Acme.co" }, { email: "ben@gmail.com", self: true, responseStatus: "accepted" }], organizer: { self: true },
  }],
  "family@group": [{ id: "f1", summary: "Shore weekend", start: { date: ymd(OFFSITE) }, end: { date: ymd(atLocalHour(now, ZONE, 4, 0)) } }],
});

describe("refresh", () => {
  test("stores events from two calendars, then replaces them rather than adding to them", async () => {
    const { t, ben } = await setup();
    const first = firstEvents();
    const g = google({ events: first });
    vi.stubGlobal("fetch", g.f);
    await t.action(internal.calendar.refreshAll, {});

    const rows = await rowsOf(t, ben);
    expect(rows.map((r) => r.eventId).sort()).toEqual(["f1", "m1"]);
    expect(rows.find((r) => r.eventId === "m1")).toMatchObject({
      calendarId: "ben@gmail.com", calendar: "Ben", title: "Quote review", allDay: false, startMs: MEET, endMs: MEET + 30 * 60_000,
      status: "confirmed", attendees: ["sam@acme.co", "ben@gmail.com"], organizerSelf: true, responseStatus: "accepted",
    });
    expect(rows.find((r) => r.eventId === "f1")).toMatchObject({ calendarId: "family@group", calendar: "Family", allDay: true, startMs: OFFSITE });
    // The hidden calendar is never read.
    expect(g.calls).not.toContain("/calendar/v3/calendars/hidden%40group/events");

    // Second run: m1 is gone from Google, m2 is new, f1 is unchanged. No duplicates, no leftovers.
    first["ben@gmail.com"] = [{ id: "m2", summary: "Call Jen", start: { dateTime: iso(MEET + 3600_000) }, end: { dateTime: iso(MEET + 2 * 3600_000) } }];
    await t.action(internal.calendar.refresh, { tenantId: ben });
    expect((await rowsOf(t, ben)).map((r) => r.eventId).sort()).toEqual(["f1", "m2"]);
  });

  test("a mail-only tenant and an AgentMail tenant are skipped: no calendar call, no rows, no snapshot", async () => {
    const { t, mailOnly, agentMail } = await setup();
    const g = google({ events: firstEvents() });
    vi.stubGlobal("fetch", g.f);
    expect(await t.action(internal.calendar.refresh, { tenantId: mailOnly })).toBe("skipped");
    expect(await t.action(internal.calendar.refresh, { tenantId: agentMail })).toBe("skipped");
    expect(g.calls).toEqual([]);
    await t.action(internal.calendar.refreshAll, {});
    expect(g.calls.every((c) => !c.includes("mo%40gmail.com"))).toBe(true);
    for (const id of [mailOnly, agentMail]) {
      expect(await rowsOf(t, id)).toEqual([]);
      expect(await t.run(async (ctx) => await ctx.db.query("calendarSnapshots").withIndex("by_tenant", (q) => q.eq("tenantId", id)).unique())).toBeNull();
    }
  });

  test("a Google error keeps the previous snapshot, and the query reports its age and the error", async () => {
    const { t, ben } = await setup();
    const state: { events: Record<string, Raw[]>; fail?: boolean } = { events: firstEvents() };
    vi.stubGlobal("fetch", google(state).f);
    expect(await t.action(internal.calendar.refresh, { tenantId: ben })).toBe("refreshed");
    const before = await t.query(api.calendar.today, { slug: "ben", key: await surfaceKey("ben") });
    expect(before.error).toBeNull();
    expect(before.refreshedAt).toBeTypeOf("number");

    state.fail = true;
    expect(await t.action(internal.calendar.refresh, { tenantId: ben })).toBe("failed");
    expect((await rowsOf(t, ben)).map((r) => r.eventId).sort()).toEqual(["f1", "m1"]);
    const after = await t.query(api.calendar.today, { slug: "ben", key: await surfaceKey("ben") });
    expect(after.refreshedAt).toBe(before.refreshedAt);
    expect(after.error).toMatchObject({ message: expect.stringContaining("500") });
    expect(after.error!.at).toBeGreaterThanOrEqual(before.refreshedAt!);
    expect([...new Set(after.days.flatMap((d) => d.events.map((e) => e.id)))].sort()).toEqual(["f1", "m1"]);
  });
});

describe("today", () => {
  test("groups the window by local day in the tenant's zone; an all-day event shows on each day it covers", async () => {
    const { t, ben } = await setup();
    vi.stubGlobal("fetch", google({ events: firstEvents() }).f);
    await t.action(internal.calendar.refresh, { tenantId: ben });
    const r = await t.query(api.calendar.today, { slug: "ben", key: await surfaceKey("ben") });

    expect(r.days.map((d) => d.date)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ymd(atLocalHour(now, ZONE, i, 12))));
    const byDate = Object.fromEntries(r.days.map((d) => [d.date, d.events.map((e) => e.id)]));
    expect(byDate[ymd(now)]).toEqual([]);
    expect(byDate[ymd(MEET)]).toEqual(["m1"]);
    expect(byDate[ymd(OFFSITE)]).toEqual(["f1"]);
    expect(byDate[ymd(atLocalHour(now, ZONE, 3, 12))]).toEqual(["f1"]);
    expect(byDate[ymd(atLocalHour(now, ZONE, 4, 12))]).toEqual([]);
    expect(r.days[1].events[0]).toMatchObject({ id: "m1", calendar: "Ben", title: "Quote review", startMs: MEET });
  });

  test("refused without the surface key", async () => {
    const { t } = await setup();
    await expect(t.query(api.calendar.today, { slug: "ben", key: "nope" })).rejects.toThrow("bad surface key");
  });
});

