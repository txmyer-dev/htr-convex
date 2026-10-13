// The model gateway's base URL, repaired (moved from drafter.ts 2026-10-13; drafter re-exports it).

export const OPENAI_DEFAULT = "https://api.openai.com/v1";

/**
 * OPENAI_BASE_URL as people actually write it: blank, a bare host, no scheme, no /v1, a
 * trailing slash. Always returns a full URL: the SDK reads the raw env var itself when given
 * nothing, which is exactly the value being repaired here.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  let s = (raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return OPENAI_DEFAULT;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/v1";
  return u.toString().replace(/\/+$/, "");
}

