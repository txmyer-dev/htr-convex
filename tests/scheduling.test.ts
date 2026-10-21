// Scheduling in the drafter (U7): the model extracts an intent, code decides from the calendar.
// The decision step is driven with a fake calendar claw; the draft action end to end with a fake
// model and a fake Google behind a stubbed fetch. Nothing here reaches the network.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { CalendarClaw } from "../convex/adapters/ports";
import { TENANTS } from "../convex/install";
import type { Interval } from "../convex/lib/calendar/availability";
import { decide, INTENT_SYSTEM, parseIntent, type Intent, type SnapshotEvent } from "../convex/lib/calendar/intent";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import schema from "../convex/schema";

const ZONE = "America/Los_Angeles"; // PDT (UTC-7) through Nov 1 2026
const MIN = 60_000;
// Mon Oct 19 2026, 09:00 PDT.
const NOW = Date.UTC(2026, 9, 19, 16, 0);
const pdt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour + 7, minute);
const TUE_2PM = pdt(20, 14);
const SAM = "sam@example.com";

// ---- the parse ---------------------------------------------------------------------------------

describe("parseIntent", () => {
  test("a proposed time, read in the owner's zone", () => {
    expect(parseIntent('{"intent":"propose_time","start":"2026-10-20T14:00","zone":null,"durationMin":null,"title":null}', ZONE))
      .toEqual({ kind: "propose_time", startMs: TUE_2PM });
  });

  test('"2pm ET" for a Pacific owner is 11:00 local', () => {
    const i = parseIntent('{"intent":"propose_time","start":"2026-10-20T14:00","zone":"America/New_York"}', ZONE);
    expect(i).toEqual({ kind: "propose_time", startMs: pdt(20, 11) });
  });

  test("open, move and pick", () => {
    expect(parseIntent('{"intent":"open","durationMin":45,"title":"Intro call"}', ZONE)).toEqual({ kind: "open", durationMin: 45, title: "Intro call" });
    expect(parseIntent('{"intent":"move","eventHint":"our sync","newStart":"2026-10-22T10:00"}', ZONE)).toEqual({ kind: "move", eventHint: "our sync", newStartMs: pdt(22, 10) });
    expect(parseIntent('```json\n{"intent":"pick","start":"2026-10-21T09:00"}\n```', ZONE)).toEqual({ kind: "pick", startMs: pdt(21, 9) });
  });

  test("anything malformed is none", () => {
    for (const bad of [
      "not json",
      "",
      '{"intent":"propose_time"}',
      '{"intent":"propose_time","start":"Tuesday 2pm"}',
      '{"intent":"propose_time","start":"2026-10-20T14:00Z"}',
      '{"intent":"propose_time","start":"2026-13-20T14:00"}',
      '{"intent":"propose_time","start":"2026-10-20T14:00","zone":"Mars/Olympus"}',
      '{"intent":"propose_time","start":"2026-10-20T14:00","durationMin":-5}',
      '{"intent":"move","newStart":"2026-10-22T10:00"}',
      '{"intent":"book_room"}',
      '[{"intent":"open"}]',
    ]) expect(parseIntent(bad, ZONE), bad).toEqual({ kind: "none" });
  });

  test("attendees in the output are never carried", () => {
    const i = parseIntent('{"intent":"propose_time","start":"2026-10-20T14:00","attendees":["eve@evil.com"]}', ZONE);
    expect(i).toEqual({ kind: "propose_time", startMs: TUE_2PM });
  });
});

// ---- the decision ------------------------------------------------------------------------------

type Fake = { other?: Interval[]; primary?: Interval[]; unreadable?: boolean };

function claw(f: Fake = {}) {
  const seen = { excluded: [] as Array<string | undefined>, writes: 0 };
  const c: CalendarClaw = {
    name: "fake",
    calendars: async () => [{ id: "ben@gmail.com", summary: "Ben", primary: true }, { id: "family@group", summary: "Family", primary: false }],
    events: async () => [],
    freeBusy: async () => (f.unreadable ? { busy: {}, errors: { "family@group": "notFound" } } : { busy: { "family@group": f.other ?? [] }, errors: {} }),
    primaryBusy: async (_w, id) => {
      seen.excluded.push(id);
      return f.primary ?? [];
    },
    get: async () => null,
    insert: async () => { seen.writes++; return { exists: true }; },
    move: async () => { seen.writes++; throw new Error("no writes from the drafter"); },
  };
  return { c, seen };
}

