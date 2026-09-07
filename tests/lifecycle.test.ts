import { describe, expect, test } from "vitest";
import { canMove, STATUSES, summarize, TERMINAL, TRANSITIONS } from "../convex/lib/proposals/lifecycle";

describe("lifecycle", () => {
  test("the happy path and the two dead ends", () => {
    expect(canMove("pending", "signed")).toBe(true);
    expect(canMove("signed", "sending")).toBe(true);
    expect(canMove("sending", "sent")).toBe(true);
    expect(canMove("pending", "rejected")).toBe(true);
    expect(canMove("pending", "expired")).toBe(true);
    expect(canMove("pending", "superseded")).toBe(true);
  });

  test("signing twice, or after a rejection, is not a move", () => {
    expect(canMove("signed", "signed")).toBe(false);
    expect(canMove("rejected", "signed")).toBe(false);
    expect(canMove("sent", "sending")).toBe(false);
  });

  test("a failed send goes back to signed and nowhere else", () => {
    expect(TRANSITIONS.failed).toEqual(["signed"]);
    expect(canMove("failed", "sent")).toBe(false);
  });

  test("a sent site request can go live; a sent email stays sent", () => {
    expect(canMove("sent", "live")).toBe(true);
    expect(canMove("live", "sent")).toBe(false);
    expect(TRANSITIONS.sent).toEqual(["live", "signed"]);
  });

  test("terminal states have no exits", () => {
    for (const s of TERMINAL) expect(TRANSITIONS[s]).toEqual([]);
    for (const s of STATUSES) if (!TERMINAL.has(s)) expect(TRANSITIONS[s].length).toBeGreaterThan(0);
    expect(TERMINAL.has("sent")).toBe(false); // an email is done at sent, but the status graph lets a site request go on
  });

  test("summaries name the person and trim the body", () => {
    expect(summarize("Sam", "sam@x.com", "hello")).toBe("Reply to Sam: “hello”");
    expect(summarize("your website", "web@x.com", "Please add this", "site")).toBe("Website update: “Please add this”");
    expect(summarize(null, "sam@x.com", "a  very\nlong " + "x".repeat(80))).toMatch(/^Reply to sam@x.com: “a very long x+…”$/);
  });
});
