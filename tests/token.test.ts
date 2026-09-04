import { describe, expect, test } from "vitest";
import { rulingLinks, rulingToken, tokenEquals, verifyRulingToken } from "../convex/lib/rulings/token";

describe("ruling tokens", () => {
  test("bind tenant, proposal, and verdict", async () => {
    const t = await rulingToken("s3cret", "tony", "p1", "sign");
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyRulingToken("s3cret", "tony", "p1", "sign", t)).toBe(true);
    expect(await verifyRulingToken("s3cret", "tony", "p1", "reject", t)).toBe(false);
    expect(await verifyRulingToken("s3cret", "tony", "p2", "sign", t)).toBe(false);
    expect(await verifyRulingToken("other", "tony", "p1", "sign", t)).toBe(false);
  });

  test("compare is length-safe", () => {
    expect(tokenEquals("abc", "abc")).toBe(true);
    expect(tokenEquals("abc", "abd")).toBe(false);
    expect(tokenEquals("abc", "ab")).toBe(false);
  });

  test("links carry the token", async () => {
    const links = await rulingLinks("https://x.convex.site/rulings", "s3cret", "tony", "p1");
    expect(links.sign).toBe(`https://x.convex.site/rulings/tony/p1/sign?t=${await rulingToken("s3cret", "tony", "p1", "sign")}`);
    expect(links.reject).toContain("/reject?t=");
  });
});
