// The whole loop, offline: an email arrives, a draft is proposed, the digest numbers it, the
// owner rules by reply, by link, and from the surface, and the dispatcher moves it along.
// convex-test runs the real mutations against an in-memory Convex; scheduled actions are
// visible as scheduled functions, never run (the network is off).

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
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

  test("a gap the owner fills becomes a fact; the next draft sees it; remember teaches outside a draft", async () => {
    const pid = await t.mutation(internal.drafter.record, {
      messageId: msgId, body: "Tony will confirm Saturday's hours.", basis: ["Do you have a leather bag under $200?"], toName: "Marco", gap: "Saturday opening hours",
    });
    const built = (await t.mutation(internal.digest.build, { tenantId }))!;
    expect(built.body).toContain("· you haven't told me: Saturday opening hours");
    expect(built.items[0].item.gap).toBe("Saturday opening hours");

    // a plain sign teaches nothing
    const signed = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 no" });
    expect(signed.confirmation).toBe("Skipped 1 (Marco).");
    expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);

    // the same question again, answered in the owner's words: sent, and remembered
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ threadId: "thr_2", text: "Are you open Saturday?" }) });
    const m2 = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    const pid2 = await t.mutation(internal.drafter.record, { messageId: m2._id, body: "Tony will confirm.", basis: ["Are you open Saturday?"], toName: "Marco", gap: "Saturday opening hours" });
    await t.mutation(internal.digest.build, { tenantId });
    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1 Yes, Saturdays 9 to 2. Come by!" });
    expect(out.confirmation).toBe("Sending 1 to Marco with your words. Remembered: Saturday opening hours.");
    expect((await t.run((ctx) => ctx.db.get(pid2)))!).toMatchObject({ status: "signed", body: "Yes, Saturdays 9 to 2. Come by!" });
    const facts = await t.run((ctx) => ctx.db.query("facts").collect());
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ question: "Saturday opening hours", answer: "Yes, Saturdays 9 to 2. Come by!", proposalId: pid2 });
    expect(pid).not.toBe(pid2);

    // the next message, from anyone: the drafter has the fact in front of it
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: "sam@example.com", fromName: "Sam", threadId: "thr_3", text: "Saturday hours?" }) });
    const m3 = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
    const c = (await t.query(internal.drafter.context, { messageId: m3._id }))!;
    expect(c.facts.map((f) => [f.question, f.answer])).toEqual([["Saturday opening hours", "Yes, Saturdays 9 to 2. Come by!"]]);

    // a bare remember, and the same fact twice is one fact
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "remember parking is free after 6" })).confirmation).toBe("Remembered: parking is free after 6");
    expect((await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "remember parking is free after 6" })).confirmation).toBe("I already knew that.");
    expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(2);
    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events.filter((e) => e.kind === "fact.learned")).toHaveLength(2);
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
    expect(note).toBe("Sending the draft to Marco with your words.");
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

