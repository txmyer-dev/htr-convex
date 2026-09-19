// The two secrets are not interchangeable. The web agent on the VPS holds a copy of the site
// secret; the ruling secret signs Send / Skip links and derives every surface key. If they were
// ever the same value, an agent that edits one website could rule the room.

import { afterEach, describe, expect, test } from "vitest";
import { siteSecret } from "../convex/surface";

const before = { site: process.env.HTR_SITE_SECRET, ruling: process.env.HTR_RULING_SECRET };
afterEach(() => {
  process.env.HTR_SITE_SECRET = before.site;
  process.env.HTR_RULING_SECRET = before.ruling;
});

describe("the site secret", () => {
  test("missing is a refusal, not a fallback to the ruling secret", () => {
    process.env.HTR_RULING_SECRET = "ruling-secret";
    delete process.env.HTR_SITE_SECRET;
    expect(() => siteSecret()).toThrow(/HTR_SITE_SECRET is not set/);
  });

  test("the ruling secret's own value is refused", () => {
    process.env.HTR_RULING_SECRET = "ruling-secret";
    process.env.HTR_SITE_SECRET = "ruling-secret";
    expect(() => siteSecret()).toThrow(/must not be the ruling secret/);
  });

  test("its own value is what signs a site request", () => {
    process.env.HTR_RULING_SECRET = "ruling-secret";
    process.env.HTR_SITE_SECRET = "site-secret";
    expect(siteSecret()).toBe("site-secret");
  });
});