const base = { nowMs: NOW, timeZone: ZONE, sender: SAM, name: "Sam" };
const run = (intent: Intent, f: Fake = {}, extra: { offer?: Interval[]; events?: SnapshotEvent[] } = {}) => {
  const { c, seen } = claw(f);
  return decide({ ...base, ...extra, intent, claw: c }).then((d) => ({ d, seen }));
};

// The first three free starts from Mon 09:00 with nothing booked: 11:00 today (two hours out), then 09:00 the next two days.
const OPEN_SLOTS = [{ start: pdt(19, 11), end: pdt(19, 11, 30) }, { start: pdt(20, 9), end: pdt(20, 9, 30) }, { start: pdt(21, 9), end: pdt(21, 9, 30) }];

describe("decide", () => {
  test("AE1: a clean proposed time is an event card with the sender as the only attendee", async () => {
    const { d, seen } = await run({ kind: "propose_time", startMs: TUE_2PM });
    expect(d).toEqual({
      kind: "event",
      event: { op: "insert", title: "Meeting with Sam", startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN, timeZone: ZONE, attendees: [SAM] },
    });
    expect(seen.writes).toBe(0);
  });

  test("the extracted title and duration are used", async () => {
    const { d } = await run({ kind: "propose_time", startMs: TUE_2PM, durationMin: 60, title: "Kitchen walkthrough" });
    expect(d).toMatchObject({ kind: "event", event: { title: "Kitchen walkthrough", endMs: TUE_2PM + 60 * MIN } });
  });

  test("AE2: an open request is a three-slot offer", async () => {
    const { d } = await run({ kind: "open" });
    expect(d).toEqual({ kind: "offer", slots: OPEN_SLOTS });
  });

  test("AE3: a time that clashes on a non-primary calendar is an offer, not an event", async () => {
    const { d } = await run({ kind: "propose_time", startMs: TUE_2PM }, { other: [{ start: pdt(20, 13, 30), end: pdt(20, 14, 30) }] });
    expect(d).toEqual({ kind: "offer", slots: OPEN_SLOTS });
  });

  test("an unreadable calendar is an ordinary reply, with no slots", async () => {
    expect((await run({ kind: "propose_time", startMs: TUE_2PM }, { unreadable: true })).d).toEqual({ kind: "none" });
    expect((await run({ kind: "open" }, { unreadable: true })).d).toEqual({ kind: "none" });
  });

  test("AE2: a pick of an offered slot takes the stored slot, end and all", async () => {
    const offer = [{ start: pdt(21, 14), end: pdt(21, 15) }, { start: pdt(22, 10), end: pdt(22, 11) }];
    const { d } = await run({ kind: "pick", startMs: pdt(21, 14) }, {}, { offer });
    expect(d).toMatchObject({ kind: "event", event: { op: "insert", startMs: pdt(21, 14), endMs: pdt(21, 15), attendees: [SAM] } });
  });

  test("a pick of a time that wasn't offered is a proposed time: clean is an event, busy is an offer", async () => {
    const offer = [{ start: pdt(21, 14), end: pdt(21, 15) }];
    const clean = await run({ kind: "pick", startMs: TUE_2PM }, {}, { offer });
    expect(clean.d).toMatchObject({ kind: "event", event: { startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN } });
    const busy = await run({ kind: "pick", startMs: TUE_2PM }, { primary: [{ start: TUE_2PM, end: TUE_2PM + 60 * MIN }] }, { offer });
    expect(busy.d).toMatchObject({ kind: "offer" });
  });

  describe("a move", () => {
    const ev = (over: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
      eventId: "e1", calendarId: "ben@gmail.com", title: "Weekly sync", allDay: false,
      startMs: pdt(21, 10), endMs: pdt(21, 11), status: "confirmed", attendees: ["ben@gmail.com", SAM, "kim@example.com"], organizerSelf: true,
      ...over,
    });
    const move: Intent = { kind: "move", eventHint: "weekly sync", newStartMs: pdt(22, 13) };

    test("a move to a time under two hours away is an ordinary reply", async () => {
      expect((await run({ ...move, newStartMs: NOW + 60 * MIN }, {}, { events: [ev()] })).d).toEqual({ kind: "none" });
    });

    test("one owner-organised event with the sender: a move card, attendees unchanged, checked without itself", async () => {
      const { d, seen } = await run(move, {}, { events: [ev(), ev({ eventId: "x", attendees: ["ben@gmail.com"] }), ev({ eventId: "y", organizerSelf: false }), ev({ eventId: "z", calendarId: "family@group" })] });
      expect(d).toEqual({
        kind: "event",
        event: {
          op: "move", title: "Weekly sync", startMs: pdt(22, 13), endMs: pdt(22, 14), timeZone: ZONE,
          attendees: ["ben@gmail.com", SAM, "kim@example.com"], targetEventId: "e1", previousStartMs: pdt(21, 10), previousEndMs: pdt(21, 11),
        },
      });
      expect(seen.excluded).toEqual(["e1"]);
    });

    test("the hint picks between two", async () => {
      const { d } = await run(move, {}, { events: [ev({ eventId: "a", title: "Budget review" }), ev()] });
      expect(d).toMatchObject({ kind: "event", event: { targetEventId: "e1" } });
    });

    test("zero or two matches: an ordinary reply", async () => {
      expect((await run(move, {}, { events: [] })).d).toEqual({ kind: "none" });
      expect((await run(move, {}, { events: [ev({ eventId: "a" }), ev({ eventId: "b" })] })).d).toEqual({ kind: "none" });
    });

    test("a new time that isn't clean: an ordinary reply", async () => {
      const { d } = await run(move, { other: [{ start: pdt(22, 13), end: pdt(22, 14) }] }, { events: [ev()] });
      expect(d).toEqual({ kind: "none" });
    });
  });

  test("none is none, with no calendar read", async () => {
    let reads = 0;
    const { c } = claw();
    const counted: CalendarClaw = { ...c, calendars: async () => { reads++; return c.calendars(); }, primaryBusy: async (w, id) => { reads++; return c.primaryBusy(w, id); } };
    expect(await decide({ ...base, intent: { kind: "none" }, claw: counted })).toEqual({ kind: "none" });
    expect(reads).toBe(0);
  });
});

