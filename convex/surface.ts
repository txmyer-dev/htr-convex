// Who may look at, and rule from, the web surface. Client zero: a per-tenant key derived from
// the ruling secret, carried in the surface URL. Same trust model as the Send / Skip links: the
// owner holds the URL, nobody else does. Convex Auth replaces this when a second person needs in.

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { rulingToken, tokenEquals } from "./lib/rulings/token";

export function rulingSecret(): string {
  const s = process.env.HTR_RULING_SECRET;
  if (!s) throw new Error("HTR_RULING_SECRET is not set on the deployment");
  return s;
}

export async function surfaceKey(slug: string): Promise<string> {
  return await rulingToken(rulingSecret(), slug, "surface", "sign");
}

export async function tenantBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"tenants"> | null> {
  return await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
}

export async function requireTenant(ctx: QueryCtx, slug: string): Promise<Doc<"tenants">> {
  const t = await tenantBySlug(ctx, slug);
  if (!t) throw new Error(`unknown tenant ${slug}`);
  return t;
}

export async function requireSurface(ctx: QueryCtx, slug: string, key: string): Promise<Doc<"tenants">> {
  if (!tokenEquals(await surfaceKey(slug), key)) throw new Error("bad surface key");
  return await requireTenant(ctx, slug);
}

/** The public origin of this deployment's HTTP actions, e.g. https://happy-otter-123.convex.site */
export function siteUrl(): string {
  const s = process.env.CONVEX_SITE_URL;
  if (!s) throw new Error("CONVEX_SITE_URL is not set");
  return s.replace(/\/$/, "");
}

/**
 * The owner's link to the live surface: the React app, served by the static hosting component
 * from the same origin as the HTTP routes. The key in the URL is the whole login.
 */
export async function liveSurfaceUrl(slug: string): Promise<string> {
  return `${siteUrl()}/?t=${encodeURIComponent(slug)}&k=${await surfaceKey(slug)}`;
}

/**
 * The secret behind site requests to the web agent: its own, and never the ruling secret. The VPS
 * holds a copy of this one, so the two must not be the same key: the ruling secret signs Send /
 * Skip links and derives every surface key, and an agent that held it could rule as the owner.
 * Missing means no site request goes out, which is the safe failure.
 */
export function siteSecret(): string {
  const s = process.env.HTR_SITE_SECRET;
  if (!s) throw new Error("HTR_SITE_SECRET is not set on the deployment");
  if (s === process.env.HTR_RULING_SECRET) throw new Error("HTR_SITE_SECRET must not be the ruling secret: the web agent holds a copy of it");
  return s;
}
