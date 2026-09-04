// Firecrawl in: what gets to count as what the business says.

import { describe, expect, it } from "vitest";
import { scrape } from "../convex/knowledge";

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
