import { describe, expect, test } from "vitest";
import { chunkMarkdown, notesFromChunks } from "../convex/lib/knowledge/chunk";
import { embed } from "../convex/lib/llm/embed";

describe("chunkMarkdown", () => {
  test("paragraphs join up to the size; headings ride in front of what sits under them", () => {
    const md = "# Hours\n\nSat 10 to 4.\n\nSun closed.\n\n# Prices\n\nBags from $60.";
    expect(chunkMarkdown(md, 900)).toEqual([
      { text: "Hours\nSat 10 to 4.\n\nSun closed.", heading: "Hours" },
      { text: "Prices\nBags from $60.", heading: "Prices" },
    ]);
  });

  test("a long run is cut with overlap; small pieces fill to the size", () => {
    const long = "x".repeat(2000);
    const pieces = chunkMarkdown(long, 900, 100);
    expect(pieces.length).toBe(3);
    expect(pieces[0].text).toHaveLength(900);
    expect(pieces[1].text.slice(0, 100)).toBe(pieces[0].text.slice(800));
    expect(chunkMarkdown("a\n\nb\n\nc", 900)).toEqual([{ text: "a\n\nb\n\nc", heading: undefined }]);
    expect(chunkMarkdown("   ")).toEqual([]);
  });
});

describe("notesFromChunks", () => {
  test("grouped under the page, in order, within the budget, naming the pages used", () => {
    const n = notesFromChunks([
      { url: "https://s.example/pricing", title: "Pricing", text: "Scale $599." },
      { url: "https://s.example/", text: "The Shop." },
      { url: "https://s.example/pricing", title: "Pricing", text: "Starter $19." },
    ])!;
    expect(n.text).toBe("# Pricing (https://s.example/pricing)\nScale $599.\n…\nStarter $19.\n\n# https://s.example/ (https://s.example/)\nThe Shop.");
    expect(n.used).toEqual(["https://s.example/pricing", "https://s.example/"]);
    expect(notesFromChunks([])).toBeUndefined();
    const tight = notesFromChunks([{ url: "a", text: "x".repeat(300) }, { url: "b", text: "y".repeat(300) }], 320)!;
    expect(tight.used).toEqual(["a"]);
  });
});

describe("embed", () => {
  test("one request, vectors back in input order, sizes checked", async () => {
    const calls: any[] = [];
    const vec = (n: number) => Array.from({ length: 1536 }, () => n);
    const ok: typeof fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] }));
    };
    const out = await embed(["a", "b"], { baseUrl: "https://g.example/v1", apiKey: "k", model: "m" }, ok);
    expect(out.map((v) => v[0])).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({ url: "https://g.example/v1/embeddings", body: { model: "m", input: ["a", "b"] } });
    expect(await embed([], { baseUrl: "x", apiKey: "k", model: "m" }, ok)).toEqual([]);
    const short: typeof fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(embed(["a"], { baseUrl: "x", apiKey: "k", model: "m" }, short)).rejects.toThrow(/wrong size/);
  });
});
