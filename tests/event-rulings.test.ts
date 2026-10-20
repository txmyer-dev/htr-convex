// Expiry of event cards (U8, KTD9): a card's deadline is two hours before its meeting at the
// latest; an expired card closes and its email is drafted again, never re-listed at its old time;
// the weekly last call leaves event cards alone. Offline: the model and Google are one fake fetch.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { TENANTS } from "../convex/install";
import { INTENT_SYSTEM } from "../convex/lib/calendar/intent";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["HTR_RULING_SECRET", "CONVEX_SITE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OPENAI_API_KEY", "FIRECRAWL_API_KEY"];
const ZONE = "America/Los_Angeles"; // PDT (UTC-7) through Nov 1 2026
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 19, 16, 0); // Mon Oct 19 2026, 09:00 PDT
const pdt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour + 7, minute);
const SAM = "sam@example.com";
const WITH_CALENDAR = `${GMAIL_READ} ${GMAIL_SEND} ${CALENDAR_READ} ${CALENDAR_OWNED}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const iso = (ms: number) => new Date(ms).toISOString();

type Busy = { start: number; end: number };

/** A fake model and a fake Google, read-only. `primary` is busy time on the owner's own calendar, editable mid-test. */
function world(w: { extraction: string; primary?: Busy[] }) {
  const state = { primary: w.primary ?? [], modelCalls: 0 };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (url.pathname.endsWith("/chat/completions")) {
      state.modelCalls++;
      const body = JSON.parse(String(init?.body));
      const content = body.messages[0].content === INTENT_SYSTEM ? w.extraction : JSON.stringify({ body: "Hi Sam, that works. Ben", basis: [] });
      return json({ choices: [{ message: { content } }] });
    }
    if (url.hostname === "www.googleapis.com") {
      if (url.pathname === "/calendar/v3/users/me/calendarList") return json({ items: [{ id: "ben@gmail.com", summary: "Ben", primary: true }, { id: "family@group", summary: "Family" }] });
      if (url.pathname === "/calendar/v3/freeBusy") return json({ calendars: { "family@group": { busy: [] } } });
      if (url.pathname === "/calendar/v3/calendars/primary/events") {
        return json({ timeZone: ZONE, items: state.primary.map((b, i) => ({ id: `busy${i}`, status: "confirmed", summary: "Busy", start: { dateTime: iso(b.start) }, end: { dateTime: iso(b.end) } })) });
      }
    }
    return json({ error: { message: `no route for ${url.href}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, state };
}

let rt = 0;
async function setup() {
  Object.assign(process.env, {
    HTR_RULING_SECRET: "test-secret", CONVEX_SITE_URL: "https://test.convex.site",
    GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec", OPENAI_API_KEY: "sk-test",
  });
  delete process.env.FIRECRAWL_API_KEY;
  const t = convexTest(schema, modules);
  const base = { ...TENANTS[0], timeZone: ZONE, business: { agentName: "Ekko" }, tasks: undefined } as Omit<Doc<"tenants">, "_id" | "_creationTime">;
  const tenantId = await t.run((ctx) => ctx.db.insert("tenants", {
    ...base, slug: "ben", owner: { ...base.owner, name: "Ben", email: "ben@gmail.com", defaultDeadlineDays: 2 }, adapters: { mail: { kind: "gmail" } },
    channels: { gmail: { address: "ben@gmail.com", refreshToken: `rt-event-rulings-${++rt}`, grantedAt: 1, scope: WITH_CALENDAR } },
  }));
  return { t, tenantId };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const inbound = (t: T, tenantId: Id<"tenants">, body: string) =>
  t.run((ctx) => ctx.db.insert("messages", {
    tenantId, channel: "email", direction: "in", fromAddress: SAM, body, at: Date.now(), vendorRef: `v_${Math.random()}`, threadId: "thr_sam",
    meta: { subject: "Meeting", name: "Sam", messageId: "<m@example.com>" },
  }));
const get = (t: T, id: Id<"proposals">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const all = (t: T) => t.run((ctx) => ctx.db.query("proposals").collect());
const scheduled = (t: T, name: string) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes(name) && s.state.kind === "pending"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an event card's deadline", () => {
  test("a meeting three hours out: the card expires one hour from now, not two days from now", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: '{"intent":"propose_time","start":"2026-10-19T12:00"}' }).f);
    const pid = (await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we do noon today?") }))!;
    const p = await get(t, pid);
    expect(p.kind).toBe("event");
    expect(p.deadline).toBe(NOW + HOUR);

    vi.setSystemTime(NOW + HOUR - 1);
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(0);
    vi.setSystemTime(NOW + HOUR);
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(1);
    expect((await get(t, pid)).status).toBe("expired");
  });

  test("a meeting a week out keeps the normal deadline", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: '{"intent":"propose_time","start":"2026-10-26T14:00"}' }).f);
    const pid = (await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Could we meet about the kitchen?") }))!;
    expect((await get(t, pid)).deadline).toBe(NOW + 2 * 86_400_000);
  });
});

