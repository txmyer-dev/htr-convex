// The front door. Anyone can try the loop as the owner: name, email, business, site. They get
// an inbox address and the live surface; the first email to the address becomes a draft on the
// page in seconds, a digest in their own inbox a minute later, and their reply rules it.
//
// A demo leases an inbox from a small pool instead of making its own, so concurrent trials are
// bounded by HTR_DEMO_POOL rather than by whatever AgentMail plan is behind the key. The pool
// grows on demand up to HTR_DEMO_POOL (or is pre-warmed with `demo:warm`), and every inbox in it
// has one webhook, pointed at /webhooks/pool/mail, whose secret lives with the inbox: the route
// finds the inbox in the event, then the tenant holding its lease. A lease lasts thirty minutes; the
// hourly sweep releases what has expired and, a day later, forgets the demo's rows entirely.
//
// The pretend customer is another inbox of ours writing to the demo's, signed with a header
// carrying the customer's name; mail.receive knows the shape. A real email from any other
// address works the same and is the better demo.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { appendEvent } from "./events";
import { client, CUSTOMER_HEADER } from "./mail";
import { liveSurfaceUrl, requireSurface, siteUrl, surfaceKey } from "./surface";

export const LEASE_MS = 30 * 60_000; // a judge's try takes ten; End frees it sooner
export const KEEP_MS = 24 * 3_600_000; // after a lease ends, the rows stay this long
export const POOL_ROUTE = "/webhooks/pool/mail";
const POOL_MAX = 50; // the table is never larger than the pool; this bounds the reads

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function poolCap(): number {
  const n = Number(process.env.HTR_DEMO_POOL ?? 2);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

/** "acme.com" -> "https://acme.com"; anything unparseable -> undefined. */
export function normalizeSite(raw: string | undefined): string | undefined {
  let s = (raw ?? "").trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return undefined;
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

const isFree = (r: Doc<"demoInboxes">, now: number) => !r.tenantId || (r.leasedUntil ?? 0) < now;

// ---- reads ----------------------------------------------------------------------------------

export const poolState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("demoInboxes").take(POOL_MAX);
    const now = Date.now();
    const busy = rows.filter((r) => !isFree(r, now)).map((r) => r.leasedUntil!).sort((a, b) => a - b);
    return { total: rows.length, free: rows.length - busy.length, nextFree: busy[0] ?? null };
  },
});

/** The webhook route's lookup: the inbox an event names, its secret, and who holds it. */
export const inboxByAddress = internalQuery({
  args: { inboxId: v.string() },
  handler: async (ctx, { inboxId }) => await ctx.db.query("demoInboxes").withIndex("by_inbox", (q) => q.eq("inboxId", inboxId)).unique(),
});

// ---- the lease --------------------------------------------------------------------------------

export const register = internalMutation({
  args: { inboxId: v.string(), address: v.string(), webhookId: v.string(), webhookSecret: v.string() },
  handler: async (ctx, a) => await ctx.db.insert("demoInboxes", a),
});

/** The demo is over: the tenant keeps its rows for a day but can no longer send or receive. */
async function endLease(ctx: MutationCtx, tenant: Doc<"tenants">, now: number) {
  if (tenant.demo?.endedAt) return;
  if (tenant.digestScheduled) {
    const job = await ctx.db.system.get(tenant.digestScheduled);
    if (job && job.state.kind === "pending") await ctx.scheduler.cancel(tenant.digestScheduled);
  }
  await ctx.db.patch(tenant._id, {
    channels: {},
    digestScheduled: undefined,
    demo: { startedAt: tenant.demo?.startedAt ?? now, expiresAt: tenant.demo?.expiresAt ?? now, endedAt: now },
  });
  await appendEvent(ctx, tenant._id, "demo.ended", {});
}

export const lease = internalMutation({
  args: {
    slug: v.string(),
    ownerName: v.string(),
    ownerEmail: v.string(),
    businessName: v.string(),
    site: v.optional(v.string()),
    timeZone: v.string(),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    const rows = await ctx.db.query("demoInboxes").take(POOL_MAX);
    const row = rows.find((r) => isFree(r, now));
    if (!row) throw new Error("busy");
    if (row.tenantId) {
      const prev = await ctx.db.get(row.tenantId);
      if (prev) await endLease(ctx, prev, now);
    }
    const tenantId = await ctx.db.insert("tenants", {
      slug: a.slug,
      displayName: a.businessName,
      timeZone: a.timeZone,
      owner: {
        name: a.ownerName, names: [a.ownerName], email: a.ownerEmail.toLowerCase(),
        digestAt: "immediate", defaultDeadlineDays: 2, discloseAssistant: true, autonomyTier: 0,
      },
      business: { site: a.site, agentName: "Hold the Room" },
      channels: { inboxId: row.inboxId, inboxAddress: row.address, webhookId: row.webhookId },
      demo: { startedAt: now, expiresAt: now + LEASE_MS },
    });
    await ctx.db.patch(row._id, { tenantId, leasedUntil: now + LEASE_MS });
    await appendEvent(ctx, tenantId, "demo.started", { inbox: row.address, site: a.site ?? null });
    return { tenantId, inbox: row.address, expiresAt: now + LEASE_MS };
  },
});

