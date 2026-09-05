import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { liveSurfaceUrl, requireSurface as requireSurfaceKey } from "./surface";

export const get = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => await ctx.db.get(tenantId),
});

export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
});

export const all = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("tenants").collect(),
});

export const setChannels = internalMutation({
  args: { tenantId: v.id("tenants"), inboxId: v.string(), inboxAddress: v.string() },
  handler: async (ctx, { tenantId, inboxId, inboxAddress }) => {
    await ctx.db.patch(tenantId, { channels: { inboxId, inboxAddress } });
  },
});

/** What the surface shows about the install itself. */
export const surface = query({
  args: { slug: v.string(), key: v.string() },
  handler: async (ctx, { slug, key }) => {
    const t = await requireSurfaceKey(ctx, slug, key);
    return {
      slug: t.slug, displayName: t.displayName, timeZone: t.timeZone, ownerName: t.owner.name,
      ownerEmail: t.owner.email, digestAt: t.owner.digestAt, hold: t.hold ?? null, inbox: t.channels.inboxAddress ?? null,
    };
  },
});

/** `npx convex run tenants:surfaceUrl '{"slug":"tony"}'` prints the owner's link to the live surface. */
export const surfaceUrl = internalQuery({
  args: { slug: v.string() },
  handler: async (_ctx, { slug }) => await liveSurfaceUrl(slug),
});

/** Actions check the surface key through this before doing anything on the owner's behalf. */
export const requireSurface = internalQuery({
  args: { slug: v.string(), key: v.string() },
  handler: async (ctx, { slug, key }) => (await requireSurfaceKey(ctx, slug, key))._id,
});
