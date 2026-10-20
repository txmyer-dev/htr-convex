// The owner's own Gmail as the mail claw (adapters.mail: { kind: "gmail" }). Unlike AgentMail it
// doesn't call in: a cron pulls the inbox, and each message lands in the same transaction an
// AgentMail webhook does (mail.receive), so dedupe, the automated nets and drafting are shared.
//
// Consent: the owner opens gmail:connectUrl's link, which carries their surface key. Google sends
// them back to /oauth/google/callback (register exactly that, no trailing slash, on the OAuth
// client), and the refresh token is kept on the tenant with the scopes granted: mail always,
// calendar when the owner ticked those boxes too.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { mailClaw } from "./adapters/resolve";
import { appendEvent } from "./events";
import { hasCalendar } from "./lib/google/auth";
import { consentUrl, exchangeCode } from "./lib/mail/gmail";
import { rulingToken, tokenEquals } from "./lib/rulings/token";
import type { ReceiveOutcome } from "./mail";
import { rulingSecret, siteUrl, surfaceKey } from "./surface";

const OVERLAP_MS = 10 * 60_000; // re-list the last ten minutes each pull: Gmail's after: is coarse, the dedupe is exact
const FIRST_LOOKBACK_MS = 60 * 60_000; // a new connection reads the hour before consent, not the whole inbox
const STATE_TTL_MS = 15 * 60_000;

// ---- the pull ------------------------------------------------------------------------------------

export const tenantsToPull = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"tenants">[]> =>
    (await ctx.db.query("tenants").take(200)).filter((t) => !t.demo && t.adapters?.mail?.kind === "gmail"),
});

export const cursor = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<number | null> =>
    (await ctx.db.query("mailCursors").withIndex("by_tenant", (q) => q.eq("tenantId", tenantId)).unique())?.at ?? null,
});

export const setCursor = internalMutation({
  args: { tenantId: v.id("tenants"), at: v.number() },
  handler: async (ctx, { tenantId, at }) => {
    const row = await ctx.db.query("mailCursors").withIndex("by_tenant", (q) => q.eq("tenantId", tenantId)).unique();
    if (row) await ctx.db.patch(row._id, { at });
    else await ctx.db.insert("mailCursors", { tenantId, at });
  },
});

/** Of these Gmail ids, the ones already taken in (mail.receive records `mail:<id>`). */
export const seen = internalQuery({
  args: { tenantId: v.id("tenants"), ids: v.array(v.string()) },
  handler: async (ctx, { tenantId, ids }): Promise<string[]> => {
    const out: string[] = [];
    for (const id of ids) {
      const hit = await ctx.db
        .query("actions")
        .withIndex("by_tenant_key", (q) => q.eq("tenantId", tenantId).eq("idempotencyKey", `mail:${id}`))
        .unique();
      if (hit) out.push(id);
    }
    return out;
  },
});

export async function pullTenant(ctx: ActionCtx, tenant: Doc<"tenants">): Promise<Partial<Record<ReceiveOutcome, number>>> {
  const claw = mailClaw(tenant);
  if (!claw.pull) return {};
  const started = Date.now();
  const last: number | null = await ctx.runQuery(internal.gmail.cursor, { tenantId: tenant._id });
  const since = last !== null ? last - OVERLAP_MS : (tenant.channels.gmail?.grantedAt ?? started) - FIRST_LOOKBACK_MS;
  const mails = await claw.pull(since, (ids) => ctx.runQuery(internal.gmail.seen, { tenantId: tenant._id, ids }));
  const tally: Partial<Record<ReceiveOutcome, number>> = {};
  for (const mail of mails) {
    const outcome: ReceiveOutcome = await ctx.runMutation(internal.mail.receive, { tenantId: tenant._id, mail });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  await ctx.runMutation(internal.gmail.setCursor, { tenantId: tenant._id, at: started });
  return tally;
}

/** The cron. One tenant failing (a revoked grant, Google down) doesn't stop the others; the heartbeat reports it. */
export const pullAll = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    let taken = 0;
    for (const tenant of await ctx.runQuery(internal.gmail.tenantsToPull, {})) {
      try {
        const tally = await pullTenant(ctx, tenant);
        taken += Object.values(tally).reduce((a, b) => a + (b ?? 0), 0);
      } catch (e) {
        console.error(`gmail pull failed for ${tenant.slug}: ${e}`);
      }
    }
    return taken;
  },
});

