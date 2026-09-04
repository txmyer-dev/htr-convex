// An OpenAI-compatible chat completion over fetch (STEALS: HTR adapters/llm_openai_compat.py).
// No SDK: the official client uses URL features the Convex runtime does not implement, and the
// wire shape is small. Handles a gateway that streams regardless of `stream: false` by
// concatenating the content deltas of an SSE body (reasoning deltas are not content).

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatRequest = {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  json?: boolean; // ask for a JSON object
};

export function contentOf(contentType: string, text: string): string {
  if (!/text\/event-stream/i.test(contentType)) {
    const data = JSON.parse(text);
    return String(data?.choices?.[0]?.message?.content ?? "");
  }
  const parts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("data:")) continue;
    const data = raw.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    for (const choice of chunk?.choices ?? []) {
      const piece = choice?.delta?.content ?? choice?.message?.content;
      if (piece) parts.push(String(piece));
    }
  }
  return parts.join("");
}

export async function chatCompletion(req: ChatRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${req.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${req.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      stream: false,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`model gateway ${res.status}: ${text.slice(0, 300)}`);
  return contentOf(res.headers.get("content-type") ?? "", text);
}
