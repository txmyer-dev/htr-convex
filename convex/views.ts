// Read-only views used by the HTTP surface (the web app uses proposals.list directly).

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { requireTenant } from "./surface";

export type ProposalView = {
  id: Id<"proposals">; status: Doc<"proposals">["status"]; kind: string; toAddress: string; toName?: string; body: string;
  basis: string[]; summary: string; subject?: string; deadline?: number; digestNo?: number; edited: boolean;
  createdAt: number; ruledAt?: number; sentAt?: number; error?: string;
};

export const proposals = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }): Promise<ProposalView[]> => {
    const tenant = await requireTenant(ctx, slug);
    const rows = await ctx.db.query("proposals").withIndex("by_tenant_created", (q) => q.eq("tenantId", tenant._id)).order("desc").take(100);
    return rows.map((p) => ({
      id: p._id, status: p.status, kind: p.kind, toAddress: p.toAddress, toName: p.toName, body: p.body, basis: p.basis,
      summary: p.summary, subject: p.meta.subject, deadline: p.deadline, digestNo: p.digestNo, edited: p.edited,
      createdAt: p.createdAt, ruledAt: p.ruledAt, sentAt: p.sentAt, error: p.error,
    }));
  },
});
