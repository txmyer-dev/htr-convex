// AgentMail signs webhooks with Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>",
// keyed by the base64 secret after "whsec_", sent as "v1,<base64>" (several may be space
// separated). Web Crypto only, so this runs in a Convex HTTP action and in tests.

const enc = new TextEncoder();

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function svixSign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey("raw", b64decode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`));
  return `v1,${b64encode(sig)}`;
}

export type SvixHeaders = { "svix-id"?: string; "svix-timestamp"?: string; "svix-signature"?: string };

export async function svixVerify(
  secret: string,
  headers: SvixHeaders,
  body: string,
  nowMs = Date.now(),
  toleranceMs = 5 * 60_000,
): Promise<boolean> {
  const id = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigs = headers["svix-signature"];
  if (!id || !ts || !sigs) return false;
  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > toleranceMs) return false;
  const expected = await svixSign(secret, id, ts, body);
  return sigs.split(" ").some((s) => s.startsWith("v1,") && constantEquals(s, expected));
}

function constantEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
