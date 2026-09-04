// The signature on a ruling link (STEALS: HTR rulings/controller.py ruling_token). A leaked
// digest cannot rule on anything else, and cannot rule the other way: the token binds tenant,
// proposal, and verdict. Web Crypto, so it runs in Convex, in the browser, and in tests.

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type LinkVerdict = "sign" | "reject" | "edit";

export async function rulingToken(secret: string, tenantId: string, proposalId: string, verdict: LinkVerdict): Promise<string> {
  return (await hmacHex(secret, `${tenantId}:${proposalId}:${verdict}`)).slice(0, 32);
}

/** Constant-time compare of two short hex strings. */
export function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyRulingToken(
  secret: string,
  tenantId: string,
  proposalId: string,
  verdict: LinkVerdict,
  token: string,
): Promise<boolean> {
  return tokenEquals(await rulingToken(secret, tenantId, proposalId, verdict), token);
}

/** The Send / Skip URLs for one proposal. `base` is the public ruling endpoint, no trailing slash. */
export async function rulingLinks(
  base: string,
  secret: string,
  tenantId: string,
  proposalId: string,
): Promise<{ sign: string; reject: string; edit: string }> {
  const url = async (v: LinkVerdict) =>
    `${base}/${encodeURIComponent(tenantId)}/${encodeURIComponent(proposalId)}/${v}?t=${await rulingToken(secret, tenantId, proposalId, v)}`;
  return { sign: await url("sign"), reject: await url("reject"), edit: await url("edit") };
}
