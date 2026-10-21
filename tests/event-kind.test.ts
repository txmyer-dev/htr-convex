// The event card on every surface (U5): its summary, its phone push, its digest card, what the
// surface shows, the reply row it leaves, and its failure path. Dispatch itself is U6: here the
// DISPATCH entry still throws, which is exactly the failure the push and Skip have to handle.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { digestEmail, type BuiltDigest } from "../convex/digest";
import { channelOf, renderLine, type DigestItem } from "../convex/lib/digest/render";
import { noticeFor } from "../convex/lib/notify/ntfy";
import { summarize } from "../convex/lib/proposals/lifecycle";
import { surfaceKey } from "../convex/surface";

const modules = import.meta.glob("../convex/**/*.ts");
const TZ = "America/New_York";
const MIN = 60_000;
// Wed Oct 21 2026, 2:00 PM in New York (EDT, UTC-4).
const START = Date.UTC(2026, 9, 21, 18, 0);
// Tue Oct 20 2026, 1:00 PM in New York: where a moved event sits now.
const WAS = Date.UTC(2026, 9, 20, 17, 0);

const insert = {
  op: "insert" as const, title: "Intro call", startMs: START, endMs: START + 30 * MIN, timeZone: TZ,
  attendees: ["sam@x.com", "ann@y.com"],
};
const move = {
  ...insert, op: "move" as const, title: "Weekly sync", endMs: START + 45 * MIN, targetEventId: "evt123",
  previousStartMs: WAS, previousEndMs: WAS + 45 * MIN,
};
const links = { sign: "https://x/sign", reject: "https://x/reject", edit: "https://x/edit" };
const REPLY = "Wednesday at 2 works, invite on its way.";

const ENV = ["HTR_RULING_SECRET", "CONVEX_SITE_URL", "HTR_NTFY_TOPIC", "HTR_NTFY_URL"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("the event card's words", () => {
  test("the summary names the time and who it is with; a move names both times", () => {
    expect(summarize("Sam", "sam@x.com", REPLY, "event", insert)).toBe("Event: Wed Oct 21, 2:00 PM with Sam");
    expect(summarize(null, "sam@x.com", REPLY, "event", move)).toBe("Move: Tue Oct 20, 1:00 PM to Wed Oct 21, 2:00 PM with sam@x.com");
  });

  test("the phone push: its own title and button, and the message leads with time, length and every attendee", () => {
    const n = noticeFor({ kind: "event", toName: "Sam", toAddress: "sam@x.com", body: REPLY, basis: ["Can we meet Wednesday at 2?"], event: insert }, links, "https://x/r");
    expect(n.title).toBe("Add to calendar: Intro call");
    expect(n.tags).toEqual(["calendar"]);
    expect(n.actions![0]).toEqual({ action: "http", label: "Add + send", url: links.sign, method: "POST", clear: true });
    expect(n.actions![1].label).toBe("Skip");
    expect(n.message).toBe(
      "Wed Oct 21, 2:00 PM · 30 min\nGoogle invites: sam@x.com, ann@y.com\n\n" + REPLY + "\n\n“Can we meet Wednesday at 2?”",
    );
  });

  test("a move push says where it was and who Google updates", () => {
    const n = noticeFor({ kind: "event", toName: "Sam", toAddress: "sam@x.com", body: REPLY, basis: [], event: move }, links, "https://x/r");
    expect(n.title).toBe("Move on calendar: Weekly sync");
    expect(n.actions![0].label).toBe("Move + send");
    expect(n.message).toBe("Wed Oct 21, 2:00 PM · 45 min (was Tue Oct 20, 1:00 PM)\nGoogle updates: sam@x.com, ann@y.com\n\n" + REPLY);
  });

  test("the digest line and card list the time and every attendee Google will notify", async () => {
    process.env.HTR_RULING_SECRET = "test-secret";
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    const item: DigestItem = { kind: "event", toName: "Sam", toAddress: "sam@x.com", body: REPLY, basis: [], event: insert };
    expect(channelOf(item)).toBe("email");
    const line = renderLine(1, item, TZ, START - 86_400_000);
    expect(line).toContain("Wed Oct 21, 2:00 PM · 30 min");
    expect(line).toContain("sam@x.com, ann@y.com");
    const built: BuiltDigest = {
      digestId: "d1" as Id<"digests">, body: line, meetings: [],
      items: [{ n: 1, proposalId: "p1" as Id<"proposals">, item, pushed: false }],
    };
    const tenant = { slug: "tony", timeZone: TZ, owner: { names: [], email: "t@x.com" } } as unknown as Doc<"tenants">;
    const { html } = await digestEmail(tenant, built);
    expect(html).toContain("Google invites: sam@x.com, ann@y.com");
    expect(html).toContain("Wed Oct 21, 2:00 PM · 30 min");
    expect(html).toContain(">Add + send</a>");
  });
});

async function setup() {
  process.env.HTR_RULING_SECRET = "test-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
  return { t, tenant };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

async function card(t: T, tenantId: Id<"tenants">, over: Partial<Doc<"proposals">> = {}): Promise<Id<"proposals">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("proposals", {
      tenantId, kind: "event", toAddress: "sam@x.com", toName: "Sam", body: REPLY, basis: [], summary: "Event", status: "signed",
      edited: false, createdAt: Date.now(), meta: { subject: "Meet?", threadId: "th1", messageId: "m1", event: insert }, ...over,
    }),
  );
}

