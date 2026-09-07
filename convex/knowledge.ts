// What the world says, read by Firecrawl, kept in front of the drafter.
//
// Two kinds of page. The business site: the client's own pages, crawled (up to HTR_CRAWL_PAGES
// of them) into the `knowledge` table, so hours, prices, and names come from the site rather
// than from the model's imagination; read at install, whenever the site changes, and once a
// week by the cron. The sender's site: on first
// contact from a company address the drafter reads that domain into the contact's `profile`, so
// the reply knows who is writing. Neither is ever read on a webmail domain.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, type ActionCtx } from "./_generated/server";
import { normalizeBaseUrl } from "./drafter";
import { chunkMarkdown } from "./lib/knowledge/chunk";
import { senderSite } from "./lib/knowledge/domain";
import { embed, EMBED_DEFAULT_MODEL, type EmbedOptions } from "./lib/llm/embed";

export type Page = { url: string; title?: string; markdown: string };

export async function scrape(url: string, apiKey: string, fetchImpl: typeof fetch = fetch, cap = 20_000): Promise<Page> {
  const res = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    // maxAge 0: Firecrawl serves a two-day cache by default, and a refresh is asked for because the site changed.
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, maxAge: 0 }),
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
  return { url: d.metadata?.sourceURL ?? url, title: d.metadata?.title, markdown: markdown.slice(0, cap) };
}

