// The calendar claw over a fake Google: what each call puts on the wire, how pages, all-day
// events and per-calendar errors come back, and that only insert and move write.
// Offline: every request goes to the fake below.

import { afterEach, describe, expect, test } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { calendarClaw, clawsOf } from "../convex/adapters/resolve";
import { googleCalendar } from "../convex/adapters/vendors";
import { CALENDAR_OWNED, CALENDAR_READ, GMAIL_READ, GMAIL_SEND } from "../convex/lib/google/auth";
import { TENANTS } from "../convex/install";

const API = "https://www.googleapis.com/calendar/v3";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { method: string; url: URL; body?: unknown };
type Route = (c: Call) => Response | undefined;

/** A fake Google: the token endpoint plus whatever routes a test gives, recording every calendar call. */
function google(...routes: Route[]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "at", expires_in: 3600 });
    const c: Call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    for (const r of routes) {
      const res = r(c);
      if (res) return res;
    }
    return json({ error: { message: `no route for ${c.method} ${url.pathname}` } }, 500);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const at = (method: string, path: string, res: (c: Call) => Response): Route =>
  (c) => (c.method === method && c.url.pathname === `/calendar/v3${path}` ? res(c) : undefined);

let rt = 0;
const claw = (f: typeof fetch) => googleCalendar({ clientId: "cid", clientSecret: "csec", refreshToken: `rt-cal-${++rt}` }, f);

const ZONE = "America/New_York";
const T0 = Date.UTC(2026, 9, 21, 18, 0); // Wed Oct 21 2026, 2:00 PM New York
const T1 = T0 + 30 * 60_000;

/** Every request that isn't a read: GETs, and the free/busy query (a POST that only reads). */
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.url.pathname !== "/calendar/v3/freeBusy");

describe("insert", () => {
  test("posts to primary with sendUpdates=all, the supplied id, the attendees and the tenant zone", async () => {
    const { f, calls } = google(at("POST", "/calendars/primary/events", (c) => json({ ...(c.body as object), status: "confirmed" })));
    const r = await claw(f).insert({ summary: "Call", description: "About the deck", start: T0, end: T1, timeZone: ZONE, attendees: ["sam@example.com"] }, "abc123");
    expect(r.exists).toBe(false);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(c.url.searchParams.get("sendUpdates")).toBe("all");
    expect(c.body).toEqual({
      id: "abc123",
      summary: "Call",
      description: "About the deck",
      start: { dateTime: "2026-10-21T18:00:00.000Z", timeZone: ZONE },
      end: { dateTime: "2026-10-21T18:30:00.000Z", timeZone: ZONE },
      attendees: [{ email: "sam@example.com" }],
    });
  });

  test("a 409 (the id is taken) comes back as exists, not thrown", async () => {
    const { f } = google(at("POST", "/calendars/primary/events", () => json({ error: { code: 409, message: "The requested identifier already exists." } }, 409)));
    await expect(claw(f).insert({ summary: "Call", start: T0, end: T1, timeZone: ZONE, attendees: ["sam@example.com"] }, "abc123")).resolves.toEqual({ exists: true });
  });

  test("any other failure throws", async () => {
    const { f } = google(at("POST", "/calendars/primary/events", () => json({ error: { message: "forbidden" } }, 403)));
    await expect(claw(f).insert({ summary: "Call", start: T0, end: T1, timeZone: ZONE, attendees: [] }, "abc123")).rejects.toThrow("403");
  });
});

describe("move", () => {
  test("patches only start and end on primary, with sendUpdates=all", async () => {
    const { f, calls } = google(at("PATCH", "/calendars/primary/events/ev9", (c) => json({ id: "ev9", status: "confirmed", ...(c.body as object) })));
    await claw(f).move("ev9", T0, T1, ZONE);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.method).toBe("PATCH");
    expect(c.url.pathname).toBe("/calendar/v3/calendars/primary/events/ev9");
    expect(c.url.searchParams.get("sendUpdates")).toBe("all");
    expect(Object.keys(c.body as object).sort()).toEqual(["end", "start"]);
    expect(c.body).toEqual({
      start: { dateTime: "2026-10-21T18:00:00.000Z", timeZone: ZONE },
      end: { dateTime: "2026-10-21T18:30:00.000Z", timeZone: ZONE },
    });
  });
});

