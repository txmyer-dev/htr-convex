// A fact the owner taught the room, on its way to the website.
//
// The site is the first brain and the owner's facts are the second; a fact the site does not
// say is a site that is behind. HTR does not touch the site. It writes to the web agent, the one
// that does, and that is a proposal like any other: the owner rules it, the request goes out
// signed, the agent replies when the page is live, and Firecrawl reads the site again to see
// that it is. This module is the pure part: the request, its subject, its signature header,
// and the check that a page now says what the fact says.

import { terms } from "../knowledge/rank";

/** The header on the request: `<slug>:<proposalId>:<token>`, so the web agent acts only on HTR. */
export const SITE_HEADER = "x-htr-site";

export const SITE_NAME = "your website"; // who a site proposal is "to", on the card and in the digest

export function hostOf(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, "");
  } catch {
    return site;
  }
}

/** What HTR asks the web agent to do. Plain, so a person copied on it can read it too. */
export function siteRequest(site: string, statement: string): string {
  return `Please add this to ${hostOf(site)}, where it belongs, in the site's own voice:\n\n${statement}\n\nReply in this thread when it is live.`;
}

export function siteSubject(site: string, statement: string): string {
  const short = statement.replace(/\s+/g, " ").trim();
  return `Update ${hostOf(site)}: ${short.length > 60 ? `${short.slice(0, 59).trimEnd()}…` : short}`;
}

/**
 * Does a page now say what the fact says? Most of the fact's words on one page (numbers and
 * names count the same as any other word). Returns that page's URL, or null.
 */
export function saysOnSite(statement: string, pages: Array<{ url: string; markdown: string }>, share = 0.6): string | null {
  const words = terms(statement);
  if (words.length === 0) return null;
  const need = Math.max(1, Math.ceil(words.length * share));
  for (const p of pages) {
    const text = p.markdown.toLowerCase();
    let hits = 0;
    for (const w of words) if (text.includes(w)) hits++;
    if (hits >= need) return p.url;
  }
  return null;
}