export type CrawlOptions = { limit?: number; cap?: number; pollMs?: number; maxWaitMs?: number; depth?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pages that are never what a business says: sign-in, carts, accounts, search results, tag and category listings. */
export const EXCLUDE_PATHS = ["^/(signin|sign-in|login|logout|signup|sign-up|register|cart|checkout|account|my-account|search|tag|tags|category|categories|wp-admin|wp-login\\.php)(/.*)?$"];

/**
 * The whole site, not the homepage: Firecrawl's crawl walks the site (sitemap and links, two
 * hops deep) and returns each page as markdown. The job is asynchronous, so this starts it and
 * polls until it completes. Dead pages and empty pages are dropped; the homepage comes first,
 * then the rest by URL, so the drafter's budget is spent on the front of the site.
 */
export async function crawl(url: string, apiKey: string, fetchImpl: typeof fetch = fetch, opts: CrawlOptions = {}): Promise<Page[]> {
  const { limit = 20, cap = 6_000, pollMs = 3_000, maxWaitMs = 180_000, depth = 2 } = opts;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const started = await fetchImpl("https://api.firecrawl.dev/v2/crawl", {
    method: "POST",
    headers,
    // sitemap: skip. With a page budget, the pages linked from the homepage (the nav: hours,
    // prices, services, contact) matter more than whatever a sitemap lists first (the blog).
    body: JSON.stringify({
      url, limit, maxDiscoveryDepth: depth, sitemap: "skip", excludePaths: EXCLUDE_PATHS,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true, maxAge: 0 },
    }),
  });
  const job = await started.json();
  if (!started.ok || !job?.success || !job.id) throw new Error(`Firecrawl crawl ${started.status}: ${JSON.stringify(job).slice(0, 300)}`);
  const deadline = Date.now() + maxWaitMs;
  const raw: Array<{ markdown?: string; metadata?: Record<string, unknown> }> = [];
  let next: string | null = `https://api.firecrawl.dev/v2/crawl/${job.id}`;
  while (next) {
    const res: Response = await fetchImpl(next, { headers });
    const j: any = await res.json();
    if (!res.ok || j?.success === false || j?.status === "failed") throw new Error(`Firecrawl crawl ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    if (j.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`Firecrawl crawl of ${url} did not finish in ${Math.round(maxWaitMs / 1000)} s`);
      await sleep(pollMs);
      continue;
    }
    raw.push(...(Array.isArray(j.data) ? j.data : []));
    next = typeof j.next === "string" && j.next ? j.next : null;
  }
  const seen = new Set<string>();
  const pages: Page[] = [];
  for (const d of raw) {
    const m = d.metadata ?? {};
    const status = Number(m.statusCode ?? 200);
    const markdown = String(d.markdown ?? "").trim();
    const pageUrl = String(m.sourceURL ?? m.url ?? "");
    // A URL with a query string is a search, a redirect, or a tracked link, not a page of the site.
    if (status >= 400 || !markdown || !pageUrl || pageUrl.includes("?") || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    const title = Array.isArray(m.title) ? String(m.title[0] ?? "") : m.title ? String(m.title) : undefined;
    pages.push({ url: pageUrl, title: title || undefined, markdown: markdown.slice(0, cap) });
  }
  if (pages.length === 0) throw new Error(`Firecrawl: ${url} had no readable pages; nothing stored`);
  return pages.sort((a, b) => a.url.length - b.url.length || (a.url < b.url ? -1 : 1));
}

/** HTR_CRAWL_PAGES: how many pages of a business site to read (default 20). Firecrawl charges one credit per page. */
export function crawlLimit(): number {
  const n = Number(process.env.HTR_CRAWL_PAGES ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 20;
}

function apiKey(): string {
  const k = process.env.FIRECRAWL_API_KEY;
  if (!k) throw new Error("FIRECRAWL_API_KEY is not set on the deployment");
  return k;
}

// ---- the business site -----------------------------------------------------------------------

/** Upsert pages by URL. With `replace`, pages the site no longer has are forgotten too. */
export const store = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    pages: v.array(v.object({ url: v.string(), title: v.optional(v.string()), markdown: v.string() })),
    replace: v.optional(v.boolean()),
  },
  handler: async (ctx, { tenantId, pages, replace }) => {
    const keep = new Set(pages.map((p) => p.url));
    for (const p of pages) {
      const existing = await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", tenantId).eq("url", p.url)).unique();
      const row = { tenantId, ...p, fetchedAt: Date.now() };
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert("knowledge", row);
    }
    if (replace) {
      for (const old of await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", tenantId)).take(200)) {
        if (!keep.has(old.url)) await ctx.db.delete(old._id);
      }
    }
    // The pieces and their embeddings follow, off the transaction.
    await ctx.scheduler.runAfter(0, internal.knowledge.embedTenant, { tenantId });
  },
});

type Read = Array<{ url: string; title?: string; chars: number }>;

/** The business site: crawled, and if the crawl fails, at least the one page scraped. */
async function readBusinessSite(site: string): Promise<Page[]> {
  try {
    return await crawl(site, apiKey(), fetch, { limit: crawlLimit() });
  } catch (e) {
    const one = await scrape(site, apiKey());
    console.warn(`crawl of ${site} failed (${String(e).slice(0, 120)}); stored the one page`);
    return [one];
  }
}

async function readSite(ctx: ActionCtx, tenant: Doc<"tenants">, urls?: string[]): Promise<Read> {
  const pages: Page[] = tenant.business.site ? await readBusinessSite(tenant.business.site) : [];
  for (const u of urls ?? []) pages.push(await scrape(u, apiKey()));
  // A full read replaces what the site used to say; extra URLs are additions.
  await ctx.runMutation(internal.knowledge.store, { tenantId: tenant._id, pages, replace: !urls?.length });
  return pages.map((p) => ({ url: p.url, title: p.title, chars: p.markdown.length }));
}

/** `npx convex run knowledge:refresh '{"slug":"tony"}'` — the business site, plus any extra URLs. */
export const refresh = action({
  args: { slug: v.string(), urls: v.optional(v.array(v.string())) },
  handler: async (ctx, { slug, urls }): Promise<Read> => {
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.bySlug, { slug });
    if (!tenant) throw new Error(`unknown tenant ${slug}`);
    return await readSite(ctx, tenant, urls);
  },
});

/** The same, by id: scheduled when a demo names its site. A failure is logged, never fatal. */
export const refreshTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<Read | null> => {
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant || !tenant.business.site) return null;
    try {
      return await readSite(ctx, tenant);
    } catch (e) {
      await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "knowledge.failed", payload: { site: tenant.business.site, error: String(e) } });
      return null;
    }
  },
});

/** The weekly cron: every live tenant's site, re-read. Sites change; the drafts should too. */
export const refreshAll = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const tenants: Doc<"tenants">[] = await ctx.runQuery(internal.tenants.all, {});
    let n = 0;
    for (const t of tenants) {
      if (!t.business.site || t.demo?.endedAt) continue;
      await ctx.runAction(internal.knowledge.refreshTenant, { tenantId: t._id });
      n++;
    }
    return n;
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

// ---- the sender's site ------------------------------------------------------------------------

export const profileValidator = v.object({ url: v.string(), title: v.optional(v.string()), markdown: v.string(), fetchedAt: v.number() });
export type Profile = Doc<"contacts">["profile"];

export const setProfile = internalMutation({
  args: { contactId: v.id("contacts"), profile: v.optional(profileValidator) },
  handler: async (ctx, { contactId, profile }) => {
    await ctx.db.patch(contactId, { profile, profiledAt: Date.now() });
  },
});

/**
 * Who is writing, from their own domain, once per contact. Returns the profile to draft with:
 * the one already read, or a fresh one. A webmail address, a missing key, or a dead site all
 * mean "nothing", and the attempt is remembered so the next message does not read it again.
 */
export async function profileSender(ctx: ActionCtx, contact: Doc<"contacts"> | null): Promise<NonNullable<Profile> | null> {
  if (!contact) return null;
  if (contact.profiledAt) return contact.profile ?? null;
  const site = senderSite(contact.address);
  const key = process.env.FIRECRAWL_API_KEY;
  if (!site || !key) return null;
  let profile: NonNullable<Profile> | undefined;
  try {
    const page = await scrape(site, key, fetch, 8_000);
    profile = { url: page.url, title: page.title, markdown: page.markdown, fetchedAt: Date.now() };
  } catch (e) {
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId: contact.tenantId, kind: "profile.failed", payload: { site, error: String(e).slice(0, 200) } });
  }
  await ctx.runMutation(internal.knowledge.setProfile, { contactId: contact._id, profile });
  return profile ?? null;
}

// ---- the site in pieces, with embeddings --------------------------------------------------------
//
// A site of twenty pages does not fit in a prompt. Each page is cut into chunks (lib/knowledge/
// chunk.ts), each chunk embedded, and the drafter asks the vector index for the few that speak to
// the message. Rebuilt whenever the site is re-read; absent (no key, a failed call), the drafter
// falls back to ranking whole pages by the words they share with the message.

export function embedOptions(): EmbedOptions | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return { baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL), apiKey, model: process.env.OPENAI_EMBED_MODEL || EMBED_DEFAULT_MODEL };
}

export const MAX_CHUNKS = 400; // twenty pages, twenty pieces each, at most

const chunkRow = v.object({ url: v.string(), title: v.optional(v.string()), text: v.string(), embedding: v.array(v.float64()), fetchedAt: v.number() });

/** Everything the tenant had, replaced by these. One transaction, so a draft never sees half a site. */
export const replaceChunks = internalMutation({
  args: { tenantId: v.id("tenants"), chunks: v.array(chunkRow) },
  handler: async (ctx, { tenantId, chunks }) => {
    for (const old of await ctx.db.query("chunks").withIndex("by_tenant", (q) => q.eq("tenantId", tenantId)).take(MAX_CHUNKS * 2)) await ctx.db.delete(old._id);
    for (const c of chunks.slice(0, MAX_CHUNKS)) await ctx.db.insert("chunks", { tenantId, ...c });
    return Math.min(chunks.length, MAX_CHUNKS);
  },
});

export const hasChunks = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<boolean> => (await ctx.db.query("chunks").withIndex("by_tenant", (q) => q.eq("tenantId", tenantId)).first()) !== null,
});

export const chunksByIds = internalQuery({
  args: { ids: v.array(v.id("chunks")) },
  handler: async (ctx, { ids }): Promise<Array<{ url: string; title?: string; text: string }>> => {
    const out: Array<{ url: string; title?: string; text: string }> = [];
    for (const id of ids) {
      const c = await ctx.db.get(id);
      if (c) out.push({ url: c.url, title: c.title, text: c.text });
    }
    return out;
  },
});

export const pagesOf = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<Doc<"knowledge">[]> =>
    await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", tenantId)).take(100),
});

/** Cut every page of the site into chunks, embed them in one call, and replace what was there. */
export const embedTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<number> => {
    const o = embedOptions();
    if (!o) return 0;
    const pages: Doc<"knowledge">[] = await ctx.runQuery(internal.knowledge.pagesOf, { tenantId });
    const rows: Array<{ url: string; title?: string; text: string; fetchedAt: number }> = [];
    for (const p of pages) for (const c of chunkMarkdown(p.markdown)) rows.push({ url: p.url, title: p.title, text: c.text, fetchedAt: p.fetchedAt });
    const batch = rows.slice(0, MAX_CHUNKS);
    try {
      const vectors: number[][] = [];
      for (let i = 0; i < batch.length; i += 100) vectors.push(...(await embed(batch.slice(i, i + 100).map((r) => r.text), o)));
      return await ctx.runMutation(internal.knowledge.replaceChunks, { tenantId, chunks: batch.map((r, i) => ({ ...r, embedding: vectors[i] })) });
    } catch (e) {
      await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "embed.failed", payload: { chunks: batch.length, error: String(e).slice(0, 200) } });
      return 0;
    }
  },
});

/** The drafter's question to the index: the chunks that speak to the message, most similar first. */
export async function retrieve(ctx: ActionCtx, tenantId: Id<"tenants">, query: string, limit = 8): Promise<Array<{ url: string; title?: string; text: string }> | null> {
  const o = embedOptions();
  if (!o || !(await ctx.runQuery(internal.knowledge.hasChunks, { tenantId }))) return null;
  try {
    const [vector] = await embed([query.slice(0, 4_000)], o);
    const hits = await ctx.vectorSearch("chunks", "by_embedding", { vector, limit, filter: (q) => q.eq("tenantId", tenantId) });
    if (hits.length === 0) return [];
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "retrieve.hit", payload: { chunks: hits.length, top: Number(hits[0]._score.toFixed(3)) } });
    return await ctx.runQuery(internal.knowledge.chunksByIds, { ids: hits.map((h) => h._id) });
  } catch (e) {
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "retrieve.failed", payload: { error: String(e).slice(0, 200) } });
    return null;
  }
}
