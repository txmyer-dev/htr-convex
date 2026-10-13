// Firecrawl's wire: scrape one page, crawl a site. Moved from knowledge.ts (2026-10-13) so the
// reader claw (adapters/firecrawl.ts) can wrap it; knowledge.ts re-exports it unchanged.

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