describe("get", () => {
  test("reads primary; a cancelled event says so, a missing one is null", async () => {
    const { f, calls } = google(
      at("GET", "/calendars/primary/events/gone", () => json({ error: { code: 404 } }, 404)),
      at("GET", "/calendars/primary/events/old", () => json({ id: "old", status: "cancelled", start: { dateTime: "2026-10-21T18:00:00Z" }, end: { dateTime: "2026-10-21T18:30:00Z" } })),
    );
    const c = claw(f);
    expect(await c.get("gone")).toBeNull();
    expect(await c.get("old")).toMatchObject({ id: "old", calendarId: "primary", status: "cancelled", start: T0, end: T1 });
    expect(calls.every((x) => x.url.pathname.startsWith("/calendar/v3/calendars/primary/"))).toBe(true);
  });
});

describe("calendars", () => {
  test("lists the non-hidden entries with the primary flag and zone", async () => {
    const { f } = google(at("GET", "/users/me/calendarList", () => json({
      items: [
        { id: "me@gmail.com", summary: "Me", primary: true, timeZone: ZONE },
        { id: "team@group", summary: "Team", timeZone: "Europe/London" },
        { id: "hid@group", summary: "Hidden", hidden: true },
      ],
    })));
    expect(await claw(f).calendars()).toEqual([
      { id: "me@gmail.com", summary: "Me", primary: true, timeZone: ZONE },
      { id: "team@group", summary: "Team", primary: false, timeZone: "Europe/London" },
    ]);
  });
});

describe("events", () => {
  test("follows nextPageToken until it is absent and keeps all-day and timed events apart", async () => {
    const pages: Record<string, unknown> = {
      "": {
        timeZone: ZONE,
        nextPageToken: "p2",
        items: [{
          id: "a", summary: "Offsite", status: "confirmed", start: { date: "2026-10-21" }, end: { date: "2026-10-22" },
        }],
      },
      p2: {
        timeZone: ZONE,
        items: [{
          id: "b", summary: "Sync", status: "confirmed",
          start: { dateTime: "2026-10-21T14:00:00-04:00" }, end: { dateTime: "2026-10-21T14:30:00-04:00" },
          organizer: { email: "me@gmail.com", self: true },
          attendees: [{ email: "me@gmail.com", self: true, responseStatus: "accepted" }, { email: "Sam@Example.com", responseStatus: "needsAction" }],
        }],
      },
    };
    const { f, calls } = google(at("GET", "/calendars/primary/events", (c) => json(pages[c.url.searchParams.get("pageToken") ?? ""])));
    const evs = await claw(f).events({ start: T0 - 86_400_000, end: T0 + 86_400_000 }, ["primary"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url.searchParams.get("pageToken")).toBe("p2");
    for (const c of calls) {
      expect(c.url.searchParams.get("singleEvents")).toBe("true");
      expect(c.url.searchParams.get("orderBy")).toBe("startTime");
    }
    expect(evs).toEqual([
      {
        id: "a", calendarId: "primary", title: "Offsite", allDay: true,
        start: Date.UTC(2026, 9, 21, 4), end: Date.UTC(2026, 9, 22, 4), // local midnights in New York (EDT)
        status: "confirmed", attendees: [], organizerSelf: false, responseStatus: undefined, transparent: false,
      },
      {
        id: "b", calendarId: "primary", title: "Sync", allDay: false, start: T0, end: T1,
        status: "confirmed", attendees: ["me@gmail.com", "sam@example.com"], organizerSelf: true, responseStatus: "accepted", transparent: false,
      },
    ]);
  });

  test("with no ids given, reads every non-hidden calendar", async () => {
    const { f, calls } = google(
      at("GET", "/users/me/calendarList", () => json({ items: [{ id: "me@gmail.com", primary: true }, { id: "team@group" }, { id: "hid@group", hidden: true }] })),
      (c) => (c.url.pathname.startsWith("/calendar/v3/calendars/") ? json({ items: [] }) : undefined),
    );
    await claw(f).events({ start: T0, end: T1 });
    expect(calls.filter((c) => c.url.pathname.endsWith("/events")).map((c) => decodeURIComponent(c.url.pathname.split("/")[4]))).toEqual(["me@gmail.com", "team@group"]);
  });
});

describe("free/busy", () => {
  test("asks for every calendar in one request and surfaces a per-calendar error as an error, not free", async () => {
    const { f, calls } = google(at("POST", "/freeBusy", () => json({
      calendars: {
        "me@gmail.com": { busy: [{ start: "2026-10-21T18:00:00Z", end: "2026-10-21T18:30:00Z" }] },
        "team@group": { busy: [], errors: [{ domain: "global", reason: "notFound" }] },
      },
    })));
    const fb = await claw(f).freeBusy({ start: T0 - 3_600_000, end: T1 + 3_600_000 }, ["me@gmail.com", "team@group", "lost@group"]);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { items: unknown }).items).toEqual([{ id: "me@gmail.com" }, { id: "team@group" }, { id: "lost@group" }]);
    expect(fb.busy["me@gmail.com"]).toEqual([{ start: T0, end: T1 }]);
    expect(fb.errors).toEqual({ "team@group": "notFound", "lost@group": "missing from the response" });
    expect(fb.busy["team@group"]).toBeUndefined();
  });
});

