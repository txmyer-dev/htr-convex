import { describe, expect, test } from "vitest";
import { linksIn } from "../convex/lib/knowledge/links";

describe("linksIn", () => {
  test("the pages they point at, in order, without noise", () => {
    const text = "Can you quote this? https://shop.example/products/bag-42. And this one (https://shop.example/products/wallet)!\n" +
      "Logo: https://shop.example/logo.png https://mail.example/unsubscribe?u=1 https://shop.example/products/bag-42?utm_source=x";
    expect(linksIn(text)).toEqual(["https://shop.example/products/bag-42", "https://shop.example/products/wallet"]);
  });

  test("at most a couple; duplicates and trailing punctuation handled; none is fine", () => {
    expect(linksIn("a https://a.example/x, https://a.example/x/ and https://b.example https://c.example", 3)).toEqual(["https://a.example/x", "https://b.example", "https://c.example"]);
    expect(linksIn("no links here")).toEqual([]);
    expect(linksIn("https://test.convex.site/rulings/tony/abc/sign?t=1")).toEqual([]);
  });
});
