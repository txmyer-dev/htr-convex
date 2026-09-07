// From the room to the site, the pure part: the request, its subject, and whether a page says it.
import { describe, expect, test } from "vitest";
import { siteToken } from "../convex/lib/rulings/token";
import { saysOnSite, siteRequest, siteSubject } from "../convex/lib/site/publish";

describe("the request", () => {
  test("says where, what, and how to answer", () => {
    const r = siteRequest("https://www.felaniam.cloud", "Dogs are welcome at the office.");
    expect(r).toBe("Please add this to felaniam.cloud, where it belongs, in the site's own voice:\n\nDogs are welcome at the office.\n\nReply in this thread when it is live.");
    expect(siteSubject("https://felaniam.cloud", "Dogs are welcome at the office.")).toBe("Update felaniam.cloud: Dogs are welcome at the office.");
    expect(siteSubject("https://felaniam.cloud", "x".repeat(80))).toBe(`Update felaniam.cloud: ${"x".repeat(59)}…`);
  });

  test("the site token binds tenant and proposal and differs from a ruling token", async () => {
    const a = await siteToken("s", "tony", "p1");
    expect(a).toHaveLength(32);
    expect(await siteToken("s", "tony", "p1")).toBe(a);
    expect(await siteToken("s", "tony", "p2")).not.toBe(a);
    expect(await siteToken("s", "demo", "p1")).not.toBe(a);
  });
});

describe("saysOnSite", () => {
  const pages = [
    { url: "https://f.cloud/", markdown: "Felaniam. Systems that read everything." },
    { url: "https://f.cloud/visit", markdown: "Visiting: dogs are welcome at the office, and there is a garage on 4th Street a block away." },
  ];
  test("the page that carries most of the fact's words, or nothing", () => {
    expect(saysOnSite("Dogs are welcome at the office; there is a garage on 4th Street a block away.", pages)).toBe("https://f.cloud/visit");
    expect(saysOnSite("Saturday hours are 9 to 2.", pages)).toBeNull();
    expect(saysOnSite("", pages)).toBeNull();
  });
});
