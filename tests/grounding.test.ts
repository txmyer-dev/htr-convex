// What a draft rested on is kept with it: the surface and the digest say where the words came from.

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import { digestEmail } from "../convex/digest";
import { TENANTS } from "../convex/install";
import { trimNotes, trimProfile, userPayload, withHomepage } from "../convex/drafter";
import { describeGrounding } from "../convex/lib/knowledge/domain";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

test("grounding rides from the drafter's record to the proposal, the surface, and the digest", async () => {
  process.env.HTR_RULING_SECRET = "test-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run((ctx) => ctx.db.query("tenants").first()))!;
  await t.mutation(internal.mail.receive, {
    tenantId: tenant._id,
    mail: {
      id: "msg_1", inboxId: "x", threadId: "thr_1", fromAddress: "sam@acme.com", fromName: "Sam", to: ["x"],
      subject: "Hours?", text: "Are you open Saturday?", receivedAt: Date.now(),
    },
  });
  const msg = (await t.run((ctx) => ctx.db.query("messages").first()))!;
  const grounding = {
    site: [{ url: "https://felaniam.cloud/", title: "Felaniam", fetchedAt: 1 }],
    sender: { url: "https://acme.com/", title: "Acme", fetchedAt: 2 },
  };
  const pid = await t.mutation(internal.drafter.record, { messageId: msg._id, body: "Yes, 8 to 2.", basis: ["Are you open Saturday?"], toName: "Sam", grounding });
  expect((await t.run((ctx) => ctx.db.get(pid)))!.grounding).toEqual(grounding);

  const built = (await t.mutation(internal.digest.build, { tenantId: tenant._id }))!;
  expect(built.items[0].grounding).toEqual(grounding);
  const email = await digestEmail(tenant, built);
  expect(email.html).toContain("Drafted from your site (felaniam.cloud) and who they are (acme.com).");

  const view = await t.query(internal.views.proposals, { slug: TENANTS[0].slug });
  expect(view[0].grounding).toEqual(grounding);
});

test("the sender's page reaches the prompt, trimmed; nothing when there is none", () => {
  const notes = trimProfile({ url: "https://acme.com/", title: "Acme", markdown: "x".repeat(5000), fetchedAt: 1 }, 100);
  expect(notes).toHaveLength(100);
  expect(notes!.startsWith("# Acme\n")).toBe(true);
  expect(trimProfile(null)).toBeUndefined();
  const payload = JSON.parse(userPayload({
    businessName: "B", ownerName: "O", counterparty: "C", channel: "email", theirMessage: "m", prior: [], senderNotes: notes,
  }));
  expect(payload.sender_notes).toBe(notes);
  expect(payload.business_notes).toBeNull();
});

test("a full read of the site replaces what it used to say; extra pages are additions; the drafter reads front first", async () => {
  process.env.HTR_RULING_SECRET = "test-secret";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run((ctx) => ctx.db.query("tenants").first()))!;
  const urls = async () => (await t.run((ctx) => ctx.db.query("knowledge").collect())).map((k) => k.url).sort();
  await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://s.example/", markdown: "home" }, { url: "https://s.example/old", markdown: "old" }], replace: true });
  expect(await urls()).toEqual(["https://s.example/", "https://s.example/old"]);
  await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://s.example/", markdown: "home v2" }, { url: "https://s.example/new", markdown: "new" }], replace: true });
  expect(await urls()).toEqual(["https://s.example/", "https://s.example/new"]);
  await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://elsewhere.example/pricing", markdown: "prices" }] });
  expect(await urls()).toEqual(["https://elsewhere.example/pricing", "https://s.example/", "https://s.example/new"]);

  const pages = [
    { url: "https://s.example/", title: "Home", markdown: "h".repeat(100) },
    { url: "https://s.example/new", markdown: "n".repeat(100) },
    { url: "https://s.example/never", markdown: "z".repeat(100) },
  ];
  const { text: notes, used } = trimNotes(pages, 200, 60)!;
  expect(used.map((p) => p.url)).toEqual(["https://s.example/", "https://s.example/new"]);
  expect(notes.startsWith("# Home (https://s.example/)\n" + "h".repeat(60))).toBe(true);
  expect(notes).toContain("# https://s.example/new (https://s.example/new)\n" + "n".repeat(60));
  expect(notes.length).toBeLessThanOrEqual(200);
});

