// Whose site is worth reading, and how a draft says what it rested on.

import { describe, expect, it } from "vitest";
import { describeGrounding, hostOf, senderSite } from "../convex/lib/knowledge/domain";

describe("senderSite", () => {
  it("a company address names a site", () => {
    expect(senderSite("sam@acme.com")).toBe("https://acme.com");
    expect(senderSite("Sam@Mail.Acme.com")).toBe("https://acme.com");
    expect(senderSite("sam@shop.example.co.uk")).toBe("https://example.co.uk");
  });

  it("webmail, our own domain, and reserved names say nothing", () => {
    for (const a of ["sam@gmail.com", "sam@outlook.com", "sam@icloud.com", "sam@proton.me", "room-1@agentmail.to", "sam@example.com", "sam@corp.local"]) {
      expect(senderSite(a), a).toBeNull();
    }
  });

  it("garbage is not a site", () => {
    expect(senderSite("nobody")).toBeNull();
    expect(senderSite("sam@localhost")).toBeNull();
    expect(senderSite("sam@bad domain.com")).toBeNull();
  });
});

describe("describeGrounding", () => {
  it("names the site and the sender by host, once each", () => {
    const g = {
      site: [{ url: "https://www.sams-bakery.com/", fetchedAt: 1 }, { url: "https://sams-bakery.com/hours", fetchedAt: 1 }],
      sender: { url: "https://acme.com/", title: "Acme", fetchedAt: 1 },
    };
    expect(describeGrounding(g)).toBe("Drafted from your site (sams-bakery.com) and who they are (acme.com).");
    expect(describeGrounding({ sender: g.sender })).toBe("Drafted from who they are (acme.com).");
    expect(describeGrounding({ site: [] })).toBeNull();
    expect(describeGrounding(null)).toBeNull();
  });

  it("hostOf survives a non-URL", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});
