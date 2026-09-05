import { describe, expect, test } from "vitest";
import { extractJson, normalizeBaseUrl, toDraft, userPayload, type DraftRequest } from "../convex/drafter";
import { chatCompletion, contentOf } from "../convex/lib/llm/openaiCompat";

describe("contentOf", () => {
  test("a plain completion", () => {
    expect(contentOf("application/json", JSON.stringify({ choices: [{ message: { content: "hi" } }] }))).toBe("hi");
  });

  test("a gateway that streams anyway", () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ].join("\n");
    expect(contentOf("text/event-stream; charset=utf-8", sse)).toBe("Hello");
  });

  test("chatCompletion posts the OpenAI shape and surfaces gateway errors", async () => {
    const calls: any[] = [];
    const ok: typeof fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"body\":\"x\"}" } }] }), { headers: { "content-type": "application/json" } });
    };
    const out = await chatCompletion({ baseUrl: "https://g.example/v1/", apiKey: "k", model: "m", messages: [{ role: "user", content: "u" }], json: true }, ok);
    expect(out).toBe('{"body":"x"}');
    expect(calls[0].url).toBe("https://g.example/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "m", stream: false, response_format: { type: "json_object" } });
    const bad: typeof fetch = async () => new Response("nope", { status: 502 });
    await expect(chatCompletion({ baseUrl: "https://g.example/v1", apiKey: "k", model: "m", messages: [] }, bad)).rejects.toThrow(/502/);
  });
});

describe("normalizeBaseUrl", () => {
  test("blank and OpenAI itself mean OpenAI's v1", () => {
    expect(normalizeBaseUrl(undefined)).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://api.openai.com/")).toBe("https://api.openai.com/v1");
  });

  test("a gateway gets a scheme and a /v1", () => {
    expect(normalizeBaseUrl("omniroute.felaniam.cloud")).toBe("https://omniroute.felaniam.cloud/v1");
    expect(normalizeBaseUrl("https://omniroute.felaniam.cloud/v1/")).toBe("https://omniroute.felaniam.cloud/v1");
    expect(normalizeBaseUrl("http://localhost:4000/api")).toBe("http://localhost:4000/api");
  });
});

const req: DraftRequest = {
  businessName: "Tony Myers", ownerName: "Tony", counterparty: "Marco", channel: "email",
  theirMessage: "Do you have a leather bag under $200? I need it by Friday.", prior: ["out: Thanks for stopping by."],
};

describe("toDraft", () => {
  test("takes JSON, keeps only quotes that are really in the source", () => {
    const d = toDraft('{"body":"Yes, the Harlow.","basis":["under $200","made up quote","Thanks for stopping by."]}', req);
    expect(d).toEqual({ body: "Yes, the Harlow.", basis: ["under $200", "Thanks for stopping by."] });
  });

  test("fenced JSON and plain text both work; no real basis falls back to their message", () => {
    expect(toDraft('```json\n{"body":"Sure."}\n```', req).body).toBe("Sure.");
    const d = toDraft("Just words, no JSON.", req);
    expect(d.body).toBe("Just words, no JSON.");
    expect(d.basis).toEqual([req.theirMessage]);
  });

  test("an empty draft is an error", () => {
    expect(() => toDraft('{"body":""}', req)).toThrow(/empty draft/);
    expect(extractJson("nope")).toBeNull();
  });
});

describe("userPayload", () => {
  const req: DraftRequest = {
    businessName: "Tony Myers", ownerName: "Tony", counterparty: "Marco", channel: "email",
    theirMessage: "Do you have a leather bag under $200?", prior: [],
  };
  test("no corrections yet: the key is null, not missing, so the model sees the shape", () => {
    expect(JSON.parse(userPayload(req)).owner_corrections).toBeNull();
  });
  test("the owner's corrections ride along as draft -> sent pairs", () => {
    const p = JSON.parse(userPayload({ ...req, lessons: [{ theirMessage: "under $200?", draft: "Yes, the Harlow, $185.", sent: "Yep, $185, come by." }] }));
    expect(p.owner_corrections).toEqual([{ their_message: "under $200?", first_draft: "Yes, the Harlow, $185.", owner_sent: "Yep, $185, come by." }]);
  });
});
