// STEALS: waggle rulings.test.ts (parser cases) via HTR tests/test_parse.py, plus the email quote strip.
import { describe, expect, test } from "vitest";
import { isEmpty, parseReply, stripQuoted, verdictFromMark, verdictFromReply } from "../convex/lib/rulings/parse";

describe("marks", () => {
  test("sign, reject, and ignore", () => {
    expect(verdictFromMark("✅")).toEqual({ kind: "sign" });
    expect(verdictFromMark("✔️")).toEqual({ kind: "sign" });
    expect(verdictFromMark(":white_check_mark:")).toEqual({ kind: "sign" });
    expect(verdictFromMark("yes")).toEqual({ kind: "sign" });
    expect(verdictFromMark("Yes.")).toEqual({ kind: "sign" });
    expect(verdictFromMark("❌")).toEqual({ kind: "reject" });
    expect(verdictFromMark("no")).toEqual({ kind: "reject" });
    expect(verdictFromMark("❤️")).toBeNull();
    expect(verdictFromMark("maybe tomorrow")).toBeNull();
  });

  test("a bare mark rules; anything else is an edit", () => {
    expect(verdictFromReply(" ✅ ")).toEqual({ kind: "sign" });
    expect(verdictFromReply("Actually say: on it, ETA 5pm")).toEqual({ kind: "edit", body: "Actually say: on it, ETA 5pm" });
    expect(verdictFromReply("   ")).toBeNull();
  });
});

describe("numbered replies", () => {
  test("one line per draft", () => {
    const p = parseReply("1 ✅\n2 no\n3 tell them Tuesday works\n4");
    expect(p.rulings).toEqual([
      { n: 1, verdict: { kind: "sign" } },
      { n: 2, verdict: { kind: "reject" } },
      { n: 3, verdict: { kind: "edit", body: "tell them Tuesday works" } },
      { n: 4, verdict: { kind: "sign" } },
    ]);
    expect(p.commands).toEqual([]);
    expect(p.unparsed).toEqual([]);
  });

  test("punctuation and a hash are fine", () => {
    const p = parseReply("#1: yes\n2. ❌\n3) 10am works for me");
    expect(p.rulings.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(p.rulings[2].verdict).toEqual({ kind: "edit", body: "10am works for me" });
  });

  test("windows line endings", () => {
    expect(parseReply("1\r\n2 no\r\n").rulings).toHaveLength(2);
  });
});

describe("commands", () => {
  test("all, later, hold, digest", () => {
    expect(parseReply("all").commands).toEqual([{ command: "all", arg: null }]);
    expect(parseReply("Later").commands).toEqual([{ command: "later", arg: null }]);
    expect(parseReply("hold").commands).toEqual([{ command: "hold", arg: null }]);
    expect(parseReply("hold until 9").commands).toEqual([{ command: "hold", arg: "9" }]);
    expect(parseReply("?").commands).toEqual([{ command: "digest", arg: null }]);
  });

  test("unparsed is reported, not guessed", () => {
    const p = parseReply("what does this mean");
    expect(isEmpty(p)).toBe(true);
    expect(p.unparsed).toEqual(["what does this mean"]);
  });
});

describe("email replies", () => {
  test("the quoted digest below the owner's words is not a ruling", () => {
    const mail = "1 yes\n2 no\n\nOn Thu, Sep 4, 2026 at 9:02 AM Hold the Room <ekko@agentmail.to> wrote:\n> 2 waiting on you.\n> 1 Marco (email): ...";
    expect(stripQuoted(mail)).toBe("1 yes\n2 no");
    const p = parseReply(stripQuoted(mail));
    expect(p.rulings).toHaveLength(2);
    expect(p.unparsed).toEqual([]);
  });

  test("a plain reply survives untouched", () => {
    expect(stripQuoted("all")).toBe("all");
  });
});
