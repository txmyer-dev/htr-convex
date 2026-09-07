// Which pages of the site to put in front of the drafter, when they will not all fit.
//
// No embeddings yet: a message and a page share words or they do not. Each page scores the
// number of distinct words from the message it contains (a hit in the title or URL counts
// triple, since "pricing" in a URL is a stronger sign than "pricing" in a footer). The homepage
// always comes first: it is what the business says about itself. Ties keep the shorter URL first.

const STOP = new Set([
  "the", "and", "for", "you", "your", "are", "with", "that", "this", "have", "has", "from", "can", "our", "what", "which",
  "does", "about", "how", "much", "any", "all", "not", "but", "was", "were", "will", "would", "could", "should", "they", "them",
  "there", "here", "when", "where", "who", "why", "just", "like", "get", "got", "also", "into", "out", "than", "then", "some",
  "one", "two", "per", "month", "week", "day", "hi", "hello", "hey", "thanks", "thank", "please", "best", "regards", "subject",
]);

export function terms(text: string): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    seen.add(w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w); // plans / plan, fits / fit, hours / hour
  }
  return [...seen];
}

export type Rankable = { url: string; title?: string; markdown: string };

export function score(page: Rankable, words: string[]): number {
  if (words.length === 0) return 0;
  const head = `${page.title ?? ""} ${page.url}`.toLowerCase();
  const body = page.markdown.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (head.includes(w)) s += 3;
    else if (body.includes(w)) s += 1;
  }
  return s;
}

/** The homepage first, then the pages that share the most words with the message, then the rest by URL. */
export function rankPages<T extends Rankable>(pages: T[], query: string): T[] {
  if (pages.length <= 1) return [...pages];
  const byUrl = [...pages].sort((a, b) => a.url.length - b.url.length || (a.url < b.url ? -1 : 1));
  const [home, ...rest] = byUrl;
  const words = terms(query);
  const scored = rest.map((p, i) => ({ p, s: score(p, words), i }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return [home, ...scored.map((x) => x.p)];
}
