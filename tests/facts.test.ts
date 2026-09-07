// The second brain's pure parts: a distilled statement from the model's JSON, and which text a fact reads as.
import { describe, expect, test } from "vitest";
import { factText, toStatement } from "../convex/facts";

describe("toStatement", () => {
  test("a statement, squashed and capped; null and none mean no fact", () => {
    expect(toStatement('{"statement":"  Dogs are welcome.\\n There is a garage on 4th Street. "}')).toBe("Dogs are welcome. There is a garage on 4th Street.");
    expect(toStatement('{"statement":null}')).toBeNull();
    expect(toStatement('{"statement":"none"}')).toBeNull();
    expect(toStatement("not json")).toBeNull();
    expect(toStatement(`{"statement":"${"y".repeat(700)}"}`)).toHaveLength(600);
  });
});

describe("factText", () => {
  test("the statement when distilled, else the owner's words", () => {
    expect(factText({ answer: "Hi Sam, dogs are welcome. Tony", statement: "Dogs are welcome." })).toBe("Dogs are welcome.");
    expect(factText({ answer: "Hi Sam, dogs are welcome. Tony" })).toBe("Hi Sam, dogs are welcome. Tony");
  });
});
