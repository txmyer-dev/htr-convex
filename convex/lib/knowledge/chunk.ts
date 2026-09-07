// A page as pieces small enough to retrieve one at a time. Paragraphs and headings are the
// seams; pieces are joined up to `size` characters, and a run of text with no seam is cut at
// `size` with a little overlap so a sentence on the cut is in both pieces. The heading a piece
// sits under is kept in front of it, so "Sat 10–4" still says it is about hours.

export type Chunk = { text: string; heading?: string };

export function chunkMarkdown(markdown: string, size = 900, overlap = 120): Chunk[] {
  const out: Chunk[] = [];
  let heading: string | undefined;
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) out.push({ text: heading && !t.startsWith(heading) ? `${heading}\n${t}` : t, heading });
    cur = "";
  };
  for (const block of markdown.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const h = /^#{1,6}\s+(.+)$/.exec(b.split("\n")[0]);
    if (h && b.split("\n").length === 1) {
      flush();
      heading = h[1].trim();
      continue;
    }
    if (b.length > size) {
      flush();
      for (let i = 0; i < b.length; i += size - overlap) {
        cur = b.slice(i, i + size);
        flush();
        if (i + size >= b.length) break;
      }
      continue;
    }
    if (cur.length + b.length + 2 > size) flush();
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  flush();
  return out;
}

/** The chunks the drafter reads, grouped under their page, within a budget. Returns the text and the pages used. */
export function notesFromChunks<T extends { url: string; title?: string; text: string }>(chunks: T[], budget = 12_000): { text: string; used: string[] } | undefined {
  if (chunks.length === 0) return undefined;
  const byUrl = new Map<string, { title?: string; parts: string[] }>();
  for (const c of chunks) {
    const g = byUrl.get(c.url) ?? { title: c.title, parts: [] };
    g.parts.push(c.text);
    byUrl.set(c.url, g);
  }
  let out = "";
  const used: string[] = [];
  for (const [url, g] of byUrl) {
    const block = `# ${g.title ?? url} (${url})\n${g.parts.join("\n…\n")}\n\n`;
    if (out.length + block.length > budget) {
      const room = budget - out.length;
      if (room > 200) {
        out += block.slice(0, room);
        used.push(url);
      }
      break;
    }
    out += block;
    used.push(url);
  }
  const text = out.trim();
  return text ? { text, used } : undefined;
}
