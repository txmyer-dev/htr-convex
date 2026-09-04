// The two records every handler writes (the discipline of HTR events.py, restated).
// appendEvent: what happened, append-only. recordAction: did we already do this exact thing?
// A mutation is one transaction, so the read-then-insert in recordAction is atomic.

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export async function appendEvent(ctx: MutationCtx, tenantId: Id<"tenants">, kind: string, payload: unknown = {}) {
  await ctx.db.insert("events", { tenantId, kind, payload, at: Date.now() });
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
