// Priority (phase 3): a score from what the reader knows as a message lands; high rings the
// owner's phone before any draft, quiet hours permitting, and leads the digest.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { hasMail } from "../convex/adapters/resolve";
import { TENANTS } from "../convex/install";
import { renderLine } from "../convex/lib/digest/render";
import type { InboundMail } from "../convex/lib/mail/inbound";
import { noticeFor } from "../convex/lib/notify/ntfy";
import { alertAt, score, type Signals } from "../convex/lib/reader/priority";
import { priorityNotice } from "../convex/mail";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const NY = "America/New_York";
const MONDAY_10AM_NY = Date.UTC(2026, 9, 12, 14, 0); // Mon 12 Oct 2026, 10:00 EDT

function signals(over: Partial<Signals> = {}): Signals {
  return {
    subject: "Hello", text: "Just saying hi.", automated: false, ownerNames: ["Tony", "Tony Myers"], priorFromSender: 0,
    repliesToOwner: false, threadRulings: { agreed: 0, skipped: 0 }, nowMs: MONDAY_10AM_NY, timeZone: NY, ...over,
  };
}

describe("score", () => {
  test("automated is low whatever it says", () => {
    expect(score(signals({ automated: true, subject: "URGENT", text: "Can you reply today?" }))).toEqual({ score: 0, level: "low", reasons: ["automated"] });
  });

  test("a hello from a stranger is low; a stranger's question with a later deadline is normal", () => {
    expect(score(signals()).level).toBe("low");
    const q = score(signals({ text: "Can you send the quote by Friday?" }));
    expect(q).toMatchObject({ level: "normal", reasons: ["asks you something", "due Friday"] });
  });

  test("urgent, due today, from someone you hear from often: high, with every reason", () => {
    const p = score(signals({ subject: "URGENT: contract", text: "Tony, I need the signed contract today.", priorFromSender: 6 }));
    expect(p.level).toBe("high");
    expect(p.reasons).toEqual(["asks you something", "names you", "says it's urgent", "due today", "someone you hear from often"]);
  });

  test("a reply to your mail asking to confirm by tomorrow, in a thread you've answered: high", () => {
    const p = score(signals({ text: "Thanks. Could you confirm by tomorrow?", repliesToOwner: true, threadRulings: { agreed: 1, skipped: 0 } }));
    expect(p.level).toBe("high");
    expect(p.reasons).toContain("answers your mail");
    expect(p.reasons).toContain("you've answered this thread before");
  });

  test("a thread you skipped counts against it", () => {
    const base = signals({ text: "Can you call me back?", priorFromSender: 1 });
    const skipped = score({ ...base, threadRulings: { agreed: 0, skipped: 2 } });
    expect(skipped.score).toBe(score(base).score - 2);
    expect(skipped.level).toBe("low");
  });
});

describe("quiet hours", () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 12, h + 4, m); // EDT = UTC-4, Monday local
  const local = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

  test("outside quiet hours: now", () => {
    expect(alertAt(at(10), ["21:00", "08:00"], NY)).toBe(at(10));
  });

  test("late evening waits for tomorrow morning; small hours wait for this morning", () => {
    expect(local(alertAt(at(22, 30), ["21:00", "08:00"], NY))).toBe("Tue 08:00");
    expect(local(alertAt(at(3), ["21:00", "08:00"], NY))).toBe("Mon 08:00");
  });

  test("a window that doesn't wrap midnight; none or malformed means never quiet", () => {
    expect(local(alertAt(at(13, 15), ["12:00", "14:00"], NY))).toBe("Mon 14:00");
    expect(alertAt(at(3), undefined, NY)).toBe(at(3));
    expect(alertAt(at(3), ["late", "08:00"], NY)).toBe(at(3));
  });
});

describe("the notices", () => {
  test("the alert says who, what, and why now; the draft push rings louder when high", () => {
    const msg = {
      fromAddress: "sam@acme.co", body: "Need the signed contract today.\n\nThanks", meta: { name: "Sam Lee", subject: "Contract", priority: { score: 7, level: "high", reasons: ["says it's urgent", "due today"] } },
    } as unknown as Doc<"messages">;
    const n = priorityNotice(msg, "https://x/surface");
    expect(n).toMatchObject({ title: "Priority: Contract", priority: 4, click: "https://x/surface" });
    expect(n.message).toContain("From Sam Lee <sam@acme.co>");
    expect(n.message).toContain("Why now: says it's urgent, due today");
    const links = { sign: "s", reject: "r", edit: "e" };
    expect(noticeFor({ toAddress: "a@b.c", body: "x", basis: [], priority: "high" }, links, "u").priority).toBe(4);
    expect(noticeFor({ toAddress: "a@b.c", body: "x", basis: [] }, links, "u").priority).toBeUndefined();
  });

  test("the digest line marks high", () => {
    expect(renderLine(1, { toAddress: "sam@acme.co", body: "On it.", basis: [], kind: "email", priority: "high" }, NY, MONDAY_10AM_NY)).toMatch(/^1 ‼ sam@acme\.co/);
  });
});

