// The proposal store (STEALS: waggle proposals/store.ts via HTR proposals/store.py), as Convex
// mutations. A mutation is one serializable transaction, so "read the status, then patch" is the
// WHERE-on-status that made a replayed ruling or a double dispatch harmless in the SQL version.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendEvent } from "./events";
import { canMove, summarize, type Status } from "./lib/proposals/lifecycle";
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
  kind?: "email" | "sms";
  meta?: Proposal["meta"];
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
    summary: summarize(a.toName, a.toAddress, a.body),
    status: "pending",
    sourceKind: a.sourceKind,
    sourceId: a.sourceId,
    deadline: a.deadline,
    edited: false,
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
export const markFailed = (ctx: MutationCtx, id: Id<"proposals">, error: string) => transition(ctx, id, "failed", { error });
export const retry = (ctx: MutationCtx, id: Id<"proposals">) => transition(ctx, id, "signed", { error: undefined });

/** The owner replaced the words. Only pending proposals are editable. */
export async function edit(ctx: MutationCtx, id: Id<"proposals">, body: string): Promise<Proposal | null> {
  const p = await ctx.db.get(id);
  if (!p || p.status !== "pending") return null;
  await ctx.db.patch(id, { body, edited: true, summary: summarize(p.toName, p.toAddress, body) });
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
  args: { proposalId: v.id("proposals"), ref: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { proposalId, ref, error }) => {
    const p = await ctx.db.get(proposalId);
    if (!p) return;
    if (error !== undefined) {
      await markFailed(ctx, proposalId, error);
      await appendEvent(ctx, p.tenantId, "proposal.send_failed", { proposalId, error });
      return;
    }
    await markSent(ctx, proposalId, ref);
    await ctx.db.insert("messages", {
      tenantId: p.tenantId,
      channel: p.kind,
      direction: "out",
      fromAddress: "us",
      toAddress: p.toAddress,
      body: p.body,
      at: Date.now(),
      vendorRef: ref,
      threadId: p.meta.threadId,
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
      sourceKind: p.sourceKind,
    }));
  },
});
