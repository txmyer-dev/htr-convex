// Which senders have a site worth reading. A person writing from a company address has a domain
// that says who they are; a person writing from webmail does not, and reading gmail.com would
// tell the drafter nothing. The AgentMail domain is ours: demo customers write from it.

const WEBMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "pm.me", "zoho.com", "gmx.com",
  "gmx.net", "mail.com", "fastmail.com", "hey.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "agentmail.to",
]);

/** The site to read for a sender, or null when the address says nothing about where they work. */
export function senderSite(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".") || /[^a-z0-9.-]/.test(domain)) return null;
  if (WEBMAIL.has(domain)) return null;
  if (domain.endsWith(".local") || domain.endsWith(".test") || domain.endsWith(".invalid") || domain === "example.com") return null;
  // The registrable part: mail.acme.com writes as acme.com. Two-part public suffixes (co.uk) keep three labels.
  const labels = domain.split(".");
  const keep = labels.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 2]) ? 3 : 2;
  return `https://${labels.slice(-keep).join(".")}`;
}

/** The domain a page came from, for the card: "acme.com". */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export type Grounding = {
  site?: Array<{ url: string; title?: string; fetchedAt: number }>;
  sender?: { url: string; title?: string; fetchedAt: number };
  facts?: Array<{ question?: string; at: number }>;
  links?: Array<{ url: string; title?: string; fetchedAt: number }>;
} | null | undefined;

/** One line for the card: what Firecrawl put in front of the drafter. Null when nothing was. */
export function describeGrounding(g: Grounding): string | null {
  if (!g) return null;
  const parts: string[] = [];
  if (g.site && g.site.length) parts.push(`your site (${[...new Set(g.site.map((p) => hostOf(p.url)))].join(", ")})`);
  if (g.sender) parts.push(`who they are (${hostOf(g.sender.url)})`);
  if (g.links && g.links.length) parts.push(g.links.length === 1 ? `the page they sent (${hostOf(g.links[0].url)})` : `the ${g.links.length} pages they sent`);
  if (g.facts && g.facts.length) parts.push(g.facts.length === 1 ? "one thing you told me" : `${g.facts.length} things you told me`);
  if (parts.length === 0) return null;
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts.join(" and ");
  return `Drafted from ${list}.`;
}