describe("an event card through the funnel", () => {
  test("the surface list carries the event, a move with its current time", async () => {
    const { t, tenant } = await setup();
    await card(t, tenant._id, { status: "pending", meta: { event: move } });
    const rows = await t.query(api.proposals.list, { slug: tenant.slug, key: await surfaceKey(tenant.slug) });
    expect(rows[0].event).toMatchObject({ op: "move", startMs: START, previousStartMs: WAS, attendees: ["sam@x.com", "ann@y.com"] });
  });

  test("a sent event card leaves one outbound message row in its thread", async () => {
    const { t, tenant } = await setup();
    const id = await card(t, tenant._id, { status: "sending" });
    await t.mutation(internal.proposals.finishSend, { proposalId: id, ref: "gm-1" });
    const out = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.direction === "out"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "email", toAddress: "sam@x.com", body: REPLY, threadId: "th1", vendorRef: "gm-1" });
  });

  test("a failed event card stores its error and pushes its reason to the phone, once, with the page link", async () => {
    const { t, tenant } = await setup();
    process.env.HTR_NTFY_TOPIC = "htr-test";
    const pushes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).startsWith("https://ntfy.sh")) pushes.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const id = await card(t, tenant._id);
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow(/calendar not connected/);
    const p = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/calendar not connected/);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toBe("Not sent: Intro call");
    expect(String(pushes[0].message)).toContain("calendar not connected");
    expect(pushes[0].click).toBe(`https://test.convex.site/?t=${tenant.slug}&k=${await surfaceKey(tenant.slug)}`);
  });

  test("a failed email card sends no failure push", async () => {
    const { t, tenant } = await setup();
    process.env.HTR_NTFY_TOPIC = "htr-test";
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", f);
    const id = await card(t, tenant._id, { kind: "email", meta: {} });
    await expect(t.action(internal.mail.dispatch, { proposalId: id })).rejects.toThrow();
    expect(f.mock.calls.filter(([u]) => String(u).startsWith("https://ntfy.sh"))).toHaveLength(0);
  });

  test("Retry on another tenant's page leaves a failed card alone", async () => {
    const { t, tenant } = await setup();
    const { _id, _creationTime, ...doc } = tenant;
    await t.run(async (ctx) => ctx.db.insert("tenants", { ...doc, slug: "other" }));
    const id = await card(t, tenant._id, { status: "failed", error: "calendar 500" });
    const outcome = await t.action(api.mail.retrySend, { slug: "other", key: await surfaceKey("other"), proposalId: id });
    expect(outcome).toBe("nothing to do");
    expect((await t.run(async (ctx) => ctx.db.get(id)))!).toMatchObject({ status: "failed", error: "calendar 500" });
  });

  test("Skip on the page drops a failed event card; a failed email card stays failed", async () => {
    const { t, tenant } = await setup();
    const key = await surfaceKey(tenant.slug);
    const ev = await card(t, tenant._id, { status: "failed", error: "calendar 500" });
    const em = await card(t, tenant._id, { status: "failed", error: "mail 500", kind: "email", meta: {} });
    expect(await t.mutation(api.rulings.skipFailed, { slug: tenant.slug, key, proposalId: ev })).toBe("Skipped. Nothing more goes out for it.");
    expect(await t.mutation(api.rulings.skipFailed, { slug: tenant.slug, key, proposalId: em })).toBe("Only a failed calendar card can be skipped.");
    const [a, b] = await t.run(async (ctx) => [await ctx.db.get(ev), await ctx.db.get(em)]);
    expect(a!.status).toBe("rejected");
    expect(b!.status).toBe("failed");
    const rulings = await t.run(async (ctx) => ctx.db.query("rulings").collect());
    expect(rulings.map((r) => [r.proposalId, r.verdict, r.from])).toEqual([[ev, "reject", "surface"]]);
  });
});
