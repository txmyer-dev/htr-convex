// Firecrawl in: what gets to count as what the business says.

import { describe, expect, it } from "vitest";
import { crawl, EXCLUDE_PATHS, scrape } from "../convex/knowledge";

const firecrawl = (payload: unknown, ok = true) =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload })) as unknown as typeof fetch;

describe("scrape", () => {
  it("a live page becomes url, title, and trimmed markdown", async () => {
    const page = await scrape("https://shop.example", "k", firecrawl({
      success: true,
      data: { markdown: "  # Hours\nSat 10–4  ", metadata: { sourceURL: "https://shop.example/", title: "The Shop", statusCode: 200 } },
    }));
    expect(page).toEqual({ url: "https://shop.example/", title: "The Shop", markdown: "# Hours\nSat 10–4" });
  });

  it("a 404 is not knowledge even though Firecrawl calls it a success", async () => {
    await expect(scrape("https://dead.example", "k", firecrawl({
      success: true,
      data: { markdown: "<pre>404 page not found</pre>", metadata: { statusCode: 404, error: "Not Found" } },
    }))).rejects.toThrow(/dead\.example answered 404 \(Not Found\)/);
  });

  it("an empty page is not knowledge", async () => {
    await expect(scrape("https://blank.example", "k", firecrawl({ success: true, data: { markdown: "   ", metadata: { statusCode: 200 } } })))
      .rejects.toThrow(/no readable content/);
  });

  it("a Firecrawl failure surfaces its status and body", async () => {
    await expect(scrape("https://x.example", "k", firecrawl({ success: false, error: "rate limited" }, false)))
      .rejects.toThrow(/Firecrawl 500: .*rate limited/);
  });
});

// A fake Firecrawl for the crawl: a queue of responses, one per request, in order.
function sequence(responses: Array<{ status?: number; body: unknown }>): typeof fetch & { calls: Array<{ url: string; method: string; body?: unknown }> } {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift();
    if (!r) throw new Error("no response queued");
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  }) as unknown as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const page = (url: string, markdown: string, over: Record<string, unknown> = {}) => ({ markdown, metadata: { sourceURL: url, title: `T ${url}`, statusCode: 200, ...over } });

describe("crawl", () => {
  it("starts the job, polls until it completes, follows next, drops dead and empty pages, homepage first", async () => {
    const f = sequence([
      { body: { success: true, id: "job1", url: "https://shop.example" } },
      { body: { success: true, status: "scraping", data: [] } },
      { body: { success: true, status: "completed", next: "https://api.firecrawl.dev/v2/crawl/job1?skip=2", data: [
        page("https://shop.example/hours", "Sat 10-4"),
        page("https://shop.example/", "# The Shop"),
      ] } },
      { body: { success: true, status: "completed", data: [
        page("https://shop.example/gone", "not found", { statusCode: 404 }),
        page("https://shop.example/blank", "   "),
        page("https://shop.example/?s=hours", "search results"),
        page("https://shop.example/hours", "duplicate"),
        page("https://shop.example/menu", "x".repeat(50), { title: ["Menu", "alt"] }),
      ] } },
    ]);
    const pages = await crawl("https://shop.example", "k", f, { limit: 5, cap: 20, pollMs: 0 });
    expect(pages.map((p) => p.url)).toEqual(["https://shop.example/", "https://shop.example/menu", "https://shop.example/hours"]);
    expect(pages[1]).toEqual({ url: "https://shop.example/menu", title: "Menu", markdown: "x".repeat(20) });
    expect(f.calls[0]).toMatchObject({ url: "https://api.firecrawl.dev/v2/crawl", method: "POST", body: { url: "https://shop.example", limit: 5, sitemap: "skip", excludePaths: EXCLUDE_PATHS, scrapeOptions: { formats: ["markdown"], onlyMainContent: true, maxAge: 0 } } });
    expect(f.calls.slice(1).map((c) => c.url)).toEqual(["https://api.firecrawl.dev/v2/crawl/job1", "https://api.firecrawl.dev/v2/crawl/job1", "https://api.firecrawl.dev/v2/crawl/job1?skip=2"]);
  });

  it("a failed job, a refused start, and a site with nothing readable are errors", async () => {
    await expect(crawl("https://x.example", "k", sequence([{ status: 402, body: { success: false, error: "no credits" } }]))).rejects.toThrow(/crawl 402: .*no credits/);
    await expect(crawl("https://x.example", "k", sequence([{ body: { success: true, id: "j" } }, { body: { status: "failed" } }]))).rejects.toThrow(/crawl 200/);
    await expect(crawl("https://x.example", "k", sequence([{ body: { success: true, id: "j" } }, { body: { status: "completed", data: [page("https://x.example/", "")] } }])))
      .rejects.toThrow(/no readable pages/);
  });

  it("gives up when the job never completes", async () => {
    const f = sequence(Array.from({ length: 50 }, () => ({ body: { status: "scraping" } })));
    await expect(crawl("https://x.example", "k", sequence([{ body: { success: true, id: "j" } }, ...Array.from({ length: 50 }, () => ({ body: { status: "scraping" } }))]), { pollMs: 0, maxWaitMs: 0 }))
      .rejects.toThrow(/did not finish/);
    void f;
  });
});

describe("EXCLUDE_PATHS", () => {
  it("names the pages that are never what a business says, and nothing else", () => {
    const re = new RegExp(EXCLUDE_PATHS[0]);
    for (const p of ["/signin", "/login/", "/cart/123", "/account", "/search", "/tag/news", "/wp-login.php"]) expect(re.test(p)).toBe(true);
    for (const p of ["/", "/hours", "/pricing", "/services/catering", "/blog/tags-we-love", "/contact"]) expect(re.test(p)).toBe(false);
  });
});