export type Started =
  | { ok: true; slug: string; key: string; inbox: string; url: string; expiresAt: number }
  | { ok: false; busy: true; nextFree: number | null }
  | { ok: false; busy?: undefined; error: string };

/** The form on the front door. Public: anyone may try it, one inbox at a time each. */
export const start = action({
  args: {
    ownerName: v.string(),
    ownerEmail: v.string(),
    businessName: v.string(),
    site: v.optional(v.string()),
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Started> => {
    const ownerName = a.ownerName.trim().slice(0, 60);
    const ownerEmail = a.ownerEmail.trim().toLowerCase();
    const businessName = a.businessName.trim().slice(0, 80);
    if (!ownerName || !businessName) return { ok: false, error: "A name and a business name, please." };
    if (!EMAIL.test(ownerEmail)) return { ok: false, error: "That email address does not look right." };
    const site = normalizeSite(a.site);
    if (a.site?.trim() && !site) return { ok: false, error: "That website address does not look right." };
    const timeZone = a.timeZone && isTimeZone(a.timeZone) ? a.timeZone : "America/New_York";

    const state = await ctx.runQuery(internal.demo.poolState, {});
    if (state.free === 0) {
      if (state.total >= poolCap()) return { ok: false, busy: true, nextFree: state.nextFree };
      try {
        const c = client();
        const inbox = await c.createInbox({ username: `room-${state.total + 1}-${token(4)}`, displayName: "Hold the Room" });
        const hook = await c.createWebhook({ url: `${siteUrl()}${POOL_ROUTE}`, eventTypes: ["message.received"], inboxIds: [inbox.inboxId] });
        await ctx.runMutation(internal.demo.register, { inboxId: inbox.inboxId, address: inbox.inboxId, webhookId: hook.webhookId, webhookSecret: hook.secret });
      } catch (e) {
        console.error("demo pool could not grow", String(e));
        return { ok: false, busy: true, nextFree: state.nextFree };
      }
    }
    const slug = `demo-${token(6)}`;
    let leased: { tenantId: Id<"tenants">; inbox: string; expiresAt: number };
    try {
      leased = await ctx.runMutation(internal.demo.lease, { slug, ownerName, ownerEmail, businessName, site, timeZone });
    } catch (e) {
      if (String(e).includes("busy")) return { ok: false, busy: true, nextFree: state.nextFree };
      throw e;
    }
    if (site) await ctx.scheduler.runAfter(0, internal.knowledge.refreshTenant, { tenantId: leased.tenantId });
    return { ok: true, slug, key: await surfaceKey(slug), inbox: leased.inbox, url: await liveSurfaceUrl(slug), expiresAt: leased.expiresAt };
  },
});

/**
 * The inbox the pretend customer writes from. AgentMail files an inbox's mail to itself under
 * "sent" and never delivers it, so it has to be another inbox of ours: HTR_DEMO_CUSTOMER_INBOX,
 * or client zero's. The signed reply lands back there and mail.receive leaves it alone.
 */
export const customerInbox = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const env = process.env.HTR_DEMO_CUSTOMER_INBOX;
    if (env) return env;
    for (const t of await ctx.db.query("tenants").take(500)) if (!t.demo && t.channels.inboxId) return t.channels.inboxId;
    return null;
  },
});

/** The surface's "Send a customer email": one of our inboxes writes to the demo's, signed with the customer's name. */
export const sendAsCustomer = action({
  args: { slug: v.string(), key: v.string(), name: v.string(), subject: v.string(), text: v.string() },
  handler: async (ctx, { slug, key, name, subject, text }): Promise<string> => {
    const tenantId = await ctx.runQuery(internal.tenants.requireSurface, { slug, key });
    const tenant = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant?.demo || tenant.demo.endedAt) throw new Error("This demo has ended.");
    const inbox = tenant.channels.inboxId;
    if (!inbox) throw new Error("This demo has no inbox.");
    const from = await ctx.runQuery(internal.demo.customerInbox, {});
    if (!from) throw new Error("No inbox to write from; email the address from your own account instead.");
    const who = name.trim().slice(0, 60) || "A customer";
    const body = text.trim().slice(0, 4000);
    if (!body) throw new Error("Nothing to send: the message was empty.");
    await client().send(from, { to: [inbox], subject: subject.trim().slice(0, 120) || "Hello", text: body, headers: { [CUSTOMER_HEADER]: who } });
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "demo.customer_sent", payload: { who, from } });
    return `Sent as ${who}. Watch this page.`;
  },
});

