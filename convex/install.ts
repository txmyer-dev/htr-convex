// The install file. This IS the tenant model: adding a client is adding a block here and
// running `npx convex run install:apply`. If a tenant ever needs code, the design failed.
//
// Names only here; secrets live on the Convex deployment (`npx convex env set ...`).
// Client zero is Tony's own mailbox for a week.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { liveSurfaceUrl } from "./surface";
import type { Doc } from "./_generated/dataModel";

type Install = Omit<Doc<"tenants">, "_id" | "_creationTime" | "hold" | "digestScheduled">;

export const TENANTS: Install[] = [
  {
    slug: "tony",
    displayName: "Tony Myers",
    timeZone: "America/New_York",
    owner: {
      name: "Tony",
      names: ["Tony", "Tony Myers"],
      email: "txmyer@gmail.com", // rulings by email are checked against this address
      digestAt: "immediate", // client zero: each item to the phone as soon as it exists
      weeklyDigest: { weekday: 6, at: "18:00" }, // and one email on Sunday evening: the last call
      quietHours: ["21:00", "08:00"],
      defaultDeadlineDays: 2,
      discloseAssistant: true,
      autonomyTier: 0,
    },
    business: {
      site: "https://felaniam.cloud/demo.html", // sandbox copy the web agent edits; real homepage untouched
      bookingLink: "https://calendar.app.google/PzY2EQVcyDDQ2GY9A",
      agentName: "Ekko",
      // The agent that edits felaniam.cloud (its own AgentMail inbox, on the VPS). With it set, a
      // fact the site does not say becomes a site proposal; without it, facts stay in the room.
      webAgent: "web-felaniam@agentmail.to",
    },
    tasks: {
      // GTD space (rebuilt 2026-10-15): one "<Area> – Actions" list per area; no lane goes to the inbox.
      clickupListId: "901422331534", listName: "00 Inbox", // personal, no lane
      teamId: "90141714135",
      byLane: [
        { lane: "wotai", clickupListId: "901422331563", listName: "WotAI – Actions" },
        { lane: "felani.am", clickupListId: "901422331569", listName: "felani.am – Actions" },
        { lane: "branded-flow", clickupListId: "901422331561", listName: "bF – Actions" },
      ],
    },
    channels: {
      // Filled once the AgentMail inbox exists: `npx convex run mail:provision '{"slug":"tony"}'`
    },
  },
];

async function upsert(ctx: { db: any }, t: Install) {
  const existing = await ctx.db.query("tenants").withIndex("by_slug", (q: any) => q.eq("slug", t.slug)).unique();
  if (existing) {
    // The install block wins for everything it names; runtime state (channels, hold) is kept.
    await ctx.db.patch(existing._id, { ...t, channels: { ...t.channels, ...existing.channels } });
    return existing._id;
  }
  return await ctx.db.insert("tenants", t);
}

/** `npx convex run install:apply` after editing TENANTS. Idempotent. */
export const apply = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ids = [];
    for (const t of TENANTS) ids.push(await upsert(ctx, t));
    return ids;
  },
});

export const applyInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const t of TENANTS) await upsert(ctx, t);
  },
});

/** `npx convex run install:ownerLink '{"slug":"tony"}'`: the owner's link to the live surface (the key is the login). */
export const ownerLink = internalQuery({
  args: { slug: v.string() },
  handler: async (_ctx, { slug }): Promise<string> => await liveSurfaceUrl(slug),
});

// ---- a self-hosted install (npm run setup) ----------------------------------------------------------

/**
 * The one tenant of a self-hosted install, from setup's answers rather than TENANTS. Idempotent:
 * re-running setup updates the block and keeps the runtime state (the Gmail grant, the hold).
 */
export const create = internalMutation({
  args: {
    slug: v.string(),
    displayName: v.string(),
    timeZone: v.string(),
    owner: v.object({ name: v.string(), email: v.string(), digestAt: v.string(), quietHours: v.optional(v.array(v.string())) }),
    business: v.object({ agentName: v.string(), site: v.optional(v.string()) }),
    tasks: v.optional(v.object({ clickupListId: v.string(), listName: v.string(), teamId: v.optional(v.string()) })),
    mail: v.union(v.literal("gmail"), v.literal("agentmail")),
  },
  handler: async (ctx, a) => {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(a.slug)) throw new Error("slug: lowercase letters, digits and dashes");
    if (a.owner.digestAt !== "immediate" && !/^\d{2}:\d{2}$/.test(a.owner.digestAt)) throw new Error('digestAt: "immediate" or HH:MM');
    new Intl.DateTimeFormat("en-US", { timeZone: a.timeZone }); // throws on an unknown zone
    const first = a.owner.name.trim().split(/\s+/)[0];
    return await upsert(ctx, {
      slug: a.slug,
      displayName: a.displayName,
      timeZone: a.timeZone,
      owner: {
        name: first, names: [...new Set([first, a.owner.name.trim()])], email: a.owner.email.toLowerCase(), digestAt: a.owner.digestAt,
        quietHours: a.owner.quietHours, defaultDeadlineDays: 2, discloseAssistant: true, autonomyTier: 0,
      },
      business: { agentName: a.business.agentName, site: a.business.site },
      tasks: a.tasks,
      channels: {},
      adapters: a.mail === "gmail" ? { mail: { kind: "gmail" } } : undefined,
    });
  },
});

/** What setup and update print: is Gmail connected, and how did every claw do on the last beat. */
export const status = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const t = await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!t) return null;
    const claws = await ctx.db.query("clawHealth").withIndex("by_tenant_port", (q) => q.eq("tenantId", t._id)).take(20);
    return {
      gmail: t.channels.gmail ? { address: t.channels.gmail.address, grantedAt: t.channels.gmail.grantedAt } : null,
      claws: claws.map((c) => ({ port: c.port, adapter: c.adapter ?? null, ok: c.ok, error: c.error ?? null, at: c.at })),
    };
  },
});