test("the pages they sent ride along as their_links and are named on the card", () => {
  const p = JSON.parse(userPayload({
    businessName: "B", ownerName: "T", counterparty: "Sam", channel: "email", theirMessage: "quote this? https://shop.example/bag", prior: [],
    linkNotes: [{ url: "https://shop.example/bag", title: "Bag", text: "A leather bag, $185." }],
  }));
  expect(p.their_links).toEqual([{ url: "https://shop.example/bag", title: "Bag", text: "A leather bag, $185." }]);
  expect(describeGrounding({ site: [{ url: "https://felaniam.cloud/", fetchedAt: 1 }], links: [{ url: "https://shop.example/bag", fetchedAt: 2 }] }))
    .toBe("Drafted from your site (felaniam.cloud) and the page they sent (shop.example).");
  expect(describeGrounding({ links: [{ url: "https://a.example/", fetchedAt: 2 }, { url: "https://b.example/", fetchedAt: 3 }], facts: [{ at: 1 }] }))
    .toBe("Drafted from the 2 pages they sent and one thing you told me.");
});

test("the site in pieces: chunks replace the tenant's old ones as one transaction, and the homepage leads the pick", async () => {
  process.env.HTR_RULING_SECRET = "test-secret";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run((ctx) => ctx.db.query("tenants").first()))!;
  const vec = (n: number) => Array.from({ length: 1536 }, () => n);
  expect(await t.query(internal.knowledge.hasChunks, { tenantId: tenant._id })).toBe(false);
  await t.mutation(internal.knowledge.replaceChunks, { tenantId: tenant._id, chunks: [
    { url: "https://s.example/", text: "The Shop.", embedding: vec(1), fetchedAt: 1 },
    { url: "https://s.example/hours", text: "Sat 10 to 4.", embedding: vec(2), fetchedAt: 1 },
  ] });
  expect(await t.query(internal.knowledge.hasChunks, { tenantId: tenant._id })).toBe(true);
  const n = await t.mutation(internal.knowledge.replaceChunks, { tenantId: tenant._id, chunks: [{ url: "https://s.example/pricing", text: "Scale $599.", embedding: vec(3), fetchedAt: 2 }] });
  expect(n).toBe(1);
  const rows = await t.run((ctx) => ctx.db.query("chunks").collect());
  expect(rows.map((r) => r.url)).toEqual(["https://s.example/pricing"]);
  expect(await t.query(internal.knowledge.chunksByIds, { ids: rows.map((r) => r._id) })).toEqual([{ url: "https://s.example/pricing", title: undefined, text: "Scale $599." }]);

  // storing pages schedules the embedding job
  await t.mutation(internal.knowledge.store, { tenantId: tenant._id, pages: [{ url: "https://s.example/", markdown: "The Shop." }], replace: true });
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(scheduled.some((s) => String(s.name).includes("embedTenant"))).toBe(true);

  const pages = [{ url: "https://s.example/", title: "Shop", markdown: "The Shop, since 1990. ".repeat(50) }, { url: "https://s.example/pricing", markdown: "x" }];
  const led = withHomepage([{ url: "https://s.example/pricing", text: "Scale $599." }], pages);
  expect(led.map((c) => c.url)).toEqual(["https://s.example/", "https://s.example/pricing"]);
  expect(led[0].text.length).toBeLessThanOrEqual(700);
  expect(withHomepage([{ url: "https://s.example/", text: "home" }], pages)).toHaveLength(1);
});
