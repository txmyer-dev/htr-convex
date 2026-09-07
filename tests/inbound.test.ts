// The shape of an address as mail clients actually write it, and AgentMail's footer.

import { describe, expect, it } from "vitest";
import { parseAddress, stripFooter } from "../convex/lib/mail/inbound";

describe("parseAddress", () => {
  it("a bare address is itself, every character of it", () => {
    expect(parseAddress("room-1-cvve@agentmail.to")).toEqual({ address: "room-1-cvve@agentmail.to" });
    expect(parseAddress("<Tony@Example.com>")).toEqual({ address: "tony@example.com" });
    expect(parseAddress("  sam@x.com  ")).toEqual({ address: "sam@x.com" });
  });

  it("a display name comes along, quoted or not", () => {
    expect(parseAddress("Sam Lee <sam@x.com>")).toEqual({ name: "Sam Lee", address: "sam@x.com" });
    expect(parseAddress('"Lee, Sam" <sam@x.com>')).toEqual({ name: "Lee, Sam", address: "sam@x.com" });
    expect(parseAddress("<sam@x.com>")).toEqual({ address: "sam@x.com" });
  });
});

describe("stripFooter", () => {
  it("drops AgentMail's signature and nothing else", () => {
    expect(stripFooter("Are you open?\n\n--\nSent via AgentMail")).toBe("Are you open?");
    expect(stripFooter("Are you open?\n--\nSent via AgentMail\n")).toBe("Are you open?");
    expect(stripFooter("Are you open?\n-- \nSam")).toBe("Are you open?\n-- \nSam");
  });
});
