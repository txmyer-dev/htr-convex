// What the business says about itself. Firecrawl reads the client's site into markdown; the
// drafter puts it in front of the model so hours, prices, and names come from the site rather
// than from the model's imagination. `refresh` is run at install and whenever the site changes.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";

type Page = { url: string; title?: string; markdown: string };

export async function scrape(url: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Page> {
  const res = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  const json = await res.json();
  if (!res.ok || !json?.success) throw new Error(`Firecrawl ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const d = json.data ?? {};
  // A dead site is not knowledge: Firecrawl returns the 404 page as markdown with success=true,
  // and the drafter would put "page not found" in front of the model as what the business says.
  const status = Number(d.metadata?.statusCode ?? 200);
  if (status >= 400) throw new Error(`Firecrawl: ${url} answered ${status}${d.metadata?.error ? ` (${d.metadata.error})` : ""}; nothing stored`);
  const markdown = String(d.markdown ?? "").trim();
  if (!markdown) throw new Error(`Firecrawl: ${url} had no readable content; nothing stored`);
  return { url: d.metadata?.sourceURL ?? url, title: d.metadata?.title, markdown: markdown.slice(0, 20_000) };
}

export const store = internalMutation({
  args: { tenantId: v.id("tenants"), pages: v.array(v.object({ url: v.string(), title: v.optional(v.string()), markdown: v.string() })) },
  handler: async (ctx, { tenantId, pages }) => {
    for (const p of pages) {
      const existing = await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", tenantId).eq("url", p.url)).unique();
      const row = { tenantId, ...p, fetchedAt: Date.now() };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("knowledge", row);
    }
  },
});

/** `npx convex run knowledge:refresh '{"slug":"tony"}'` — the business site, plus any extra URLs. */
export const refresh = action({
  args: { slug: v.string(), urls: v.optional(v.array(v.string())) },
  handler: async (ctx, { slug, urls }) => {
    const tenant = await ctx.runQuery(internal.tenants.bySlug, { slug });
    if (!tenant) throw new Error(`unknown tenant ${slug}`);
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set on the deployment");
    const targets = [...(tenant.business.site ? [tenant.business.site] : []), ...(urls ?? [])];
    const pages: Page[] = [];
    for (const u of targets) pages.push(await scrape(u, apiKey));
    await ctx.runMutation(internal.knowledge.store, { tenantId: tenant._id, pages });
    return pages.map((p) => ({ url: p.url, title: p.title, chars: p.markdown.length }));
  },
});

/** `npx convex run knowledge:clear '{"slug":"tony"}'` — forget everything read for a tenant. */
export const clear = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const tenant = await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!tenant) throw new Error(`unknown tenant ${slug}`);
    const rows = await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", tenant._id)).collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { removed: rows.length };
  },
});