// ---- consent -------------------------------------------------------------------------------------

export function redirectUri(): string {
  return `${siteUrl()}/oauth/google/callback`;
}

function oauthClient(tenant: Doc<"tenants">): { clientId: string; clientSecret: string } {
  const a = tenant.adapters?.mail;
  const idEnv = (a?.kind === "gmail" && a.clientIdEnv) || "GOOGLE_OAUTH_CLIENT_ID";
  const secretEnv = (a?.kind === "gmail" && a.clientSecretEnv) || "GOOGLE_OAUTH_CLIENT_SECRET";
  const clientId = process.env[idEnv];
  const clientSecret = process.env[secretEnv];
  if (!clientId || !clientSecret) throw new Error(`${idEnv} and ${secretEnv} must be set on the deployment`);
  return { clientId, clientSecret };
}

// The state names the tenant and when it was minted, signed under the ruling secret: a callback
// can only finish a consent this deployment started, for that tenant, within fifteen minutes.
async function stateSig(slug: string, at: number): Promise<string> {
  return await rulingToken(rulingSecret(), slug, `google-oauth:${at}`, "sign");
}

export async function mintState(slug: string, now = Date.now()): Promise<string> {
  return `${encodeURIComponent(slug)}.${now}.${await stateSig(slug, now)}`;
}

export async function readState(state: string, now = Date.now()): Promise<string | null> {
  const [rawSlug, at, sig] = state.split(".");
  if (!rawSlug || !at || !sig || !/^\d+$/.test(at)) return null;
  const slug = decodeURIComponent(rawSlug);
  if (now - Number(at) > STATE_TTL_MS || Number(at) > now + 60_000) return null;
  return tokenEquals(await stateSig(slug, Number(at)), sig) ? slug : null;
}

/** `npx convex run gmail:connectUrl '{"slug":"ben"}'`: the owner's link to connect their Gmail. */
export const connectUrl = internalQuery({
  args: { slug: v.string() },
  handler: async (_ctx, { slug }): Promise<{ open: string; redirectUri: string }> => ({
    open: `${siteUrl()}/oauth/google/${encodeURIComponent(slug)}/start?k=${await surfaceKey(slug)}`,
    redirectUri: redirectUri(),
  }),
});

/** GET /oauth/google/{slug}/start?k=: the surface key proves it's the owner; off to Google. */
export async function startConsent(tenant: Doc<"tenants">): Promise<string> {
  return consentUrl(oauthClient(tenant).clientId, redirectUri(), await mintState(tenant.slug));
}

/** GET /oauth/google/callback: the code for a refresh token, kept on the tenant. */
export async function finishConsent(tenant: Doc<"tenants">, code: string, f: typeof fetch = fetch): Promise<{ address: string; refreshToken: string; scope: string }> {
  return await exchangeCode({ ...oauthClient(tenant), code, redirectUri: redirectUri() }, f);
}

export const saveGrant = internalMutation({
  args: { tenantId: v.id("tenants"), address: v.string(), refreshToken: v.string(), scope: v.optional(v.string()) },
  handler: async (ctx, { tenantId, address, refreshToken, scope }) => {
    const t = await ctx.db.get(tenantId);
    if (!t) throw new Error("unknown tenant");
    await ctx.db.patch(tenantId, { channels: { ...t.channels, gmail: { address, refreshToken, grantedAt: Date.now(), scope } } });
    await appendEvent(ctx, tenantId, "gmail.connected", { address, calendar: hasCalendar(scope) });
  },
});
