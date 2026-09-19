// The two records every handler writes (the discipline of HTR events.py, restated).
// appendEvent: what happened, append-only. recordAction: did we already do this exact thing?
// A mutation is one transaction, so the read-then-insert in recordAction is atomic.

import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";

export async function appendEvent(ctx: MutationCtx, tenantId: Id<"tenants">, kind: string, payload: unknown = {}) {
  await ctx.db.insert("events", { tenantId, proposalId: proposalOf(ctx, payload), kind, payload, at: Date.now() });
}

/** The request an event is about, when its payload names one: what a request's timeline is read by. */
export function proposalOf(ctx: QueryCtx, payload: unknown): Id<"proposals"> | undefined {
  const id = payload && typeof payload === "object" ? (payload as { proposalId?: unknown }).proposalId : undefined;
  return typeof id === "string" ? (ctx.db.normalizeId("proposals", id) ?? undefined) : undefined;
}

/**
 * Returns true the first time a key is seen for a tenant, false after. Callers do the side
 * effect only on true. Replayed webhooks and double-scheduled jobs land here and stop.
 */
export async function recordAction(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  idempotencyKey: string,
  kind: string,
  payload: unknown = {},
): Promise<boolean> {
  const seen = await ctx.db
    .query("actions")
    .withIndex("by_tenant_key", (q) => q.eq("tenantId", tenantId).eq("idempotencyKey", idempotencyKey))
    .unique();
  if (seen) return false;
  await ctx.db.insert("actions", { tenantId, idempotencyKey, kind, payload, at: Date.now() });
  return true;
}

/**
 * Events written before `proposalId` was lifted out of the payload carry it only inside. One page
 * at a time, then the next: `npx convex run events:backfillProposalIds '{"paginationOpts":{"numItems":200,"cursor":null}}'`.
 */
export const backfillProposalIds = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }): Promise<number> => {
    const page = await ctx.db.query("events").paginate(paginationOpts);
    let patched = 0;
    for (const e of page.page) {
      if (e.proposalId) continue;
      const proposalId = proposalOf(ctx, e.payload);
      if (!proposalId) continue;
      await ctx.db.patch(e._id, { proposalId });
      patched++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.events.backfillProposalIds, {
        paginationOpts: { numItems: paginationOpts.numItems, cursor: page.continueCursor },
      });
    }
    return patched;
  },
});
