// The install file. This IS the tenant model: adding a client is adding a block here and
// running `npx convex run install:apply`. If a tenant ever needs code, the design failed.
//
// Names only here; secrets live on the Convex deployment (`npx convex env set ...`).
// Client zero is Tony's own mailbox for a week.

import { internalMutation, mutation } from "./_generated/server";
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
      digestAt: "immediate", // client zero: tell me as soon as a draft exists (later: "17:00")
      quietHours: ["21:00", "08:00"],
      defaultDeadlineDays: 2,
      discloseAssistant: true,
      autonomyTier: 0,
    },
    business: {
      site: "https://felaniam.cloud",
      bookingLink: "https://calendar.app.google/PzY2EQVcyDDQ2GY9A",
      agentName: "Ekko",
      // The agent that edits felaniam.cloud (its own AgentMail inbox, on the VPS). With it set, a
      // fact the site does not say becomes a site proposal; without it, facts stay in the room.
      webAgent: "web-felaniam@agentmail.to",
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
export const apply = mutation({
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