describe("primary busy (dispatch's own check)", () => {
  test("drops the named event, cancelled, free and declined events; the rest are busy", async () => {
    const ev = (id: string, extra: object = {}) => ({ id, status: "confirmed", start: { dateTime: "2026-10-21T18:00:00Z" }, end: { dateTime: "2026-10-21T18:30:00Z" }, ...extra });
    const { f, calls } = google(at("GET", "/calendars/primary/events", () => json({
      items: [
        ev("mine"), ev("busy"), ev("x", { status: "cancelled" }), ev("y", { transparency: "transparent" }),
        ev("z", { attendees: [{ email: "me@gmail.com", self: true, responseStatus: "declined" }] }),
      ],
    })));
    expect(await claw(f).primaryBusy({ start: T0, end: T1 }, "mine")).toEqual([{ start: T0, end: T1 }]);
    expect(calls.every((c) => c.url.pathname === "/calendar/v3/calendars/primary/events")).toBe(true);
  });
});

describe("the write gate (AE4)", () => {
  test("no read issues a write: across every read, only insert and move are non-GET", async () => {
    const { f, calls } = google(
      at("GET", "/users/me/calendarList", () => json({ items: [{ id: "me@gmail.com", primary: true }] })),
      at("POST", "/freeBusy", () => json({ calendars: { "me@gmail.com": { busy: [] } } })),
      at("GET", "/calendars/primary/events/e1", () => json({ id: "e1", status: "confirmed", start: { dateTime: "2026-10-21T18:00:00Z" }, end: { dateTime: "2026-10-21T18:30:00Z" } })),
      (c) => (c.method === "GET" && c.url.pathname.endsWith("/events") ? json({ items: [] }) : undefined),
      at("POST", "/calendars/primary/events", () => json({ id: "n1", status: "confirmed" })),
      at("PATCH", "/calendars/primary/events/e1", () => json({ id: "e1", status: "confirmed" })),
    );
    const c = claw(f);
    await c.calendars();
    await c.events({ start: T0, end: T1 });
    await c.freeBusy({ start: T0, end: T1 }, ["me@gmail.com"]);
    await c.primaryBusy({ start: T0, end: T1 });
    await c.get("e1");
    await c.probe!();
    expect(writes(calls)).toEqual([]);
    await c.insert({ summary: "Call", start: T0, end: T1, timeZone: ZONE, attendees: [] }, "n1");
    await c.move("e1", T0, T1, ZONE);
    expect(writes(calls).map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "POST /calendar/v3/calendars/primary/events",
      "PATCH /calendar/v3/calendars/primary/events/e1",
    ]);
  });
});

