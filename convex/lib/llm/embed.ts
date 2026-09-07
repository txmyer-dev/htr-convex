// Embeddings over the same OpenAI-compatible endpoint the drafter uses. One call, many texts.

export type EmbedOptions = { baseUrl: string; apiKey: string; model: string };

export const EMBED_DEFAULT_MODEL = "text-embedding-3-small"; // 1536 dimensions, the chunks table's vector index
export const EMBED_DIMENSIONS = 1536;

export async function embed(texts: string[], o: EmbedOptions, fetchImpl: typeof fetch = fetch): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetchImpl(`${o.baseUrl}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: o.model, input: texts }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: Array<{ index?: number; embedding?: number[] }> };
  const rows = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== texts.length) throw new Error(`embeddings: asked for ${texts.length}, got ${rows.length}`);
  return rows.map((r) => {
    if (!Array.isArray(r.embedding) || r.embedding.length !== EMBED_DIMENSIONS) throw new Error(`embeddings: wrong size ${r.embedding?.length}`);
    return r.embedding;
  });
}