describe("expiry", () => {
  test("AE8: an expired event card closes, is not re-listed, and its email is drafted again as a new pending card", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const messageId = await inbound(t, tenantId, "Can we do Tuesday 2pm?");
    const card = (await t.action(internal.drafter.draft, { messageId }))!;
    expect((await get(t, card)).deadline).toBe(pdt(20, 12)); // two hours before the meeting

    // Unruled past its deadline; meanwhile 2pm was booked.
    g.state.primary.push({ start: pdt(20, 14), end: pdt(20, 15) });
    vi.setSystemTime(pdt(20, 12));
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(1);
    expect((await get(t, card)).status).toBe("expired");
    expect((await all(t)).filter((p) => p.status === "pending")).toEqual([]); // not re-listed
    expect((await all(t)).some((p) => p.sourceKind === "relist")).toBe(false);

    const jobs = await scheduled(t, "drafter:draft");
    expect(jobs.map((j) => j.args[0])).toEqual([{ messageId }]);
    expect(await scheduled(t, "mail:sendNotice")).toEqual([]); // the fresh draft is the answer, not a holding note
    const fresh = (await t.action(internal.drafter.draft, jobs[0].args[0] as { messageId: Id<"messages"> }))!;
    expect(fresh).not.toBe(card);
    const p = await get(t, fresh);
    expect(p).toMatchObject({ status: "pending", sourceKind: "email", sourceId: messageId, kind: "email" });
    expect(p.meta.offer!.slots).toHaveLength(3); // re-checked: 2pm is taken now, so it offers slots
  });

  test("an expired email draft is still re-listed, as before", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: '{"intent":"none"}' }).f);
    const pid = (await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "What are your rates?") }))!;
    vi.setSystemTime(NOW + 2 * 86_400_000);
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(1);
    expect((await get(t, pid)).status).toBe("expired");
    const relisted = (await all(t)).filter((p) => p.status === "pending");
    expect(relisted).toMatchObject([{ sourceKind: "relist", sourceId: pid, kind: "email" }]);
    expect(await scheduled(t, "drafter:draft")).toEqual([]);
  });
});

describe("the weekly last call", () => {
  test("an event card that sat through a weekly digest is not expired by the sweep; an email draft is", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-26T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const card = (await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Next Monday 2pm?") }))!;
    const other = await t.run((ctx) => ctx.db.insert("proposals", {
      tenantId, kind: "email", toAddress: "kim@example.com", body: "Hi Kim", basis: [], summary: "s", status: "pending", edited: false, meta: {}, createdAt: NOW,
    }));
    await t.mutation(internal.digest.build, { tenantId, weekly: true });
    expect((await get(t, card)).lastCallAt).toBeDefined();

    await t.mutation(internal.digest.build, { tenantId, weekly: true });
    expect((await get(t, other)).status).toBe("expired");
    expect((await get(t, card)).status).toBe("pending");
  });
});
