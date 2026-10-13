// The meeting recorder (phase 3, Fireflies): the webhook in, the notes read back, action items
// down the call line's path, and the note in the digest's Meetings section. Offline.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { clawsOf } from "../convex/adapters/resolve";
import { digestEmail, meetingNotice } from "../convex/digest";
import { TENANTS } from "../convex/install";
import { renderMeetings } from "../convex/lib/digest/render";
import { getMeeting, isReady, parseActionItems, parseWebhook, toMeeting, verifySignature, type Meeting } from "../convex/lib/meetings/fireflies";
import { itemsOf } from "../convex/meetings";
import schema from "../convex/schema";
import { intakeKey } from "../convex/tasks";

const modules = import.meta.glob("../convex/**/*.ts");
const ENV = ["FIREFLIES_API_KEY", "FIREFLIES_WEBHOOK_SECRET"];

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ACTION_ITEMS = `**Tony Myers**
Send Ben the revised proposal by Friday (12:34)
- Book the follow-up call (20:01)

**Ben Hidalgo**
Review the contract with legal (15:10)

Share the recording`;

const RAW = {
  id: "FF123", title: "Ben / Tony weekly", date: Date.UTC(2026, 9, 12, 14, 0), duration: 31.6, organizer_email: "tony@felaniam.cloud",
  transcript_url: "https://app.fireflies.ai/view/FF123", participants: ["ben@hidalgo.co, tony@felaniam.cloud"],
  meeting_attendees: [{ displayName: "Ben Hidalgo", email: "ben@hidalgo.co" }, { displayName: "Tony Myers", email: "tony@felaniam.cloud" }],
  summary: { overview: "Went through the beta plan and the contract.", action_items: ACTION_ITEMS, shorthand_bullet: "📋 Beta plan" },
};

describe("the wire", () => {
  test("both webhook shapes; only 'ready' events count", () => {
    expect(parseWebhook({ meetingId: "a", eventType: "Transcription completed" })).toEqual({ meetingId: "a", event: "Transcription completed" });
    expect(parseWebhook({ event: "meeting.summarized", meeting_id: "b", timestamp: 1 })).toEqual({ meetingId: "b", event: "meeting.summarized" });
    expect(parseWebhook({ hello: 1 })).toBeNull();
    expect(parseWebhook("nope")).toBeNull();
    expect(isReady("Transcription completed") && isReady("meeting.transcribed") && isReady("meeting.summarized")).toBe(true);
    expect(isReady("meeting.bot_joined")).toBe(false);
  });

  test("signature: hex HMAC-SHA256 of the raw body, v2's sha256= prefix optional", async () => {
    const body = '{"meeting_id":"x","event":"meeting.summarized"}';
    const hex = await sign("s3cret", body);
    expect(await verifySignature("s3cret", body, hex)).toBe(true);
    expect(await verifySignature("s3cret", body, `sha256=${hex}`)).toBe(true);
    expect(await verifySignature("other", body, hex)).toBe(false);
    expect(await verifySignature("s3cret", `${body} `, hex)).toBe(false);
    expect(await verifySignature("s3cret", body, null)).toBe(false);
  });

  test("action items: grouped by person, bullets and timestamps stripped, unassigned kept", () => {
    expect(parseActionItems(ACTION_ITEMS)).toEqual([
      { who: "Tony Myers", what: "Send Ben the revised proposal by Friday" },
      { who: "Tony Myers", what: "Book the follow-up call" },
      { who: "Ben Hidalgo", what: "Review the contract with legal" },
      { who: "Ben Hidalgo", what: "Share the recording" },
    ]);
    expect(parseActionItems("1. Do the thing\n2) Another (1:02:03)")).toEqual([{ what: "Do the thing" }, { what: "Another" }]);
    expect(parseActionItems(null)).toEqual([]);
    expect(parseActionItems("**Speaker 2**\nShare the link (3:10)")).toEqual([{ what: "Share the link" }]); // a placeholder is nobody
  });

  test("toMeeting: attendees once each, minutes rounded", () => {
    const m = toMeeting(RAW);
    expect(m).toMatchObject({ id: "FF123", title: "Ben / Tony weekly", durationMin: 32, overview: "Went through the beta plan and the contract." });
    expect(m.attendees).toEqual(["Ben Hidalgo", "Tony Myers"]);
    expect(m.actionItems).toHaveLength(4);
  });

  test("getMeeting asks GraphQL with the key; errors come back as errors", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer ff-key");
      expect(JSON.parse(String(init.body)).variables).toEqual({ id: "FF123" });
      return new Response(JSON.stringify({ data: { transcript: RAW } }), { status: 200 });
    });
    expect((await getMeeting("ff-key", "FF123", f as unknown as typeof fetch))?.title).toBe("Ben / Tony weekly");
    const bad = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Invalid API key" }] }), { status: 200 }));
    await expect(getMeeting("x", "FF123", bad as unknown as typeof fetch)).rejects.toThrow("Invalid API key");
  });
});

