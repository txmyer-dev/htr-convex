// The whole loop, offline: an email arrives, a draft is proposed, the digest numbers it, the
// owner rules by reply, by link, and from the surface, and the dispatcher moves it along.
// convex-test runs the real mutations against an in-memory Convex; scheduled actions are
// visible as scheduled functions, never run (the network is off).

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { TENANTS } from "../convex/install";
import type { InboundMail } from "../convex/lib/mail/inbound";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const OWNER = TENANTS[0].owner.email;

function mail(over: Partial<InboundMail> = {}): InboundMail {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    inboxId: "tony-htr@agentmail.to",
    threadId: "thr_1",
    fromAddress: "marco@example.com",
    fromName: "Marco",
    to: ["tony-htr@agentmail.to"],
    subject: "Leather bag?",
    text: "Do you have a leather bag under $200? I need it by Friday.",
    receivedAt: Date.now(),
    ...over,
  };
}

async function setup() {
  process.env.HTR_RULING_SECRET = "test-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
  return { t, tenant };
}

describe("intake", () => {
  test("a person's email becomes a message, a contact, and a draft job; replays are harmless", async () => {
    const { t, tenant } = await setup();
    const m = mail();
    expect(await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: m })).toBe("drafting");
    expect(await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: m })).toBe("duplicate");
    const msgs = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(msgs).toHaveLength(1);
    expect(msgs[0].meta.name).toBe("Marco");
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts[0]).toMatchObject({ address: "marco@example.com", name: "Marco", count: 1 });
  });

  test("automated mail is recorded and never drafted", async () => {
    const { t, tenant } = await setup();
    const out = await t.mutation(internal.mail.receive, {
      tenantId: tenant._id,
      mail: mail({ fromAddress: "no-reply@github.com", subject: "[GitHub] Your weekly digest", text: "Unsubscribe here." }),
    });
    expect(out).toBe("automated");
    const msgs = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(msgs[0].meta.automated).toBe(true);
  });
});