/** The owner is done: the inbox goes back to the pool now, not in thirty minutes. */
export const end = mutation({
  args: { slug: v.string(), key: v.string() },
  handler: async (ctx, { slug, key }) => {
    const tenant = await requireSurface(ctx, slug, key);
    if (!tenant.demo) throw new Error("Not a demo.");
    const now = Date.now();
    const row = await ctx.db.query("demoInboxes").withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id)).unique();
    if (row) await ctx.db.patch(row._id, { tenantId: undefined, leasedUntil: undefined });
    await endLease(ctx, tenant, now);
    return "Demo ended. Thanks for trying it.";
  },
});

// ---- shrinking the pool ---------------------------------------------------------------------

export const forget = internalMutation({
  args: { inboxId: v.string() },
  handler: async (ctx, { inboxId }): Promise<{ webhookId: string } | null> => {
    const row = await ctx.db.query("demoInboxes").withIndex("by_inbox", (q) => q.eq("inboxId", inboxId)).unique();
    if (!row) return null;
    if (row.tenantId) {
      const tenant = await ctx.db.get(row.tenantId);
      if (tenant) await endLease(ctx, tenant, Date.now());
    }
    await ctx.db.delete(row._id);
    return { webhookId: row.webhookId };
  },
});

/**
 * `npx convex run demo:retire '{"inboxId":"room-2-xxxx@agentmail.to"}'`: give a pool inbox back to
 * AgentMail when it is no longer needed. Any demo on it ends now.
 */
export const retire = internalAction({
  args: { inboxId: v.string() },
  handler: async (ctx, { inboxId }): Promise<string> => {
    const gone: { webhookId: string } | null = await ctx.runMutation(internal.demo.forget, { inboxId });
    if (!gone) return "no such pool inbox";
    const c = client();
    try {
      await c.deleteWebhook(gone.webhookId);
    } catch (e) {
      console.warn(`webhook ${gone.webhookId} not deleted: ${String(e).slice(0, 120)}`);
    }
    await c.deleteInbox(inboxId);
    return "retired";
  },
});

// ---- growing the pool ahead of demand -------------------------------------------------------

/**
 * `npx convex run demo:warm` (optionally '{"to":10}'): create pool inboxes now so the first
 * visitor after a quiet spell waits on nothing. Grows to `to`, clamped to HTR_DEMO_POOL; never
 * shrinks. Returns how many it made and the pool total.
 */
export const warm = internalAction({
  args: { to: v.optional(v.number()) },
  handler: async (ctx, { to }): Promise<{ created: number; total: number }> => {
    const target = Math.min(to ?? poolCap(), poolCap());
    const c = client();
    let state = await ctx.runQuery(internal.demo.poolState, {});
    let created = 0;
    while (state.total < target) {
      const inbox = await c.createInbox({ username: `room-${state.total + 1}-${token(4)}`, displayName: "Hold the Room" });
      const hook = await c.createWebhook({ url: `${siteUrl()}${POOL_ROUTE}`, eventTypes: ["message.received"], inboxIds: [inbox.inboxId] });
      await ctx.runMutation(internal.demo.register, { inboxId: inbox.inboxId, address: inbox.inboxId, webhookId: hook.webhookId, webhookSecret: hook.secret });
      created++;
      state = await ctx.runQuery(internal.demo.poolState, {});
    }
    return { created, total: state.total };
  },
});

// ---- the sweep ------------------------------------------------------------------------------

const TENANT_TABLES = ["messages", "proposals", "rulings", "digests", "events", "actions", "contacts", "knowledge", "facts", "chunks"] as const;
const TENANT_INDEX = {
  messages: "by_tenant_at", proposals: "by_tenant_created", rulings: "by_tenant_at", digests: "by_tenant_sent",
  events: "by_tenant_at", actions: "by_tenant_key", contacts: "by_tenant_address", knowledge: "by_tenant_url", facts: "by_tenant_at", chunks: "by_tenant",
} as const;

async function purge(ctx: MutationCtx, tenantId: Id<"tenants">) {
  for (const table of TENANT_TABLES) {
    const rows = await ctx.db
      .query(table)
      .withIndex(TENANT_INDEX[table] as any, (q: any) => q.eq("tenantId", tenantId))
      .take(1000);
    for (const r of rows) await ctx.db.delete(r._id);
  }
  await ctx.db.delete(tenantId);
}

/** Hourly: release expired leases; forget demos that ended a day ago. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let released = 0;
    let purged = 0;
    for (const row of await ctx.db.query("demoInboxes").take(POOL_MAX)) {
      if (!row.tenantId || (row.leasedUntil ?? 0) >= now) continue;
      const tenant = await ctx.db.get(row.tenantId);
      if (tenant) await endLease(ctx, tenant, now);
      await ctx.db.patch(row._id, { tenantId: undefined, leasedUntil: undefined });
      released++;
    }
    for (const t of await ctx.db.query("tenants").take(500)) {
      if (!t.demo?.endedAt || now - t.demo.endedAt < KEEP_MS) continue;
      await purge(ctx, t._id);
      purged++;
    }
    return { released, purged };
  },
});

// ---- small things -----------------------------------------------------------------------------

function token(n: number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