describe("resolve and the heartbeat", () => {
  const ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"];
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  function gmailTenant(scope: string | undefined): Doc<"tenants"> {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csec";
    return {
      _id: "t1" as Doc<"tenants">["_id"], _creationTime: 0, ...TENANTS[0],
      adapters: { mail: { kind: "gmail" } },
      channels: { gmail: { address: "me@gmail.com", refreshToken: `rt-hb-${++rt}`, grantedAt: 0, scope } },
    } as Doc<"tenants">;
  }
  const FULL = [GMAIL_READ, GMAIL_SEND, CALENDAR_READ, CALENDAR_OWNED].join(" ");
  const calendarOf = (t: Doc<"tenants">, f: typeof fetch) => clawsOf(t, f).find((c) => c.port === "calendar");

  const healthy = () => google(
    at("GET", "/users/me/calendarList", () => json({ items: [{ id: "me@gmail.com", summary: "Me", primary: true }, { id: "team@group", summary: "Team" }] })),
    at("POST", "/freeBusy", () => json({ calendars: { "me@gmail.com": { busy: [] }, "team@group": { busy: [] } } })),
  );

  test("a calendar grant: the claw resolves and its probe passes, over every non-hidden calendar", async () => {
    const { f, calls } = healthy();
    const entry = calendarOf(gmailTenant(FULL), f)!;
    expect(entry.error).toBeUndefined();
    expect(entry.claw!.name).toBe("google-calendar");
    await entry.claw!.probe!();
    const fb = calls.find((c) => c.url.pathname.endsWith("/freeBusy"))!;
    expect((fb.body as { items: unknown }).items).toEqual([{ id: "me@gmail.com" }, { id: "team@group" }]);
  });

  test("a mail-only grant: the calendar is down with reconnect Google", () => {
    const { f } = healthy();
    for (const scope of [`${GMAIL_READ} ${GMAIL_SEND}`, undefined]) {
      const t = gmailTenant(scope);
      expect(() => calendarClaw(t, f)).toThrow("calendar not connected — reconnect Google");
      expect(calendarOf(t, f)).toEqual({ port: "calendar", claw: null, error: "calendar not connected — reconnect Google" });
    }
  });

  test("a tenant without Gmail has no calendar claw, and nothing to report", () => {
    const t = { _id: "t2" as Doc<"tenants">["_id"], _creationTime: 0, ...TENANTS[0], channels: { inboxId: "x@agentmail.to" } } as Doc<"tenants">;
    const { f } = healthy();
    expect(calendarClaw(t, f)).toBeNull();
    expect(calendarOf(t, f)).toEqual({ port: "calendar", claw: null });
  });

  test("one calendar failing free/busy fails the probe, naming that calendar", async () => {
    const { f } = google(
      at("GET", "/users/me/calendarList", () => json({ items: [{ id: "me@gmail.com", summary: "Me", primary: true }, { id: "team@group", summary: "Team" }] })),
      at("POST", "/freeBusy", () => json({ calendars: { "me@gmail.com": { busy: [] }, "team@group": { errors: [{ domain: "global", reason: "backendError" }] } } })),
    );
    const err = await calendarOf(gmailTenant(FULL), f)!.claw!.probe!().then(() => null, (e: Error) => e.message);
    expect(err).toContain("Team");
    expect(err).toContain("backendError");
    expect(err).not.toContain("Me (");
  });
});
