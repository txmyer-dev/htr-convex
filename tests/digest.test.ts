// STEALS: HTR tests/test_digest.py.
import { describe, expect, test } from "vitest";
import { GAP_LINE, HELP_LINE, MAX_CHARS, renderDigest, segments, type DigestItem } from "../convex/lib/digest/render";
import { holdNotice, isOverdue } from "../convex/lib/digest/expiry";

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  toAddress: "sam@example.com",
  body: "Hi there, thanks for your message. Tony will get back to you shortly.",
  basis: ["Are you open Saturday?"],
  kind: "email",
  ...over,
});

describe("renderDigest", () => {
  test("numbers lines and shows who, channel, deadline", () => {
    const now = Date.UTC(2026, 8, 3, 20, 0); // Thu Sep 3 2026, 15:00 Chicago
    const a = item({
      toAddress: "marco@example.com", toName: "Marco",
      body: "Yes, the Harlow, $185. Want it held?",
      basis: ["does the shop have a leather bag under $200? I need it by Friday"],
      sourceKind: "call_message", deadline: Date.UTC(2026, 8, 4, 22, 0),
    });
    const b = item({ sourceKind: "email" });
    const text = renderDigest([[1, a], [2, b]], { timeZone: "America/Chicago", nowMs: now });
    const lines = text.split("\n");
    expect(lines[0]).toBe("2 waiting on you.");
    expect(lines[2].startsWith('1 Marco (call, Fri): "does the shop have a leather bag')).toBe(true);
    expect(lines[2]).toContain("→ Yes, the Harlow");
    expect(lines[3].startsWith('2 sam@example.com (email): "Are you open Saturday?" →')).toBe(true);
    expect(lines.at(-1)).toBe(HELP_LINE);
  });

  test("a gap is named on the line and explained once at the foot", () => {
    const text = renderDigest([[1, item({ gap: "Saturday opening hours" })], [2, item()]]);
    const lines = text.split("\n");
    expect(lines[2]).toContain("→ Hi there, thanks for your message. Tony will get back to you shortly. · you haven't told me: Saturday opening hours");
    expect(lines[3]).not.toContain("you haven't told me");
    expect(lines.at(-2)).toBe(HELP_LINE);
    expect(lines.at(-1)).toBe(GAP_LINE);
    expect(renderDigest([[1, item()]])).not.toContain(GAP_LINE);
  });

  test("a deadline today says today; far away says the date", () => {
    const now = Date.UTC(2026, 8, 3, 12, 0);
    const today = renderDigest([[1, item({ deadline: Date.UTC(2026, 8, 3, 22, 0) })]], { timeZone: "America/New_York", nowMs: now });
    expect(today).toContain("(email, today)");
    const far = renderDigest([[1, item({ deadline: Date.UTC(2026, 9, 20, 21, 0) })]], { timeZone: "America/New_York", nowMs: now });
    expect(far).toContain("(email, Oct 20)");
  });

  test("caps length and counts the tail", () => {
    const items: Array<[number, DigestItem]> = [];
    for (let n = 1; n <= 20; n++) items.push([n, item({ toAddress: `p${n}@x.com`, body: "x".repeat(150), basis: ["y".repeat(80)] })]);
    const text = renderDigest(items);
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(text).toMatch(/…and \d+ more/);
  });

  test("empty", () => {
    expect(renderDigest([])).toBe("Nothing waiting on you.");
  });
});

describe("segments", () => {
  test("splits on lines and hard-splits long lines", () => {
    const text = "1 short\n2 " + "a".repeat(200) + "\n3 short";
    const segs = segments(text, 160);
    expect(segs.every((s) => s.length <= 160)).toBe(true);
    expect(segs[0].startsWith("1 short")).toBe(true);
    expect(segs.at(-1)!.endsWith("3 short")).toBe(true);
    expect(segments("one\ntwo", 160)).toEqual(["one\ntwo"]);
  });
});

describe("expiry", () => {
  test("only pending drafts with a passed deadline are overdue", () => {
    const now = 1_000_000;
    expect(isOverdue({ status: "pending", deadline: 999_999 }, now)).toBe(true);
    expect(isOverdue({ status: "pending", deadline: 1_000_001 }, now)).toBe(false);
    expect(isOverdue({ status: "pending", deadline: null }, now)).toBe(false);
    expect(isOverdue({ status: "signed", deadline: 1 }, now)).toBe(false);
  });

  test("the hold notice speaks as the business and discloses when asked", () => {
    const t = { displayName: "Tony Myers", owner: { name: "Tony", discloseAssistant: true } };
    expect(holdNotice(t)).toBe(
      "Hi, this is Tony Myers. Tony has seen your message and will reply personally as soon as possible. (This is an automated note from their assistant.)",
    );
    expect(holdNotice({ ...t, owner: { ...t.owner, discloseAssistant: false } })).not.toContain("automated");
  });
});