function mail(over: Partial<InboundMail> = {}): InboundMail {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`, inboxId: "tony-htr@agentmail.to", threadId: `thr_${Math.random()}`,
    fromAddress: "sam@acme.co", fromName: "Sam", to: ["tony-htr@agentmail.to"], subject: "Hello", text: "Just saying hi.", receivedAt: Date.now(), ...over,
  };
}

async function setup() {
  Object.assign(process.env, { HTR_RULING_SECRET: "test-secret", CONVEX_SITE_URL: "https://test.convex.site" });
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
  const alerts = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes("alertOwner")));
  return { t, tenant, alerts };
}

describe("intake", () => {
  test("high: scored on the message, an alert scheduled, an event with the reasons; the draft still follows", async () => {
    const { t, tenant, alerts } = await setup();
    const out = await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ subject: "URGENT", text: "Tony, can you sign the contract today?" }) });
    expect(out).toBe("drafting");
    const msg = (await t.run(async (ctx) => await ctx.db.query("messages").first()))!;
    expect(msg.meta.priority?.level).toBe("high");
    const scheduled = await alerts();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].scheduledTime).toBeGreaterThanOrEqual(msg._creationTime - 1000);
    const ev = await t.run(async (ctx) => (await ctx.db.query("events").collect()).find((e) => e.kind === "mail.priority"));
    expect(ev?.payload.reasons).toContain("says it's urgent");
  });

  test("normal and automated: no alert", async () => {
    const { t, tenant, alerts } = await setup();
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ text: "Can you send the quote by Friday?" }) });
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: "no-reply@github.com", subject: "URGENT security alert", text: "today" }) });
    expect(await alerts()).toHaveLength(0);
  });

  test("the thread counts: a reply in a thread the owner wrote in, after an agreed draft, from a known sender", async () => {
    const { t, tenant } = await setup();
    const first = mail({ threadId: "thr_x", text: "Do you have a bag under $200?" });
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: first });
    const m1 = (await t.run(async (ctx) => await ctx.db.query("messages").first()))!;
    await t.run(async (ctx) => {
      await ctx.db.insert("proposals", {
        tenantId: tenant._id, kind: "email", toAddress: "sam@acme.co", body: "Yes, the Harlow.", basis: [], summary: "", status: "sent",
        sourceKind: "email", sourceId: m1._id, edited: false, meta: { threadId: "thr_x" }, createdAt: Date.now(),
      });
      await ctx.db.insert("messages", { tenantId: tenant._id, channel: "email", direction: "out", fromAddress: "us", body: "Yes, the Harlow.", at: Date.now(), threadId: "thr_x", meta: {} });
    });
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ threadId: "thr_x", text: "Great, thanks." }) });
    const second = (await t.run(async (ctx) => await ctx.db.query("messages").collect())).find((m) => m.body === "Great, thanks.")!;
    expect(second.meta.priority?.reasons).toEqual(["answers your mail", "known sender", "you've answered this thread before"]);
    expect(second.meta.priority?.level).toBe("normal"); // no ask, no day: it waits for the digest
  });

  test("the draft carries the level and high leads the digest", async () => {
    const { t, tenant } = await setup();
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: "a@x.co", text: "Can you send the quote by Friday?" }) });
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: "b@x.co", subject: "URGENT", text: "Tony, can you sign today?" }) });
    const msgs = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    for (const m of msgs) await t.mutation(internal.drafter.record, { messageId: m._id, body: `reply to ${m.fromAddress}`, basis: [m.body] });
    const props = await t.run(async (ctx) => await ctx.db.query("proposals").collect());
    expect(Object.fromEntries(props.map((p) => [p.toAddress, p.priority]))).toEqual({ "a@x.co": "normal", "b@x.co": "high" });
    const built = await t.mutation(internal.digest.build, { tenantId: tenant._id });
    expect(built!.items.map((i) => i.item.toAddress)).toEqual(["b@x.co", "a@x.co"]);
    expect(built!.body).toMatch(/^1 ‼ /m);
  });
});

describe("Gmail tenants mail their digest", () => {
  test("hasMail: an AgentMail inbox or the owner's Gmail", () => {
    const base = { ...TENANTS[0], channels: {} } as unknown as Doc<"tenants">;
    expect(hasMail(base)).toBe(false);
    expect(hasMail({ ...base, channels: { inboxId: "x@agentmail.to" } })).toBe(true);
    expect(hasMail({ ...base, adapters: { mail: { kind: "gmail" } } })).toBe(true);
  });
});