describe("the loop", () => {
  let t: ReturnType<typeof convexTest>;
  let tenantId: Id<"tenants">;
  let msgId: Id<"messages">;

  beforeEach(async () => {
    const s = await setup();
    t = s.t;
    tenantId = s.tenant._id;
    await t.mutation(internal.mail.receive, { tenantId, mail: mail() });
    msgId = (await t.run((ctx) => ctx.db.query("messages").first()))!._id;
  });

  const draft = (body = "Yes, the Harlow, $185. Want it held?") =>
    t.mutation(internal.drafter.record, { messageId: msgId, body, basis: ["Do you have a leather bag under $200?"], toName: "Marco" });

  test("the drafter's record is idempotent and asks for a digest", async () => {
    const a = await draft();
    const b = await draft();
    expect(a).toBe(b);
    const p = (await t.run((ctx) => ctx.db.get(a)))!;
    expect(p).toMatchObject({ status: "pending", toName: "Marco", sourceKind: "email", sourceId: msgId, kind: "email" });
    expect(p.summary).toBe("Reply to Marco: “Yes, the Harlow, $185. Want it held?”");
    const tenant = (await t.run((ctx) => ctx.db.get(tenantId)))!;
    expect(tenant.digestScheduled).toBeDefined(); // immediate mode: one debounced digest
  });

  test("a newer message from the same person supersedes the older draft", async () => {
    const first = await draft();
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ text: "Actually, make that a wallet.", threadId: "thr_2" }) });
    const second = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    await t.mutation(internal.drafter.record, { messageId: second._id, body: "A wallet it is.", basis: [], toName: "Marco" });
    expect((await t.run((ctx) => ctx.db.get(first)))!.status).toBe("superseded");
  });

  test("the digest numbers what waits; a reply from the owner rules through that numbering", async () => {
    const pid = await draft();
    const built = (await t.mutation(internal.digest.build, { tenantId }))!;
    expect(built.items.map((i) => [i.n, i.proposalId])).toEqual([[1, pid]]);
    expect(built.body.split("\n")[0]).toBe("1 waiting on you.");
    expect(built.body).toContain('1 Marco (email): "Do you have a leather bag');

    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 yes\n\n> quoted digest below" });
    expect(out).toEqual({ confirmation: "Sending 1 to Marco.", ignored: false });
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p.status).toBe("signed");
    expect(p.ruledAt).toBeDefined();

    // ruling again does nothing; the number no longer resolves to a pending draft
    const again = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1" });
    expect(again.confirmation).toBe("1: nothing waiting under that number.");

    const rulings = await t.run((ctx) => ctx.db.query("rulings").collect());
    expect(rulings.map((r) => r.verdict)).toEqual(["sign", "ignored"]);
  });

  test("an edit sends the owner's words; a no skips; a stranger is ignored", async () => {
    const pid = await draft();
    await t.mutation(internal.digest.build, { tenantId });
    const stranger = await t.mutation(internal.rulings.fromEmail, { tenantId, from: "someone@else.com", text: "1" });
    expect(stranger).toEqual({ confirmation: null, ignored: true });
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("pending");

    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 Tell Marco Tuesday works" });
    expect(out.confirmation).toBe("Sending 1 to Marco with your words.");
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p).toMatchObject({ status: "signed", body: "Tell Marco Tuesday works", edited: true });
  });

  test("an edit is a lesson: the next draft for this tenant sees the draft and the owner's words", async () => {
    const pid = await draft();
    await t.mutation(internal.digest.build, { tenantId });
    await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 Yep, the Harlow is $185. Come by Friday, I'll have it out." });
    const r = (await t.run((ctx) => ctx.db.query("rulings").first()))!;
    expect(r).toMatchObject({ verdict: "edit", proposalId: pid, draftBody: "Yes, the Harlow, $185. Want it held?", editBody: "Yep, the Harlow is $185. Come by Friday, I'll have it out." });

    // a new message, from someone else: the drafter's context carries the correction
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: "sam@example.com", fromName: "Sam", threadId: "thr_3", text: "Any wallets under $100?" }) });
    const m2 = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    const c = (await t.query(internal.drafter.context, { messageId: m2._id }))!;
    expect(c.lessons).toEqual([{
      theirMessage: "Do you have a leather bag under $200?",
      draft: "Yes, the Harlow, $185. Want it held?",
      sent: "Yep, the Harlow is $185. Come by Friday, I'll have it out.",
    }]);

    // a plain sign is not a lesson
    await t.mutation(internal.drafter.record, { messageId: m2._id, body: "A few, from $60.", basis: [], toName: "Sam" });
    await t.mutation(internal.digest.build, { tenantId });
    await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1" });
    const again = (await t.query(internal.drafter.context, { messageId: m2._id }))!;
    expect(again.lessons).toHaveLength(1);
  });

  test("skip, help, later, hold, and the digest command", async () => {
    const pid = await draft();
    await t.mutation(internal.digest.build, { tenantId });
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "later" })).confirmation).toBe("Left 1 waiting for the next digest.");
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "hold until 9" })).confirmation).toContain("Holding the room until 9");
    expect((await t.run((ctx) => ctx.db.get(tenantId)))!.hold).toMatchObject({ until: "9" });
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "huh" })).confirmation).toContain("I read replies like");
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "?" })).confirmation).toBeNull(); // the digest is the reply
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 no" })).confirmation).toBe("Skipped 1 (Marco).");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("rejected");
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "?" })).confirmation).toBe("Nothing waiting on you.");
  });

  test("a stale digest cannot rule a newer proposal", async () => {
    const first = await draft();
    await t.mutation(internal.digest.build, { tenantId });
    await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 no" });
    // a second draft arrives; no new digest yet
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: "sam@example.com", fromName: "Sam", threadId: "thr_3", text: "Are you open Saturday?" }) });
    const m2 = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    const second = await t.mutation(internal.drafter.record, { messageId: m2._id, body: "We are, 10 to 4.", basis: [], toName: "Sam" });
    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1" });
    expect(out.confirmation).toBe("1: nothing waiting under that number."); // 1 still means `first`, which is ruled
    expect((await t.run((ctx) => ctx.db.get(second)))!.status).toBe("pending");
    expect((await t.run((ctx) => ctx.db.get(first)))!.status).toBe("rejected");
  });

  test("all signs everything in the last digest", async () => {
    await draft();
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: "sam@example.com", threadId: "thr_3", text: "Open Saturday?" }) });
    const m2 = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    await t.mutation(internal.drafter.record, { messageId: m2._id, body: "Yes.", basis: [] });
    await t.mutation(internal.digest.build, { tenantId });
    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "all" });
    expect(out.confirmation!.split("\n")).toHaveLength(2);
    const statuses = await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).map((p) => p.status));
    expect(statuses).toEqual(["signed", "signed"]);
  });

  test("a link rules once; the surface can edit; the dispatcher claims and finishes", async () => {
    const pid = await draft();
    expect(await t.mutation(internal.rulings.ruleByLink, { tenantId, proposalId: pid, verdict: "sign" })).toMatch(/^Sending/);
    expect(await t.mutation(internal.rulings.ruleByLink, { tenantId, proposalId: pid, verdict: "reject" })).toBe("Nothing waiting under that draft.");

    const claimed = await t.mutation(internal.proposals.claimForSend, { proposalId: pid });
    expect(claimed!.status).toBe("sending");
    expect(await t.mutation(internal.proposals.claimForSend, { proposalId: pid })).toBeNull(); // a double dispatch is a no-op
    await t.mutation(internal.proposals.finishSend, { proposalId: pid, error: "AgentMail 500" });
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("failed");
    const retried = await t.mutation(internal.proposals.claimForSend, { proposalId: pid }); // failed -> signed -> sending
    expect(retried!.status).toBe("sending");
    await t.mutation(internal.proposals.finishSend, { proposalId: pid, ref: "msg_out_1" });
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p).toMatchObject({ status: "sent", sentRef: "msg_out_1" });
    const out = await t.run((ctx) => ctx.db.query("messages").filter((q) => q.eq(q.field("direction"), "out")).collect());
    expect(out).toHaveLength(1);
    expect(out[0].toAddress).toBe("marco@example.com");
  });

  test("the surface key gates the public functions", async () => {
    const pid = await draft();
    const { api } = await import("../convex/_generated/api");
    const { surfaceKey } = await import("../convex/surface");
    const key = await surfaceKey("tony");
    await expect(t.query(api.proposals.list, { slug: "tony", key: "nope" })).rejects.toThrow(/bad surface key/);
    const rows = await t.query(api.proposals.list, { slug: "tony", key });
    expect(rows.map((r) => r.id)).toEqual([pid]);
    const note = await t.mutation(api.rulings.ruleFromSurface, { slug: "tony", key, proposalId: pid, verdict: "edit", body: "Held for you till Friday." });
    expect(note).toBe("Sending Reply to Marco: “Yes, the Harlow, $185. Want it held?” to Marco with your words.");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.body).toBe("Held for you till Friday.");
  });

  test("an overdue draft expires, notifies once, and is re-listed", async () => {
    const pid = await draft();
    await t.run(async (ctx) => await ctx.db.patch(pid, { deadline: Date.now() - 1000 }));
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(1);
    expect(await t.mutation(internal.rulings.expireAll, {})).toBe(0);
    const all = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(all.map((p) => p.status).sort()).toEqual(["expired", "pending"]);
    const relisted = all.find((p) => p.status === "pending")!;
    expect(relisted).toMatchObject({ sourceKind: "relist", sourceId: pid, body: "Yes, the Harlow, $185. Want it held?" });
    const notices = await t.run((ctx) => ctx.db.query("actions").filter((q) => q.eq(q.field("kind"), "send_mail")).collect());
    expect(notices).toHaveLength(1);
  });
});
