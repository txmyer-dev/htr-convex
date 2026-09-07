// The front door, offline: leases on a pool of inboxes, the pretend customer, the sweep.
// AgentMail is never called here; the pool rows are inserted as the provisioning step would.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { KEEP_MS, LEASE_MS, normalizeSite } from "../convex/demo";
import type { InboundMail } from "../convex/lib/mail/inbound";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

async function setup(inboxes = 1) {
  process.env.HTR_RULING_SECRET = "test-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  const t = convexTest(schema, modules);
  for (let i = 1; i <= inboxes; i++) {
    await t.mutation(internal.demo.register, { inboxId: `room-${i}@agentmail.to`, address: `room-${i}@agentmail.to`, webhookId: `wh_${i}`, webhookSecret: `whsec_${i}` });
  }
  return t;
}

const owner = (n = 1) => ({ slug: `demo-${n}`, ownerName: "Sam", ownerEmail: `sam${n}@example.com`, businessName: "Sam's Bakery", timeZone: "America/New_York" });

describe("the lease", () => {
  test("a lease makes a tenant on a pool inbox; the inbox knows who holds it", async () => {
    const t = await setup();
    const out = await t.mutation(internal.demo.lease, { ...owner(), site: "https://sams-bakery.com" });
    expect(out.inbox).toBe("room-1@agentmail.to");
    const tenant = (await t.run((ctx) => ctx.db.get(out.tenantId)))!;
    expect(tenant).toMatchObject({
      slug: "demo-1", displayName: "Sam's Bakery",
      owner: { email: "sam1@example.com", digestAt: "immediate" },
      business: { site: "https://sams-bakery.com", agentName: "Hold the Room" },
      channels: { inboxId: "room-1@agentmail.to", inboxAddress: "room-1@agentmail.to", webhookId: "wh_1" },
    });
    expect(tenant.demo!.expiresAt - tenant.demo!.startedAt).toBe(LEASE_MS);
    const row = (await t.query(internal.demo.inboxByAddress, { inboxId: "room-1@agentmail.to" }))!;
    expect(row.tenantId).toBe(out.tenantId);
    expect(row.webhookSecret).toBe("whsec_1");
    expect(await t.query(internal.demo.poolState, {})).toMatchObject({ total: 1, free: 0 });
  });

  test("a held inbox is not leased twice; an expired lease is taken over and the old demo ended", async () => {
    const t = await setup();
    const first = await t.mutation(internal.demo.lease, owner(1));
    await expect(t.mutation(internal.demo.lease, owner(2))).rejects.toThrow(/busy/);

    // time passes: the lease runs out
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("demoInboxes").first())!;
      await ctx.db.patch(row._id, { leasedUntil: Date.now() - 1 });
    });
    const second = await t.mutation(internal.demo.lease, owner(2));
    expect(second.inbox).toBe("room-1@agentmail.to");
    const old = (await t.run((ctx) => ctx.db.get(first.tenantId)))!;
    expect(old.channels).toEqual({});
    expect(old.demo!.endedAt).toBeDefined();
    const row = (await t.query(internal.demo.inboxByAddress, { inboxId: "room-1@agentmail.to" }))!;
    expect(row.tenantId).toBe(second.tenantId);
  });

  test("the sweep releases what ran out and forgets what ended a day ago", async () => {
    const t = await setup(2);
    const a = await t.mutation(internal.demo.lease, owner(1));
    const b = await t.mutation(internal.demo.lease, owner(2));
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("demoInboxes").collect();
      await ctx.db.patch(rows[0]._id, { leasedUntil: Date.now() - 1 }); // a: expired, not yet released
      // b: ended long ago, still holding rows
      const tb = (await ctx.db.get(b.tenantId))!;
      await ctx.db.patch(b.tenantId, { channels: {}, demo: { ...tb.demo!, endedAt: Date.now() - KEEP_MS - 1 } });
      await ctx.db.patch(rows[1]._id, { tenantId: undefined, leasedUntil: undefined });
      await ctx.db.insert("messages", {
        tenantId: b.tenantId, channel: "email", direction: "in", fromAddress: "x@y.com", body: "hi", at: Date.now(), meta: {},
      });
    });
    expect(await t.mutation(internal.demo.sweep, {})).toEqual({ released: 1, purged: 1 });
    const ta = (await t.run((ctx) => ctx.db.get(a.tenantId)))!;
    expect(ta.demo!.endedAt).toBeDefined();
    expect(await t.run((ctx) => ctx.db.get(b.tenantId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    expect(await t.query(internal.demo.poolState, {})).toMatchObject({ total: 2, free: 2 });
  });

  test("a site is normalised or refused", () => {
    expect(normalizeSite("sams-bakery.com")).toBe("https://sams-bakery.com");
    expect(normalizeSite(" https://Sams-Bakery.com/ ")).toBe("https://sams-bakery.com");
    expect(normalizeSite("")).toBeUndefined();
    expect(normalizeSite("bakery")).toBeUndefined();
  });
});

