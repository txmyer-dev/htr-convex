// The proposal store (STEALS: waggle proposals/store.ts via HTR proposals/store.py), as Convex
// mutations. A mutation is one serializable transaction, so "read the status, then patch" is the
// WHERE-on-status that made a replayed ruling or a double dispatch harmless in the SQL version.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendEvent } from "./events";
import { canMove, summarize, type Status } from "./lib/proposals/lifecycle";
import { buildTimeline, type Step } from "./lib/proposals/timeline";
import { requireSurface } from "./surface";

export type Proposal = Doc<"proposals">;

// ---- reads -------------------------------------------------------------------------

export async function withStatus(ctx: QueryCtx, tenantId: Id<"tenants">, ...statuses: Status[]): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (const s of statuses) {
    const rows = await ctx.db
      .query("proposals")
      .withIndex("by_tenant_status", (q) => q.eq("tenantId", tenantId).eq("status", s))
      .collect();
    out.push(...rows);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : 1));
}

export const pendingFor = (ctx: QueryCtx, tenantId: Id<"tenants">) => withStatus(ctx, tenantId, "pending");

export async function bySource(ctx: QueryCtx, tenantId: Id<"tenants">, sourceKind: string, sourceId: string) {
  return await ctx.db
    .query("proposals")
    .withIndex("by_tenant_source", (q) => q.eq("tenantId", tenantId).eq("sourceKind", sourceKind).eq("sourceId", sourceId))
    .unique();
}

// ---- writes -------------------------------------------------------------------------

export type ProposeArgs = {
  tenantId: Id<"tenants">;
  toAddress: string;
  toName?: string;
  body: string;
  basis?: string[];
  sourceKind?: string;
  sourceId?: string;
  deadline?: number;
  kind?: "email" | "sms" | "site";
  meta?: Proposal["meta"];
  grounding?: Proposal["grounding"];
  gap?: string;
};

/** Insert a pending proposal. Idempotent per (tenant, sourceKind, sourceId). */
export async function propose(ctx: MutationCtx, a: ProposeArgs): Promise<Proposal> {
  if (a.sourceKind && a.sourceId) {
    const existing = await bySource(ctx, a.tenantId, a.sourceKind, a.sourceId);
    if (existing) return existing;
  }
  const id = await ctx.db.insert("proposals", {
    tenantId: a.tenantId,
    kind: a.kind ?? "email",
    toAddress: a.toAddress,
    toName: a.toName,
    body: a.body,
    basis: a.basis ?? [],
    summary: summarize(a.toName, a.toAddress, a.body, a.kind ?? "email"),
    status: "pending",
    sourceKind: a.sourceKind,
    sourceId: a.sourceId,
    deadline: a.deadline,
    edited: false,
    grounding: a.grounding,
    gap: a.gap,
    meta: a.meta ?? {},
    createdAt: Date.now(),
  });
  await appendEvent(ctx, a.tenantId, "proposal.created", { proposalId: id, source: a.sourceKind });
  return (await ctx.db.get(id))!;
}

/**
 * Move a proposal along the lifecycle; null unless the move is legal from its current status.
 * This is what makes approving twice, or dispatching twice, a no-op.
 */
export async function transition(
  ctx: MutationCtx,
  id: Id<"proposals">,
  to: Status,
  patch: Partial<Proposal> = {},
): Promise<Proposal | null> {
  const p = await ctx.db.get(id);
  if (!p || !canMove(p.status, to)) return null;
  await ctx.db.patch(id, { ...patch, status: to });
  return (await ctx.db.get(id))!;
}

export const approve = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "signed", { ruledAt: Date.now() });
export const reject = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "rejected", { ruledAt: Date.now() });
export const expire = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "expired", { ruledAt: Date.now() });
export const supersede = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "superseded", { ruledAt: Date.now() });
export const beginSend = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "sending");
export const markSent = (ctx: MutationCtx, id: Id<"proposals">, ref?: string) =>
  transition(ctx, id, "sent", { sentRef: ref, sentAt: Date.now(), error: undefined });
/** A site request the web agent carried out and Firecrawl has seen on the page. */
export const markLive = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "live");
export const markFailed = (ctx: MutationCtx, id: Id<"proposals">, error: string) => transition(ctx, id, "failed", { error });
export const retry = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "signed", { error: undefined });

/** The owner replaced the words. Only pending proposals are editable. */
export async function edit(ctx: MutationCtx, id: Id<"proposals">, body: string): Promise<Proposal | null> {
  const p = await ctx.db.get(id);
  if (!p || p.status !== "pending") return null;
  await ctx.db.patch(id, { body, edited: true, summary: summarize(p.toName, p.toAddress, body, p.kind) });
  return (await ctx.db.get(id))!;
}

// ---- the dispatcher's two ends ------------------------------------------------------------