describe("from the room to the site", () => {
  const WEB = "web-felaniam@agentmail.to";

  test("a fact becomes a site request when the tenant has a web agent; the agent's reply is matched by thread; Firecrawl's re-read makes it live", async () => {
    const { t, tenant: installed } = await setup();
    const tenantId = installed._id;
    // no web agent: a fact stays in the room
    const { webAgent: _unused, ...business } = installed.business;
    await t.run(async (ctx) => { await ctx.db.patch(tenantId, { business }); });
    const tenant = (await t.run((ctx) => ctx.db.get(tenantId)))!;
    await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "remember dogs are welcome at the office" });
    const f1 = (await t.run((ctx) => ctx.db.query("facts").first()))!;
    await t.mutation(internal.facts.setStatement, { factId: f1._id, statement: "Dogs are welcome at the office." });
    expect(await t.mutation(internal.facts.proposeSite, { factId: f1._id })).toBeNull();

    // with one: the request is a proposal, numbered like any draft, ruled like any draft
    await t.run(async (ctx) => { await ctx.db.patch(tenantId, { business: { ...tenant.business, webAgent: WEB } }); });
    const pid = (await t.mutation(internal.facts.proposeSite, { factId: f1._id }))!;
    expect(await t.mutation(internal.facts.proposeSite, { factId: f1._id })).toBe(pid); // once per fact
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p).toMatchObject({ kind: "site", toAddress: WEB, toName: "your website", status: "pending", sourceKind: "fact", sourceId: f1._id, basis: ["Dogs are welcome at the office."] });
    expect(p.body).toContain("Please add this to felaniam.cloud");
    expect(p.summary).toMatch(/^Website update: /);
    expect(p.meta.subject).toBe("Update felaniam.cloud: Dogs are welcome at the office.");
    const built = (await t.mutation(internal.digest.build, { tenantId }))!;
    expect(built.body).toContain("1 your website (site):");
    const out = await t.mutation(internal.rulings.fromEmail, { tenantId, from: OWNER, text: "1" });
    expect(out.confirmation).toBe("Sending 1 to your website.");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("signed");

    // the dispatcher's two ends, without the network: claimed, then sent in a new thread
    await t.mutation(internal.proposals.claimForSend, { proposalId: pid });
    await t.mutation(internal.proposals.finishSend, { proposalId: pid, ref: "am_msg_1", threadId: "thr_site_1" });
    expect((await t.run((ctx) => ctx.db.get(pid)))!).toMatchObject({ status: "sent", meta: { threadId: "thr_site_1" } });

    // a reply from the web agent in another thread matches nothing; in the thread, it is acknowledged and never drafted
    const stray = await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_other", subject: "hi", text: "hello?" }) });
    expect(stray).toBe("site");
    const ack = await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_site_1", subject: "Re: Update felaniam.cloud", text: "Live at https://felaniam.cloud/#visit" }) });
    expect(ack).toBe("site");
    const kinds = (await t.run((ctx) => ctx.db.query("events").collect())).map((e) => e.kind);
    expect(kinds).toContain("site.unmatched");
    expect(kinds).toContain("site.acknowledged");
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(1); // nothing drafted for the agent's mail
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => String(s.name).includes("verifySite"))).toBe(true);

    // the site does not say it yet: not live; then it does
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("sent");
    await t.mutation(internal.knowledge.store, { tenantId, pages: [{ url: "https://felaniam.cloud/", markdown: "Visiting us: dogs are welcome at the office." }] });
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid })).toBe("https://felaniam.cloud/");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("live");
    expect((await t.run((ctx) => ctx.db.get(f1._id)))!.onSite).toMatchObject({ url: "https://felaniam.cloud/" });
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid })).toBeNull(); // once
  });
});

test("a site request the agent could not carry out can be asked again; an email cannot", async () => {
  const { t, tenant } = await setup();
  await t.run(async (ctx) => { await ctx.db.patch(tenant._id, { business: { ...tenant.business, webAgent: "web@agentmail.to" } }); });
  await t.mutation(internal.rulings.fromEmail, { tenantId: tenant._id, from: OWNER, text: "remember parking is free after 6" });
  const f = (await t.run((ctx) => ctx.db.query("facts").first()))!;
  const pid = (await t.mutation(internal.facts.proposeSite, { factId: f._id }))!;
  expect(await t.mutation(internal.proposals.resend, { proposalId: pid })).toBe("not sent (pending)");
  await t.mutation(internal.digest.build, { tenantId: tenant._id });
  await t.mutation(internal.rulings.fromEmail, { tenantId: tenant._id, from: OWNER, text: "all" });
  await t.mutation(internal.proposals.claimForSend, { proposalId: pid });
  await t.mutation(internal.proposals.finishSend, { proposalId: pid, ref: "m1", threadId: "thr_1" });
  expect(await t.mutation(internal.proposals.resend, { proposalId: pid })).toBe("resent");
  const p = (await t.run((ctx) => ctx.db.get(pid)))!;
  expect(p.status).toBe("signed");
  expect(p.meta.threadId).toBeUndefined();
  await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail() });
  const m = (await t.run((ctx) => ctx.db.query("messages").order("desc").first()))!;
  const email = await t.mutation(internal.drafter.record, { messageId: m._id, body: "Hi.", basis: [], toName: "Marco" });
  expect(await t.mutation(internal.proposals.resend, { proposalId: email })).toBe("not a site request");
});

