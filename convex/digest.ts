// The digest: number what waits, send one message, remember the numbering.
//
// `request` is how a new draft asks for a digest. Immediate mode debounces sixty seconds so
// drafts that land together share one message (the scheduler is the queue; the tenant row
// remembers the pending job). Timed mode is the cron in crons.ts, which calls `run` at the
// owner's hour. `build` is the transaction; `run` is the action that sends it.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { appendEvent } from "./events";
import { renderDigest, type DigestItem } from "./lib/digest/render";
import { rulingLinks } from "./lib/rulings/token";
import { pendingFor } from "./proposals";
import { liveSurfaceUrl, rulingSecret, siteUrl } from "./surface";

export const DEBOUNCE_MS = 60_000;

export async function requestDigest(ctx: MutationCtx, tenant: Doc<"tenants">) {
  if (tenant.owner.digestAt !== "immediate") return; // the cron will get to it at the owner's hour
  if (tenant.digestScheduled) {
    const job = await ctx.db.system.get(tenant.digestScheduled);
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return;
  }
  const id = await ctx.scheduler.runAfter(DEBOUNCE_MS, internal.digest.run, { tenantId: tenant._id });
  await ctx.db.patch(tenant._id, { digestScheduled: id });
}

export type BuiltDigest = {
  digestId: Id<"digests">;
  body: string;
  items: Array<{ n: number; proposalId: Id<"proposals">; item: DigestItem }>;
};

export const build = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<BuiltDigest | null> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const pending = await pendingFor(ctx, tenantId);
    if (pending.length === 0) return null;
    const now = Date.now();
    const numbered = pending.map((p, i) => [i + 1, p] as const);
    const body = renderDigest(
      numbered.map(([n, p]) => [n, p] as [number, DigestItem]),
      { timeZone: tenant.timeZone, nowMs: now },
    );
    const digestId = await ctx.db.insert("digests", {
      tenantId,
      mapping: numbered.map(([n, p]) => ({ n, proposalId: p._id })),
      body,
      sentAt: now,
    });
    for (const [n, p] of numbered) await ctx.db.patch(p._id, { digestId, digestNo: n });
    await appendEvent(ctx, tenantId, "digest.built", { digestId, count: numbered.length });
    return {
      digestId,
      body,
      items: numbered.map(([n, p]) => ({
        n,
        proposalId: p._id,
        item: { toAddress: p.toAddress, toName: p.toName, body: p.body, basis: p.basis, kind: p.kind, sourceKind: p.sourceKind, deadline: p.deadline },
      })),
    };
  },
});

export const setRef = internalMutation({
  args: { digestId: v.id("digests"), ref: v.string() },
  handler: async (ctx, { digestId, ref }) => {
    await ctx.db.patch(digestId, { ref });
  },
});

/** The digest email: the numbered text, then one Send / Skip pair per draft, then the live surface. */
export async function digestEmail(tenant: Doc<"tenants">, built: BuiltDigest): Promise<{ subject: string; text: string; html: string }> {
  const base = `${siteUrl()}/rulings`;
  const secret = rulingSecret();
  const surface = await liveSurfaceUrl(tenant.slug);
  const linkLines: string[] = [];
  const cards: string[] = [];
  for (const { n, proposalId, item } of built.items) {
    const links = await rulingLinks(base, secret, tenant.slug, proposalId);
    linkLines.push(`${n}  Send: ${links.sign}\n    Skip: ${links.reject}\n    Edit: ${links.edit}`);
    const ask = item.basis[0] ? `<p style="color:#5b6070;margin:0 0 8px">“${escapeHtml(item.basis[0])}”</p>` : "";
    cards.push(
      `<div style="border:1px solid #d9d8d1;border-radius:8px;padding:14px 16px;margin:12px 0">` +
        `<div style="font-weight:600;margin-bottom:6px">${n} · ${escapeHtml(item.toName || item.toAddress)}</div>${ask}` +
        `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(item.body)}</p>` +
        `<a href="${links.sign}" style="background:#1d222c;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;margin-right:8px">Send</a>` +
        `<a href="${links.reject}" style="color:#1d222c;padding:8px 14px;border:1px solid #1d222c;border-radius:6px;text-decoration:none;margin-right:8px">Skip</a>` +
        `<a href="${links.edit}" style="color:#1d222c;padding:8px 14px;border:1px solid #d9d8d1;border-radius:6px;text-decoration:none">Edit</a>` +
        `</div>`,
    );
  }
  const count = built.items.length;
  const subject = `${count} waiting on you`;
  const text = `${built.body}\n\nOne tap:\n${linkLines.join("\n")}\n\nEverything, live: ${surface}`;
  const html =
    `<div style="font-family:system-ui,sans-serif;color:#1d222c;max-width:640px">` +
    `<p style="white-space:pre-wrap">${escapeHtml(built.body)}</p>${cards.join("")}` +
    `<p><a href="${surface}">Everything, live →</a></p></div>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const run = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<Id<"digests"> | null> => {
    const built: BuiltDigest | null = await ctx.runMutation(internal.digest.build, { tenantId });
    if (!built) return null;
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant) throw new Error("unknown tenant");
    const mail = await digestEmail(tenant, built);
    const ref = await ctx.runAction(internal.mail.sendToOwner, { tenantId, ...mail });
    if (ref) await ctx.runMutation(internal.digest.setRef, { digestId: built.digestId, ref });
    return built.digestId;
  },
});
