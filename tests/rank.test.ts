import { describe, expect, test } from "vitest";
import { rankPages, terms } from "../convex/lib/knowledge/rank";

const page = (url: string, markdown: string, title?: string) => ({ url, title, markdown });

describe("terms", () => {
  test("keeps the words that could match a page, singular", () => {
    expect(terms("Hi! Which plan fits, and what does it cost? Plans for 50,000 pages")).toEqual(["plan", "fit", "cost", "000", "page"]);
  });
});

describe("rankPages", () => {
  const home = page("https://s.example", "Welcome to the shop.", "Shop");
  const blog = page("https://s.example/blog", "Our blog. Plans for the summer. Pricing musings. Hours of fun.", "Blog");
  const pricing = page("https://s.example/pricing", "Plans: Starter $19. Scale $599 per month. Cost per page falls with volume.", "Pricing");
  const hours = page("https://s.example/hours", "Open Saturday 10 to 4.", "Hours");

  test("the homepage first, then the pages that name what was asked", () => {
    expect(rankPages([blog, pricing, hours, home], "Which plan fits and what does it cost?").map((p) => p.url))
      .toEqual([home.url, pricing.url, blog.url, hours.url]);
    expect(rankPages([blog, pricing, hours, home], "Are you open Saturday?").map((p) => p.url))
      .toEqual([home.url, hours.url, blog.url, pricing.url]);
  });

  test("nothing asked: by URL, homepage first", () => {
    expect(rankPages([pricing, hours, home, blog], "").map((p) => p.url)).toEqual([home.url, blog.url, hours.url, pricing.url]);
    expect(rankPages([home], "x")).toEqual([home]);
  });
});
