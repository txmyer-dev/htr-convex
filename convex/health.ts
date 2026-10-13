// The heartbeat (Python HTR's jobs._heartbeat): every hour, probe each tenant's claws. A claw
// that goes down, or comes back, is pushed to the owner's phone once, on the change, not every
// hour it stays down. A claw that has no probe counts as up when it resolves.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { clawsOf, notifyClaw } from "./adapters/resolve";
import { appendEvent } from "./events";

export type Result = { port: string; adapter?: string; ok: boolean; error?: string };
export type Change = Result & { was: boolean | null };

/** What changed since the last beat. A claw seen for the first time is a change only if it is down. */
export function changes(prev: Map<string, boolean>, now: Result[]): Change[] {
  return now
    .map((r) => ({ ...r, was: prev.has(r.port) ? prev.get(r.port)! : null }))
    .filter((c) => (c.was === null ? !c.ok : c.was !== c.ok));
}

export function noticeOf(tenant: Doc<"tenants">, c: Change[]): { title: string; message: string; tags: string[]; priority: number } {
  const down = c.filter((x) => !x.ok);
  return {
    title: down.length ? `${tenant.displayName}: ${down.map((d) => d.port).join(", ")} down` : `${tenant.displayName}: back up`,
    message: c.map((x) => (x.ok ? `${x.port} (${x.adapter ?? "?"}) is working again.` : `${x.port} (${x.adapter ?? "?"}): ${x.error ?? "failed"}`)).join("\n").slice(0, 1500),
    tags: [down.length ? "warning" : "white_check_mark"],
    priority: down.length ? 4 : 3,
  };
}

export const tenantsToCheck = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"tenants">[]> => (await ctx.db.query("tenants").take(200)).filter((t) => !t.demo),
});

/** Store this beat's results; return what changed. */
export const record = internalMutation({
  args: { tenantId: v.id("tenants"), results: v.array(v.object({ port: v.string(), adapter: v.optional(v.string()), ok: v.boolean(), error: v.optional(v.string()) })) },
  handler: async (ctx, { tenantId, results }): Promise<Change[]> => {
    const prev = new Map<string, boolean>();
    const now = Date.now();
    for (const r of results) {
      const row = await ctx.db.query("clawHealth").withIndex("by_tenant_port", (q) => q.eq("tenantId", tenantId).eq("port", r.port)).unique();
      if (row) {
        prev.set(r.port, row.ok);
        await ctx.db.patch(row._id, { adapter: r.adapter, ok: r.ok, error: r.error, at: now });
      } else {
        await ctx.db.insert("clawHealth", { tenantId, ...r, at: now });
      }
    }
    const c = changes(prev, results);
    for (const x of c) await appendEvent(ctx, tenantId, x.ok ? "claw.up" : "claw.down", { port: x.port, adapter: x.adapter, error: x.error });
    return c;
  },
});

export const beat = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    let pushed = 0;
    for (const tenant of await ctx.runQuery(internal.health.tenantsToCheck, {})) {
      const results: Result[] = [];
      for (const { port, claw, error } of clawsOf(tenant)) {
        if (!claw) {
          if (error) results.push({ port, ok: false, error: error.slice(0, 300) });
          continue; // not configured: nothing to watch
        }
        try {
          await claw.probe?.();
          results.push({ port, adapter: claw.name, ok: true });
        } catch (e) {
          results.push({ port, adapter: claw.name, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
        }
      }
      const c: Change[] = await ctx.runMutation(internal.health.record, { tenantId: tenant._id, results });
      const notify = notifyClaw(tenant);
      if (c.length && notify) {
        try {
          await notify.push(noticeOf(tenant, c));
          pushed++;
        } catch (e) {
          console.error(`heartbeat push failed for ${tenant.slug}: ${e}`);
        }
      }
    }
    return pushed;
  },
});
