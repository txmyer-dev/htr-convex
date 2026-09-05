import { describe, expect, test } from "vitest";
import { MAX_CHARS, toLessons } from "../convex/lib/drafter/lessons";

describe("toLessons", () => {
  test("keeps real corrections, newest first, at most five", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ theirMessage: `q${i}`, draft: `draft ${i}`, sent: `sent ${i}` }));
    const out = toLessons(rows);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ theirMessage: "q0", draft: "draft 0", sent: "sent 0" });
  });

  test("nothing to learn from is dropped: empty sides, or words that differ only by whitespace", () => {
    expect(toLessons([
      { theirMessage: "q", draft: "Hi Sam,\n\nYes.", sent: "Hi Sam, Yes." },
      { theirMessage: "q", draft: "", sent: "words" },
      { theirMessage: "q", draft: "words", sent: "   " },
      { draft: "a", sent: "b" },
    ])).toEqual([{ theirMessage: "", draft: "a", sent: "b" }]);
  });

  test("each side is clipped", () => {
    const long = "x".repeat(MAX_CHARS * 2);
    const [l] = toLessons([{ theirMessage: long, draft: long, sent: "short" }]);
    expect(l.draft.length).toBe(MAX_CHARS);
    expect(l.theirMessage.endsWith("\u2026")).toBe(true);
  });
});
