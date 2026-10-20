// Expiry of event cards (U8, KTD9): a card's deadline is two hours before its meeting at the
// latest; an expired card closes and its email is drafted again, never re-listed at its old time;
// the weekly last call leaves event cards alone. Offline: the model and Google are one fake fetch.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { TENANTS } from "../convex/install";
import { INTENT_SYSTEM } from "../convex/lib/calendar/intent";
import { buildTimeline } from "../convex/lib/proposals/timeline";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import schema from "../convex/schema";
import { surfaceKey } from "../convex/surface";

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
      if (url.pathname.startsWith("/calendar/v3/calendars/primary/events/")) return json({ error: { message: "Not Found" } }, 404);
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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] }); // scheduled jobs wait until a test runs them by hand
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

// ---- the web edit (KTD10) --------------------------------------------------------------------

type CardEvent = NonNullable<Doc<"proposals">["meta"]["event"]>;
const TUE_2PM = pdt(20, 14);
const insertEvent: CardEvent = { op: "insert", title: "Meeting with Sam", startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN, timeZone: ZONE, attendees: [SAM] };
const moveEvent: CardEvent = {
  op: "move", title: "Weekly sync", startMs: pdt(22, 13), endMs: pdt(22, 14), timeZone: ZONE, attendees: ["ben@gmail.com", SAM],
  targetEventId: "e1", previousStartMs: pdt(21, 10), previousEndMs: pdt(21, 11),
};
type Check = { proposalId: Id<"proposals">; startMs: number; endMs: number };

async function pendingCard(t: T, tenantId: Id<"tenants">, event: CardEvent = insertEvent) {
  const messageId = await inbound(t, tenantId, "Can we do Tuesday 2pm?");
  const id = await t.run((ctx) => ctx.db.insert("proposals", {
    tenantId, kind: "event", toAddress: SAM, toName: "Sam", body: "Tuesday at 2 works. Ben", basis: ["Can we do Tuesday 2pm?"], summary: "Event",
    status: "pending", sourceKind: "email", sourceId: messageId, edited: false, deadline: NOW + 86_400_000,
    meta: { subject: "Meeting", threadId: "thr_sam", messageId: "<m@example.com>", event }, createdAt: NOW,
  }));
  return { id, messageId };
}