describe("items and notes", () => {
  const m: Meeting = toMeeting(RAW);

  test("the owner's items are commitments; others' are owed, with who; a named day becomes due", () => {
    const items = itemsOf(m, ["Tony", "Tony Myers"], "America/New_York");
    expect(items.map((i) => [i.type, i.who, i.destination])).toEqual([
      ["my_commitment", undefined, "clickup.task"], ["my_commitment", undefined, "clickup.task"],
      ["owed_to_me", "Ben Hidalgo", "clickup.task"], ["owed_to_me", "Ben Hidalgo", "clickup.task"],
    ]);
    expect(items[0].due?.slice(0, 10)).toBe("2026-10-16"); // Friday after a Monday meeting
    expect(items[1].due).toBeUndefined();
    const nobody = itemsOf({ ...m, actionItems: [{ what: "Share the link" }] }, ["Tony"], "UTC");
    expect(nobody[0]).toMatchObject({ type: "action_item", who: undefined });
  });

  test("the overview keeps its lines and loses its markdown", () => {
    const text = renderMeetings([{ ...m, overview: "- **ECC Harness:** structured.\n- **Mods:**  colors" }], "UTC");
    expect(text).toContain("- ECC Harness: structured.\n- Mods: colors");
  });

  test("the Meetings section: when, with whom (not the owner), overview, items, link", () => {
    const text = renderMeetings([m], "America/New_York", ["Tony", "Tony Myers"]);
    expect(text).toContain("Meetings (1)");
    expect(text).toContain("Ben / Tony weekly (Mon Oct 12, 10:00, 32 min) with Ben Hidalgo");
    expect(text).toContain("Action items:\n- Tony Myers: Send Ben the revised proposal by Friday");
    expect(text).toContain("- Ben Hidalgo: Review the contract with legal");
    expect(text).toContain("Notes: https://app.fireflies.ai/view/FF123");
    expect(renderMeetings([], "UTC")).toBe("");
  });

  test("the phone notice", () => {
    const n = meetingNotice(m, "https://x/surface");
    expect(n.title).toBe("Meeting: Ben / Tony weekly");
    expect(n.message).toContain("• Ben Hidalgo: Review the contract with legal");
    expect(n.click).toBe("https://app.fireflies.ai/view/FF123");
  });

  test("the heartbeat watches Fireflies once a key is set", () => {
    const t = { _id: "t1", ...TENANTS[0], channels: {} } as unknown as Doc<"tenants">;
    expect(clawsOf(t).find((c) => c.port === "meetings")?.claw).toBeNull();
    process.env.FIREFLIES_API_KEY = "ff";
    expect(clawsOf(t).find((c) => c.port === "meetings")?.claw?.name).toBe("fireflies");
  });
});

async function setup(withTasks = true) {
  Object.assign(process.env, { HTR_RULING_SECRET: "test-secret", CONVEX_SITE_URL: "https://test.convex.site", FIREFLIES_WEBHOOK_SECRET: "ff-secret", FIREFLIES_API_KEY: "ff-key" });
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  let tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
  if (!withTasks) {
    await t.run(async (ctx) => await ctx.db.patch(tenant._id, { tasks: undefined }));
    tenant = (await t.run(async (ctx) => await ctx.db.get(tenant._id)))!;
  }
  return { t, tenant };
}

