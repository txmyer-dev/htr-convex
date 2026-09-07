// The pages a counterparty points at. "Can you quote this?" with a link is a question about
// what is behind the link, so the drafter reads it (Firecrawl, at draft time) and the reply can
// rest on it. Pure: which URLs in a message are worth reading. Images, mail links, unsubscribe
// and tracking links, and our own ruling links are not; at most a couple per message, in order.

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/gi;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)(\?|$)/i;
const NOISE = /unsubscribe|list-manage|mailtrack|click\.|\/track\/|\/t\/|utm_|\/rulings\//i;

export function linksIn(text: string, max = 2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?)\]]+$/, "");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (IMAGE.test(u.pathname) || NOISE.test(url)) continue;
    const key = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