describe("editEvent", () => {
  test("without the surface key it is refused", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId);
    await expect(t.mutation(api.rulings.editEvent, { slug: "ben", key: "wrong", proposalId: id, title: "Hijacked" })).rejects.toThrow("bad surface key");
    expect((await get(t, id)).meta.event!.title).toBe("Meeting with Sam");
  });

  test("an attendee that isn't an email address is refused, and nothing changes", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    const note = await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, attendees: [SAM, "kim at example"], title: "New title" });
    expect(note).toBe("Not saved: “kim at example” isn't an email address.");
    expect((await get(t, id)).meta.event).toEqual(insertEvent);
  });

  test("title, time, attendees and words change together; the summary follows the new time", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.mutation(api.rulings.editEvent, {
      slug: "ben", key, proposalId: id, title: " Kitchen walkthrough ", startMs: pdt(20, 15), durationMin: 60,
      attendees: [" Sam@Example.com", "kim@example.com"], body: "3pm Tuesday works, invite on its way. Ben",
    });
    const p = await get(t, id);
    expect(p.meta.event).toEqual({ ...insertEvent, title: "Kitchen walkthrough", startMs: pdt(20, 15), endMs: pdt(20, 16), attendees: ["sam@example.com", "kim@example.com"], clash: "checking" });
    expect(p.body).toBe("3pm Tuesday works, invite on its way. Ben");
    expect(p.summary).toBe("Event: Tue Oct 20, 3:00 PM with Sam");
  });

  test("a move card edits only its new time and its words", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId, moveEvent);
    const key = await surfaceKey("ben");
    expect(await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, attendees: [SAM, "eve@example.com"] }))
      .toBe("Not saved: a move changes only the new time and the reply.");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, startMs: pdt(22, 15) });
    expect((await get(t, id)).meta.event).toEqual({ ...moveEvent, startMs: pdt(22, 15), endMs: pdt(22, 16), clash: "checking" });
  });

  test("a time edited onto a busy slot reads no longer free; approving it closes the card and drafts the email again", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: "{}", primary: [{ start: pdt(20, 15), end: pdt(20, 16) }] }).f);
    const { id, messageId } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, startMs: pdt(20, 15) });
    const listed = async () => (await t.query(api.proposals.list, { slug: "ben", key })).find((r) => r.id === id)!;
    expect((await listed()).event!.clash).toBe("checking");

    const checks = await scheduled(t, "calendar:checkClash");
    expect(checks).toHaveLength(1);
    await t.action(internal.calendar.checkClash, checks[0].args[0] as Check);
    expect((await listed()).event!.clash).toBe("busy");

    await t.mutation(api.rulings.ruleFromSurface, { slug: "ben", key, proposalId: id, verdict: "sign" });
    expect(await t.action(internal.mail.dispatch, { proposalId: id })).toBe("no longer free");
    const p = await get(t, id);
    expect(p.status).toBe("expired");
    expect(p.error).toBe("Tue Oct 20, 3:00 PM is no longer free");
    expect((await scheduled(t, "drafter:draft")).map((j) => j.args[0])).toEqual([{ messageId }]);
  });

  test("a free slot checks clear", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: "{}", primary: [{ start: pdt(20, 15), end: pdt(20, 16) }] }).f);
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, startMs: pdt(20, 10) });
    const [check] = await scheduled(t, "calendar:checkClash");
    await t.action(internal.calendar.checkClash, check.args[0] as Check);
    expect((await get(t, id)).meta.event!.clash).toBe("clear");
  });

  test("a clash check for a time the owner has since changed again records nothing", async () => {
    const { t, tenantId } = await setup();
    vi.stubGlobal("fetch", world({ extraction: "{}", primary: [{ start: pdt(20, 15), end: pdt(20, 16) }] }).f);
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, startMs: pdt(20, 15) });
    const [stale] = await scheduled(t, "calendar:checkClash");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, startMs: pdt(20, 10) });
    await t.action(internal.calendar.checkClash, stale.args[0] as Check);
    expect((await get(t, id)).meta.event!.clash).toBe("checking");
  });

  test("edited words become a lesson only when the card is approved: the drafter's words against the final ones", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, body: "First try. Ben" });
    await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, body: "Tuesday 2pm is great, see you. Ben" });
    const edits = () => t.run(async (ctx) => (await ctx.db.query("rulings").collect()).filter((r) => r.verdict === "edit"));
    expect(await edits()).toEqual([]);

    await t.mutation(api.rulings.ruleFromSurface, { slug: "ben", key, proposalId: id, verdict: "sign" });
    expect(await edits()).toMatchObject([{ proposalId: id, draftBody: "Tuesday at 2 works. Ben", editBody: "Tuesday 2pm is great, see you. Ben" }]);
    expect((await get(t, id)).status).toBe("signed");
  });

  test("a card that isn't pending is not edited", async () => {
    const { t, tenantId } = await setup();
    const { id } = await pendingCard(t, tenantId);
    const key = await surfaceKey("ben");
    await t.run((ctx) => ctx.db.patch(id, { status: "signed" }));
    expect(await t.mutation(api.rulings.editEvent, { slug: "ben", key, proposalId: id, title: "Late" })).toBe("Nothing waiting under that card.");
    expect((await get(t, id)).meta.event!.title).toBe("Meeting with Sam");
  });
});

describe("the timeline of an expired event card", () => {
  test("says it was drafted again, not that they were told a reply is coming", () => {
    const steps = buildTimeline(
      { kind: "event", status: "expired", meta: { event: { op: "insert" } } },
      [{ kind: "proposal.created", payload: {}, at: NOW, _creationTime: 1 }],
      [{ from: "clock", verdict: "expired", at: NOW, _creationTime: 2 }],
    );
    expect(steps.map((s) => s.text)).toEqual(["Drafted from their message", "Expired before the meeting; drafted again"]);
  });
});