describe("the webhook", () => {
  const hook = (body: string, headers: Record<string, string>) => ({ method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  test("signed: recorded once and the read scheduled; replay is a duplicate; unsigned is refused", async () => {
    const { t } = await setup();
    const body = JSON.stringify({ event: "meeting.summarized", meeting_id: "FF123", timestamp: 1 });
    const sig = `sha256=${await sign("ff-secret", body)}`;
    const first = await t.fetch("/intake/tony/meetings", hook(body, { "x-hub-signature": sig }));
    expect(await first.json()).toEqual({ ok: true, outcome: "fetching" });
    expect(await (await t.fetch("/intake/tony/meetings", hook(body, { "x-hub-signature": sig }))).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect((await t.fetch("/intake/tony/meetings", hook(body, { "x-hub-signature": "sha256=00" }))).status).toBe(401);
    const reads = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes("meetings:read")));
    expect(reads).toHaveLength(1);
  });

  test("the intake key works too; a bot joining is ignored; bad bodies are 400", async () => {
    const { t } = await setup();
    const bearer = { authorization: `Bearer ${await intakeKey("tony")}` };
    expect(await (await t.fetch("/intake/tony/meetings", hook(JSON.stringify({ meetingId: "FF9", eventType: "Transcription completed" }), bearer))).json()).toEqual({ ok: true, outcome: "fetching" });
    expect(await (await t.fetch("/intake/tony/meetings", hook(JSON.stringify({ event: "meeting.bot_joined", meeting_id: "FF9" }), bearer))).json()).toEqual({ ok: true, ignored: "meeting.bot_joined" });
    expect((await t.fetch("/intake/tony/meetings", hook("{", bearer))).status).toBe(400);
    expect((await t.fetch("/intake/tony/meetings", hook("{}", bearer))).status).toBe(400);
    expect((await t.fetch("/intake/tony/meetings", { method: "GET", headers: bearer })).status).toBe(405);
  });
});

describe("read and record", () => {
  test("no summary yet: try again later; then the note is kept and its items proposed as tasks", async () => {
    const { t, tenant } = await setup();
    let summary: typeof RAW.summary | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { transcript: { ...RAW, summary } } }), { status: 200 })));
    expect(await t.action(internal.meetings.read, { tenantId: tenant._id, meetingId: "FF123", attempt: 1 })).toBe("waiting");
    summary = RAW.summary;
    expect(await t.action(internal.meetings.read, { tenantId: tenant._id, meetingId: "FF123", attempt: 2 })).toBe("recorded");
    const rows = await t.run(async (ctx) => await ctx.db.query("meetings").collect());
    expect(rows).toHaveLength(1);
    const tasks = await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).filter((p) => p.kind === "task"));
    expect(tasks.map((p) => p.body)).toEqual(["Send Ben the revised proposal by Friday", "Book the follow-up call", "Review the contract with legal", "Share the recording"]);
    expect(tasks[0]).toMatchObject({ sourceKind: "call_item", sourceId: "fireflies:FF123:a1" });

    // Read again (Fireflies resent it): the row is updated, nothing is proposed twice.
    await t.action(internal.meetings.read, { tenantId: tenant._id, meetingId: "FF123", attempt: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(4);
    expect(await t.run(async (ctx) => (await ctx.db.query("meetings").collect()).length)).toBe(1);
  });

  test("the digest reports a meeting once, beside the numbered drafts", async () => {
    const { t, tenant } = await setup();
    await t.mutation(internal.meetings.record, { tenantId: tenant._id, meeting: toMeeting(RAW) });
    const built = (await t.mutation(internal.digest.build, { tenantId: tenant._id }))!;
    expect(built.items).toHaveLength(4);
    expect(built.meetings.map((m) => m.item.title)).toEqual(["Ben / Tony weekly"]);
    expect(built.body).toMatch(/^4 waiting on you\./);
    expect(built.body).toContain("Meetings (1)");
    const mail = await digestEmail(tenant, built);
    expect(mail.subject).toBe("4 waiting on you · 1 meeting");
    expect(mail.html).toContain(">Meetings</h2>");
    expect(built.body).not.toContain("with Ben Hidalgo, Tony Myers"); // the owner isn't "with" themselves
    const again = (await t.mutation(internal.digest.build, { tenantId: tenant._id }))!;
    expect(again.meetings).toHaveLength(0);
  });

  test("no task list: no proposals, and a digest of the meeting alone", async () => {
    const { t, tenant } = await setup(false);
    await t.mutation(internal.meetings.record, { tenantId: tenant._id, meeting: toMeeting(RAW) });
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(0);
    const built = (await t.mutation(internal.digest.build, { tenantId: tenant._id }))!;
    expect(built.items).toHaveLength(0);
    expect(built.body.startsWith("Meetings (1)")).toBe(true);
    const mail = await digestEmail(tenant, built);
    expect(mail.subject).toBe("Meeting notes: Ben / Tony weekly");
    expect(mail.text).not.toContain("One tap:");
  });
});