// ---- the draft action, end to end --------------------------------------------------------------

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["HTR_RULING_SECRET", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OPENAI_API_KEY", "FIRECRAWL_API_KEY"];
const MAIL_ONLY = `${GMAIL_READ} ${GMAIL_SEND}`;
const WITH_CALENDAR = `${MAIL_ONLY} ${CALENDAR_READ} ${CALENDAR_OWNED}`;
const iso = (ms: number) => new Date(ms).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type World = {
  extraction: string; // what the extraction call returns
  reply?: string; // the draft call's body
  family?: Array<{ start: string; end: string }>;
  primary?: unknown[];
  owned?: unknown[]; // raw events on primary, read by its own id for a move
};

/** A fake model and a fake Google. Records every calendar request and every model call. */
function world(w: World) {
  const calendarCalls: string[] = [];
  const modelCalls: Array<{ system: string; user: string }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    if (url.pathname.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body));
      const call = { system: body.messages[0].content, user: body.messages[1].content };
      modelCalls.push(call);
      const content = call.system === INTENT_SYSTEM ? w.extraction : JSON.stringify({ body: w.reply ?? "Hi Sam, sounds good. Ben", basis: [] });
      return json({ choices: [{ message: { content } }] });
    }
    if (url.hostname === "www.googleapis.com") {
      calendarCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/calendar/v3/users/me/calendarList") return json({ items: [{ id: "ben@gmail.com", summary: "Ben", primary: true }, { id: "family@group", summary: "Family" }] });
      if (url.pathname === "/calendar/v3/freeBusy") return json({ calendars: { "family@group": { busy: w.family ?? [] } } });
      if (url.pathname === "/calendar/v3/calendars/primary/events") return json({ timeZone: ZONE, items: w.primary ?? [] });
      if (url.pathname === "/calendar/v3/calendars/ben%40gmail.com/events") return json({ timeZone: ZONE, items: w.owned ?? [] });
    }
    return json({ error: { message: `no route for ${url.href}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, calendarCalls, modelCalls };
}

let rt = 0;
async function setup(scope = WITH_CALENDAR) {
  Object.assign(process.env, { HTR_RULING_SECRET: "test-secret", GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec", OPENAI_API_KEY: "sk-test" });
  delete process.env.FIRECRAWL_API_KEY;
  const t = convexTest(schema, modules);
  const tenantBase = { ...TENANTS[0], timeZone: ZONE, business: { agentName: "Ekko" }, tasks: undefined } as Omit<Doc<"tenants">, "_id" | "_creationTime">;
  const tenantId = await t.run((ctx) => ctx.db.insert("tenants", {
    ...tenantBase, slug: "ben", owner: { ...tenantBase.owner, name: "Ben" }, adapters: { mail: { kind: "gmail" } },
    channels: { gmail: { address: "ben@gmail.com", refreshToken: `rt-sched-${++rt}`, grantedAt: 1, scope } },
  }));
  return { t, tenantId };
}

type T = ReturnType<typeof convexTest>;
const inbound = (t: T, tenantId: Id<"tenants">, body: string, over: Partial<Doc<"messages">> = {}) =>
  t.run((ctx) => ctx.db.insert("messages", {
    tenantId, channel: "email", direction: "in", fromAddress: SAM, body, at: Date.now(), vendorRef: `v_${Math.random()}`, threadId: "thr_sam",
    meta: { subject: "Meeting", name: "Sam", messageId: "<m@example.com>" }, ...over,
  }));

describe("the draft action", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("AE1: 'Tuesday 2pm?' with a free calendar is one event card for 2:00-2:30 with Sam, and the reply accepts it", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const messageId = await inbound(t, tenantId, "Can we do Tuesday 2pm?");
    const pid = await t.action(internal.drafter.draft, { messageId });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("event");
    expect(p.meta.event).toEqual({ op: "insert", title: "Meeting with Sam", startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN, timeZone: ZONE, attendees: [SAM] });
    expect(p.meta.messageId).toBe((await t.run((ctx) => ctx.db.get(messageId)))!.vendorRef); // the threaded reply
    expect(p.body).toBe("Hi Sam, sounds good. Ben");
    const draftCall = g.modelCalls.find((c) => c.system !== INTENT_SYSTEM)!;
    expect(JSON.parse(draftCall.user).schedule).toMatchObject({ decision: "accept_time", time: "Tue Oct 20, 2:00 PM" });
    expect(g.calendarCalls.some((c) => !c.startsWith("GET") && !c.endsWith("/freeBusy"))).toBe(false); // reads only
  });

  test("AE2: 'let's meet next week' is an email card listing three slots, stored on meta.offer", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"open"}', reply: "Hi Sam, happy to. Which of these works? Ben" });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Let's meet next week") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("email");
    expect(p.meta.offer).toEqual({ slots: OPEN_SLOTS });
    expect(p.meta.event).toBeUndefined();
    for (const s of ["Mon Oct 19, 11:00 AM", "Tue Oct 20, 9:00 AM", "Wed Oct 21, 9:00 AM"]) expect(p.body).toContain(s);
    const draftCall = g.modelCalls.find((c) => c.system !== INTENT_SYSTEM)!;
    expect(JSON.parse(draftCall.user).schedule).toMatchObject({ decision: "offer_slots", slots: ["Mon Oct 19, 11:00 AM", "Tue Oct 20, 9:00 AM", "Wed Oct 21, 9:00 AM"] });
  });

  test("AE2: Sam's pick of an offered slot is an event card for that slot, superseding the pending draft to Sam", async () => {
    const { t, tenantId } = await setup();
    const first = await inbound(t, tenantId, "Let's meet next week", { at: NOW - 3 * 3_600_000 });
    const wed2 = { start: pdt(21, 14), end: pdt(21, 14, 30) };
    const offerId = await t.run((ctx) => ctx.db.insert("proposals", {
      tenantId, kind: "email", toAddress: SAM, body: "Wed Oct 21, 2:00 PM?", basis: [], summary: "s", status: "sent", sourceKind: "email", sourceId: first,
      edited: false, meta: { threadId: "thr_sam", offer: { slots: [{ start: pdt(20, 10), end: pdt(20, 10, 30) }, wed2] } }, createdAt: NOW - 3 * 3_600_000, sentAt: NOW - 2 * 3_600_000,
    }));
    await t.run((ctx) => ctx.db.insert("messages", { tenantId, channel: "email", direction: "out", fromAddress: "ben@gmail.com", toAddress: SAM, body: "Wed Oct 21, 2:00 PM?", at: NOW - 2 * 3_600_000, threadId: "thr_sam", meta: {} }));
    // A pending email draft to Sam from another thread.
    const other = await inbound(t, tenantId, "Also, what are your rates?", { threadId: "thr_rates", at: NOW - 3_600_000 });
    const pending = await t.mutation(internal.drafter.record, { messageId: other, body: "Our rates are...", basis: [] });

    const g = world({ extraction: '{"intent":"pick","start":"2026-10-21T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const pick = await inbound(t, tenantId, "Wednesday at 2 works");
    const pid = await t.action(internal.drafter.draft, { messageId: pick });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("event");
    expect(p.meta.event).toMatchObject({ op: "insert", startMs: wed2.start, endMs: wed2.end, attendees: [SAM] });
    expect((await t.run((ctx) => ctx.db.get(pending)))!.status).toBe("superseded");
    expect((await t.run((ctx) => ctx.db.get(offerId)))!.status).toBe("sent");
    // The extraction saw what was offered.
    expect(JSON.parse(g.modelCalls[0].user).offered).toEqual(["2026-10-20T10:00", "2026-10-21T14:00"]);
  });

  test("an event card and an email draft to the same address are one family: a newer email supersedes the event card", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const card = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we do Tuesday 2pm?", { at: NOW - 60_000 }) });
    const g2 = world({ extraction: '{"intent":"none"}' });
    vi.stubGlobal("fetch", g2.f);
    const reply = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Actually, what do you charge?", { threadId: "thr_2" }) });
    expect((await t.run((ctx) => ctx.db.get(card!)))!.status).toBe("superseded");
    expect((await t.run((ctx) => ctx.db.get(reply!)))!.kind).toBe("email");
  });

  test("an email asking to also invite someone else: the sender is the only attendee", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00","attendees":["eve@evil.com"],"title":"Sync"}' });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Tuesday 2pm? Please also invite eve@evil.com and boss@corp.com.") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.meta.event!.attendees).toEqual([SAM]);
  });

  test('"2pm ET" for a Pacific tenant is an 11:00 local event', async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00","zone":"America/New_York"}' });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Tuesday 2pm ET?") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.meta.event).toMatchObject({ startMs: pdt(20, 11), endMs: pdt(20, 11, 30) });
  });

  test("AE3 over Google: a clash on the family calendar is a slot offer", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}', family: [{ start: new Date(pdt(20, 13)).toISOString(), end: new Date(pdt(20, 15)).toISOString() }] });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we do Tuesday 2pm?") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("email");
    expect(p.meta.offer!.slots).toHaveLength(3);
  });

  test("a move reads Google live: a meeting 11 days out, past the desk's 8-day snapshot, is a move card", async () => {
    const { t, tenantId } = await setup();
    const sync = {
      id: "e1", status: "confirmed", summary: "Weekly sync", start: { dateTime: iso(pdt(30, 10)) }, end: { dateTime: iso(pdt(30, 11)) },
      organizer: { self: true }, attendees: [{ email: "ben@gmail.com", self: true }, { email: SAM }],
    };
    const g = world({ extraction: '{"intent":"move","eventHint":"sync","newStart":"2026-10-30T13:00"}', owned: [sync] });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we push our sync to 1pm that Friday?") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("event");
    expect(p.meta.event).toMatchObject({ op: "move", targetEventId: "e1", startMs: pdt(30, 13), endMs: pdt(30, 14), previousStartMs: pdt(30, 10), attendees: ["ben@gmail.com", SAM] });
  });

  test("malformed extraction output is an ordinary reply", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: "sure! tuesday works" });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we do Tuesday 2pm?") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("email");
    expect(p.meta.event).toBeUndefined();
    expect(p.meta.offer).toBeUndefined();
    expect(JSON.parse(g.modelCalls[1].user)).not.toHaveProperty("schedule");
    expect(g.calendarCalls).toEqual([]);
  });

  test("an unreadable calendar is an ordinary reply with no slots", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"open"}' });
    const broken = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/calendar/v3/freeBusy" ? json({ error: { message: "backend" } }, 500) : g.f(input, init)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", broken);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Let's meet next week") });
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p.kind).toBe("email");
    expect(p.meta.offer).toBeUndefined();
  });

  test("a mail-only tenant drafts as today: no extraction call, no calendar call", async () => {
    const { t, tenantId } = await setup(MAIL_ONLY);
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}' });
    vi.stubGlobal("fetch", g.f);
    const pid = await t.action(internal.drafter.draft, { messageId: await inbound(t, tenantId, "Can we do Tuesday 2pm?") });
    expect(g.calendarCalls).toEqual([]);
    expect(g.modelCalls).toHaveLength(1);
    expect(JSON.parse(g.modelCalls[0].user)).not.toHaveProperty("schedule");
    expect((await t.run((ctx) => ctx.db.get(pid!)))!.kind).toBe("email");
  });

  test("the already-drafted guard: an expired event card for the message doesn't count, a pending one does", async () => {
    const { t, tenantId } = await setup();
    const messageId = await inbound(t, tenantId, "Can we do Tuesday 2pm?");
    const card = await t.run((ctx) => ctx.db.insert("proposals", {
      tenantId, kind: "event", toAddress: SAM, body: "See you then.", basis: [], summary: "s", status: "pending", sourceKind: "email", sourceId: messageId, edited: false,
      meta: { event: { op: "insert", title: "Meeting with Sam", startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN, timeZone: ZONE, attendees: [SAM] } }, createdAt: NOW,
    }));
    expect((await t.query(internal.drafter.context, { messageId }))!.already).toBe(true);
    await t.run((ctx) => ctx.db.patch(card, { status: "expired" }));
    expect((await t.query(internal.drafter.context, { messageId }))!.already).toBe(false);
    await t.run((ctx) => ctx.db.patch(card, { kind: "email", status: "expired" }));
    expect((await t.query(internal.drafter.context, { messageId }))!.already).toBe(true);
  });

  test("an expired event card's message is drafted again, re-checking the calendar", async () => {
    const { t, tenantId } = await setup();
    const g = world({ extraction: '{"intent":"propose_time","start":"2026-10-20T14:00"}', primary: [{ id: "x", summary: "Dentist", start: { dateTime: new Date(TUE_2PM).toISOString() }, end: { dateTime: new Date(TUE_2PM + 3_600_000).toISOString() } }] });
    vi.stubGlobal("fetch", g.f);
    const messageId = await inbound(t, tenantId, "Can we do Tuesday 2pm?");
    const card = await t.run((ctx) => ctx.db.insert("proposals", {
      tenantId, kind: "event", toAddress: SAM, body: "See you then.", basis: [], summary: "s", status: "expired", sourceKind: "email", sourceId: messageId, edited: false,
      meta: { event: { op: "insert", title: "Meeting with Sam", startMs: TUE_2PM, endMs: TUE_2PM + 30 * MIN, timeZone: ZONE, attendees: [SAM] } }, createdAt: NOW - 60_000,
    }));
    const pid = await t.action(internal.drafter.draft, { messageId });
    expect(pid).not.toBe(card);
    const p = (await t.run((ctx) => ctx.db.get(pid!)))!;
    expect(p).toMatchObject({ kind: "email", status: "pending", sourceId: messageId });
    expect(p.meta.offer!.slots).toHaveLength(3); // 2pm is booked now: an offer
  });
});