describe("the pretend customer", () => {
  function mail(over: Partial<InboundMail> = {}): InboundMail {
    return {
      id: `msg_${Math.random().toString(36).slice(2)}`, inboxId: "room-1@agentmail.to", threadId: "thr_1",
      fromAddress: "tony-htr@agentmail.to", to: ["room-1@agentmail.to"], subject: "Saturday?",
      text: "Are you open Saturday?", receivedAt: Date.now(), ...over,
    };
  }

  test("client zero's inbox writing to a demo is a customer, named by the header, despite AgentMail's bulk headers and footer", async () => {
    const t = await setup();
    const { tenantId } = await t.mutation(internal.demo.lease, owner());
    const out = await t.mutation(internal.mail.receive, {
      tenantId,
      mail: mail({
        text: "Are you open Saturday?\n\n--\nSent via AgentMail",
        headers: { "x-htr-customer": "Sam Lee", "list-unsubscribe": "<https://api.agentmail.to/v0/unsubscribe/x>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" },
      }),
    });
    expect(out).toBe("drafting");
    const msg = (await t.run((ctx) => ctx.db.query("messages").first()))!;
    expect(msg.meta.name).toBe("Sam Lee");
    expect(msg.meta.automated).toBe(false);
    expect(msg.body).toBe("Are you open Saturday?");
    const contact = (await t.run((ctx) => ctx.db.query("contacts").first()))!;
    expect(contact).toMatchObject({ address: "tony-htr@agentmail.to", name: "Sam Lee" });
  });

  test("the header is not honoured from a stranger's domain", async () => {
    const t = await setup();
    const { tenantId } = await t.mutation(internal.demo.lease, owner());
    await t.mutation(internal.mail.receive, { tenantId, mail: mail({ fromAddress: "x@evil.example", fromName: "X", headers: { "x-htr-customer": "The Owner" } }) });
    expect((await t.run((ctx) => ctx.db.query("messages").first()))!.meta.name).toBe("X");
  });

  test("the signed reply lands in client zero's room and is never drafted there", async () => {
    const t = await setup();
    await t.mutation(internal.install.applyInternal, {});
    const zero = (await t.run((ctx) => ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", "tony")).unique()))!;
    await t.mutation(internal.demo.lease, owner());
    const echo = await t.mutation(internal.mail.receive, {
      tenantId: zero._id,
      mail: mail({ fromAddress: "room-1@agentmail.to", to: ["tony-htr@agentmail.to"], inboxId: "tony-htr@agentmail.to", text: "Yes, 8 to 2." }),
    });
    expect(echo).toBe("echo");
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("proposals").collect())).toHaveLength(0);
    expect(await t.query(internal.demo.customerInbox, {})).toBeNull(); // client zero has no inbox in the install file
  });

  test("a demo that ended cannot rule from the surface", async () => {
    const t = await setup();
    const { tenantId } = await t.mutation(internal.demo.lease, owner());
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("demoInboxes").first())!;
      await ctx.db.patch(row._id, { leasedUntil: Date.now() - 1 });
    });
    await t.mutation(internal.demo.sweep, {});
    const tenant = (await t.run((ctx) => ctx.db.get(tenantId as Id<"tenants">)))!;
    expect(tenant.channels.inboxId).toBeUndefined();
  });
});