describe("when the site request does not go live", () => {
  const WEB = "web-felaniam@agentmail.to";

  /** A site request for the fact in `words`, signed and sent in thread `thr`. */
  async function sentRequest(words: string, thr: string) {
    const { t, tenant } = await setup();
    await t.run(async (ctx) => { await ctx.db.patch(tenant._id, { business: { ...tenant.business, webAgent: WEB } }); });
    await t.mutation(internal.rulings.fromEmail, { tenantId: tenant._id, from: OWNER, text: `remember ${words}` });
    const f = (await t.run((ctx) => ctx.db.query("facts").first()))!;
    const pid = (await t.mutation(internal.facts.proposeSite, { factId: f._id }))!;
    await t.mutation(internal.digest.build, { tenantId: tenant._id });
    await t.mutation(internal.rulings.fromEmail, { tenantId: tenant._id, from: OWNER, text: "1" });
    await t.mutation(internal.proposals.claimForSend, { proposalId: pid });
    await t.mutation(internal.proposals.finishSend, { proposalId: pid, ref: "m1", threadId: thr });
    const { surfaceKey } = await import("../convex/surface");
    const key = await surfaceKey(tenant.slug);
    return { t, tenant, pid, key };
  }
  type T = Awaited<ReturnType<typeof setup>>["t"];
  const events = (t: T) => t.run((ctx) => ctx.db.query("events").collect()).then((es) => es.map((e) => e.kind));
  const scheduledNames = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()).then((ss) => ss.map((s) => String(s.name)));

  test("the agent says Not live: the request fails with the agent's reason, nothing is verified, and the surface can ask again", async () => {
    const { t, tenant, pid, key } = await sentRequest("dogs are welcome at the office", "thr_no");
    const before = (await scheduledNames(t)).filter((n) => n.includes("verifySite")).length;
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_no", subject: "Re: Update", text: "Not live. I couldn't place this on the page safely: find is not unique: <p>. Nothing was changed.\n\n-- Felaniam web agent" }) });
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p.status).toBe("failed");
    expect(p.meta.siteFailure).toBe("agent");
    expect(p.error).toBe("Your website's agent couldn't place it: I couldn't place this on the page safely: find is not unique: <p>.");
    expect(await events(t)).toContain("site.failed");
    expect((await scheduledNames(t)).filter((n) => n.includes("verifySite")).length).toBe(before); // the site is not read for a request the agent refused
    const row = (await t.query(api.proposals.list, { slug: tenant.slug, key })).find((r) => r.id === pid)!;
    expect(row).toMatchObject({ status: "failed", siteFailure: "agent" });

    // the surface asks again: signed, a new thread, dispatched
    expect(await t.mutation(api.facts.retrySite, { slug: tenant.slug, key, proposalId: pid })).toBe("Asking your website again.");
    const again = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(again.status).toBe("signed");
    expect(again.error).toBeUndefined();
    expect(again.meta.threadId).toBeUndefined();
    expect(again.meta.siteFailure).toBeUndefined();
    expect((await scheduledNames(t)).some((n) => n.includes("dispatch"))).toBe(true);
    expect(await t.mutation(api.facts.retrySite, { slug: tenant.slug, key, proposalId: pid })).toBe("Nothing to retry."); // once
    await expect(t.mutation(api.facts.retrySite, { slug: tenant.slug, key: "nope", proposalId: pid })).rejects.toThrow(/bad surface key/);
  });

  test("the agent says Live but the site never shows it: failed after the last read, and the surface can read the site again", async () => {
    const { t, tenant, pid, key } = await sentRequest("parking is free after 6", "thr_yes");
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_yes", subject: "Re: Update", text: "Live. Added under Practical.\n\nhttps://felaniam.cloud" }) });
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("sent");
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid })).toBeNull(); // an early miss: still sent
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("sent");
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid, last: true })).toBeNull(); // the last miss: failed, and the surface says why
    const p = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(p.status).toBe("failed");
    expect(p.meta.siteFailure).toBe("unseen");
    expect(p.error).toMatch(/said it was live, but 3 reads/);
    expect(await events(t)).toContain("site.unseen");

    // the surface reads again, without asking the agent to edit twice: back to sent, verify scheduled, thread kept
    expect(await t.mutation(api.facts.retrySite, { slug: tenant.slug, key, proposalId: pid })).toBe("Reading your site again.");
    const again = (await t.run((ctx) => ctx.db.get(pid)))!;
    expect(again.status).toBe("sent");
    expect(again.error).toBeUndefined();
    expect(again.meta.threadId).toBe("thr_yes");
    expect(again.meta.siteFailure).toBeUndefined();
    expect((await scheduledNames(t)).some((n) => n.includes("verifySite"))).toBe(true);
    // and when the site says it, live as before
    await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://felaniam.cloud/visit", markdown: "Practical: parking is free after 6." }] });
    expect(await t.mutation(internal.facts.markLive, { proposalId: pid, last: true })).toBe("https://felaniam.cloud/visit");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("live");
  });

  test("the surface tells the request's story: every step, from the draft to the page, and nothing to a wrong key", async () => {
    const { t, tenant, pid, key } = await sentRequest("the kettle is always on", "thr_story");
    const story = () => t.query(api.proposals.timeline, { slug: tenant.slug, key, proposalId: pid });
    expect((await story()).at(-1)).toEqual({ text: "Waiting for the agent's reply", tone: "wait" });

    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_story", subject: "Re: Update", text: "Live. Added to the visit section.\n\n-- Felaniam web agent" }) });
    await t.mutation(internal.facts.markLive, { proposalId: pid });
    expect((await story()).at(-1)).toEqual({ text: "Reading the site again shortly", tone: "wait" });
    await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://felaniam.cloud/visit", markdown: "Visit: the kettle is always on." }] });
    await t.mutation(internal.facts.markLive, { proposalId: pid });

    const steps = await story();
    expect(steps.map((s) => s.text)).toEqual([
      "Request drafted for your website's agent, from what you taught it",
      "Signed by you, by email reply",
      "Sent to your website's agent, signed, with you copied",
      "The agent replied: “Live. Added to the visit section.”",
      "Read the site (0 pages): not there yet",
      "Read the site: it's there (https://felaniam.cloud/visit). Live.",
    ]);
    // the request is named on the event itself, not only inside its payload
    const named = await t.run((ctx) => ctx.db.query("events").withIndex("by_proposal_at", (q) => q.eq("proposalId", pid)).collect());
    expect(named.map((e) => e.kind)).toContain("site.live");
    await expect(t.query(api.proposals.timeline, { slug: tenant.slug, key: "nope", proposalId: pid })).rejects.toThrow(/bad surface key/);
  });

  test("events written before the request was named on them are backfilled from their payload", async () => {
    const { t, tenant, pid } = await sentRequest("the door code is 4412", "thr_old");
    await t.run(async (ctx) => {
      for (const e of await ctx.db.query("events").collect()) await ctx.db.patch(e._id, { proposalId: undefined });
    });
    const patched = await t.mutation(internal.events.backfillProposalIds, { paginationOpts: { numItems: 500, cursor: null } });
    expect(patched).toBeGreaterThanOrEqual(3); // created, proposed, sent
    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events.filter((e) => e.proposalId === pid).map((e) => e.kind)).toEqual(expect.arrayContaining(["proposal.created", "site.proposed", "proposal.sent"]));
    expect(events.find((e) => e.kind === "mail.received" || e.kind === "digest.built")?.proposalId).toBeUndefined();
    expect(tenant).toBeTruthy();
  });

  test("the command line can resend a failed request too", async () => {
    const { t, tenant, pid } = await sentRequest("we close at 2 on saturdays", "thr_cli");
    await t.mutation(internal.mail.receive, { tenantId: tenant._id, mail: mail({ fromAddress: WEB, fromName: "Web", threadId: "thr_cli", subject: "Re: Update", text: "Not live. I couldn't place this on the page safely: no edits. Nothing was changed." }) });
    expect(await t.mutation(internal.proposals.resend, { proposalId: pid })).toBe("resent");
    expect((await t.run((ctx) => ctx.db.get(pid)))!.status).toBe("signed");
  });
});