export const claimForSend = internalMutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }): Promise<Proposal | null> => {
    const p = await ctx.db.get(proposalId);
    if (!p) return null;
    if (p.status === "failed") await retry(ctx, proposalId);
    return await beginSend(ctx, proposalId); // null unless it was signed: already sent, or never ruled
  },
});

export const finishSend = internalMutation({
  args: { proposalId: v.id("proposals"), ref: v.optional(v.string()), threadId: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { proposalId, ref, threadId, error }) => {
    const p = await ctx.db.get(proposalId);
    if (!p) return;
    if (error !== undefined) {
      await markFailed(ctx, proposalId, error);
      await appendEvent(ctx, p.tenantId, "proposal.send_failed", { proposalId, error });
      return;
    }
    await markSent(ctx, proposalId, ref);
    // A new thread (a site request) is remembered so the web agent's reply in it finds its proposal.
    if (threadId && !p.meta.threadId) await ctx.db.patch(proposalId, { meta: { ...p.meta, threadId } });
    await ctx.db.insert("messages", {
      tenantId: p.tenantId,
      channel: p.kind === "sms" ? "sms" : "email",
      direction: "out",
      fromAddress: "us",
      toAddress: p.toAddress,
      body: p.body,
      at: Date.now(),
      vendorRef: ref,
      threadId: p.meta.threadId ?? threadId,
      meta: { subject: p.meta.subject },
    });
    await appendEvent(ctx, p.tenantId, "proposal.sent", { proposalId, edited: p.edited, kind: p.kind });
  },
});

export const get = internalQuery({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }) => await ctx.db.get(proposalId),
});

// ---- the surface's reads ----------------------------------------------------------------

/** Everything the ruling page shows, newest first. Live: Convex re-runs it on every change. */
export const list = query({
  args: { slug: v.string(), key: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { slug, key, limit }) => {
    const tenant = await requireSurface(ctx, slug, key);
    const rows = await ctx.db
      .query("proposals")
      .withIndex("by_tenant_created", (q) => q.eq("tenantId", tenant._id))
      .order("desc")
      .take(limit ?? 100);
    return rows.map((p) => ({
      id: p._id, status: p.status, kind: p.kind, toAddress: p.toAddress, toName: p.toName, body: p.body,
      basis: p.basis, summary: p.summary, deadline: p.deadline, digestNo: p.digestNo, edited: p.edited,
      createdAt: p.createdAt, ruledAt: p.ruledAt, sentAt: p.sentAt, error: p.error, subject: p.meta.subject,
      sourceKind: p.sourceKind, grounding: p.grounding ?? null, gap: p.gap ?? null, siteFailure: p.meta.siteFailure ?? null,
    }));
  },
});

/**
 * What happened to one request, in order and in words (lib/proposals/timeline.ts): the events that
 * name it and the owner's rulings on it. The surface shows it under a ruled item. Live like the list.
 */
export const timeline = query({
  args: { slug: v.string(), key: v.string(), proposalId: v.id("proposals") },
  handler: async (ctx, { slug, key, proposalId }): Promise<Step[]> => {
    const tenant = await requireSurface(ctx, slug, key);
    const p = await ctx.db.get(proposalId);
    if (!p || p.tenantId !== tenant._id) return [];
    const events = await ctx.db.query("events").withIndex("by_proposal_at", (q) => q.eq("proposalId", proposalId)).take(100);
    const rulings = await ctx.db.query("rulings").withIndex("by_proposal_at", (q) => q.eq("proposalId", proposalId)).take(20);
    return buildTimeline(p, events, rulings);
  },
});

/**
 * A site request goes back to signed and is dispatched again, in a new thread: the web agent said
 * it could not, the site never showed it, or nobody answered. Site requests only: a sent email is
 * sent, and asking twice would send it twice. Sent or failed only: anything else is still on its way.
 */
export async function resendSite(ctx: MutationCtx, p: Proposal): Promise<string> {
  if (p.kind !== "site") return "not a site request";
  if (p.status !== "sent" && p.status !== "failed") return `not sent (${p.status})`;
  const moved = await transition(ctx, p._id, "signed", {
    sentRef: undefined, sentAt: undefined, error: undefined, meta: { ...p.meta, threadId: undefined, siteFailure: undefined },
  });
  if (!moved) return "no";
  await appendEvent(ctx, p.tenantId, "site.resent", { proposalId: p._id, from: p.status });
  await ctx.scheduler.runAfter(0, internal.mail.dispatch, { proposalId: p._id });
  return "resent";
}

/** `npx convex run proposals:resend '{"proposalId":"..."}'`: the same from the command line. */
export const resend = internalMutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }): Promise<string> => {
    const p = await ctx.db.get(proposalId);
    return p ? await resendSite(ctx, p) : "no such proposal";
  },
});
