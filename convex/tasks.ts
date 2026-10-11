// Tasks: the call line's follow-ups, through the same funnel as every draft.
//
//   call-listener --POST /intake/{slug}/call-items--> receiveCallItems -> pending "task" proposals
//   owner rules (digest reply, link, surface) -> mail.dispatch -> dispatchTask -> ClickUp task
//   cron sync -> reads each open task back; done in ClickUp = "live" here
//   call-listener --GET /intake/{slug}/call-items--> callItemStates (the brief's open loops)
//
// The intake key is derived from the ruling secret like the surface key, under its own label: the
// laptop holding it can hand items in and read their states, never rule on them.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { requestDigest } from "./digest";
import { appendEvent } from "./events";
import { createTask, getTask } from "./lib/tasks/clickup";
import { accept, description, dueMs, sameness, type CallItem } from "./lib/tasks/intake";
import { rulingToken } from "./lib/rulings/token";
import { markLive, propose, withStatus } from "./proposals";
import { rulingSecret } from "./surface";

export async function intakeKey(slug: string): Promise<string> {
  return await rulingToken(rulingSecret(), slug, "intake", "sign");
}

function token(): string {
  const t = process.env.CLICKUP_API_TOKEN;
  if (!t) throw new Error("CLICKUP_API_TOKEN is not set on the deployment");
  return t;
}

const callItem = v.object({
  id: v.string(), type: v.string(), what: v.string(), quote: v.string(), who: v.optional(v.string()),
  due: v.optional(v.string()), lane: v.optional(v.string()), privacy: v.optional(v.string()), destination: v.string(),
});

const OPEN = ["pending", "signed", "sending", "sent"] as const;

export type IntakeOutcome = { proposed: number; already: number; duplicate: number; refused: Record<string, number> };

/** One call's items in. Idempotent per (session, item); the same promise still open from an earlier call is not proposed twice. */
export const receiveCallItems = internalMutation({
  args: { tenantId: v.id("tenants"), session: v.string(), items: v.array(callItem) },
  handler: async (ctx, { tenantId, session, items }): Promise<IntakeOutcome> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const out: IntakeOutcome = { proposed: 0, already: 0, duplicate: 0, refused: {} };
    const open = (await withStatus(ctx, tenantId, ...OPEN)).filter((p) => p.kind === "task");
    const openSame = new Map(open.map((p) => [p.meta.task?.sameness ?? "", p]));
    for (const i of items as CallItem[]) {
      const verdict = accept(i);
      if (!verdict.take) {
        out.refused[verdict.why] = (out.refused[verdict.why] ?? 0) + 1;
        continue;
      }
      const sourceId = `${session}:${i.id}`;
      const same = sameness(i.what);
      const twin = openSame.get(same);
      if (twin && twin.sourceId !== sourceId) {
        out.duplicate++;
        await appendEvent(ctx, tenantId, "task.repeated", { proposalId: twin._id, session, itemId: i.id });
        continue;
      }
      const before = await ctx.db.query("proposals").withIndex("by_tenant_source", (q) =>
        q.eq("tenantId", tenantId).eq("sourceKind", "call_item").eq("sourceId", sourceId)).unique();
      if (before) {
        out.already++;
        continue;
      }
      const p = await propose(ctx, {
        tenantId, kind: "task", toAddress: "clickup", toName: tenant.tasks?.listName ?? "task list",
        body: i.what.trim(), basis: [i.quote], sourceKind: "call_item", sourceId, deadline: undefined,
        meta: { task: { type: i.type, due: i.due, who: i.who, lane: i.lane, session, itemId: i.id, sameness: same } },
      });
      openSame.set(same, p);
      out.proposed++;
    }
    await appendEvent(ctx, tenantId, "call.items", { session, ...out });
    if (out.proposed) await requestDigest(ctx, tenant);
    return out;
  },
});

export type ItemState = {
  session: string; itemId: string; what: string; type: string; due?: string; who?: string;
  status: Doc<"proposals">["status"]; edited: boolean; task?: { url?: string; status?: string; done: boolean };
};

/** What became of every item the line handed in: the brief reads its open loops from here. */
export const callItemStates = internalQuery({
  args: { tenantId: v.id("tenants"), session: v.optional(v.string()) },
  handler: async (ctx, { tenantId, session }): Promise<ItemState[]> => {
    const rows = await ctx.db.query("proposals").withIndex("by_tenant_created", (q) => q.eq("tenantId", tenantId)).order("desc").take(500);
    return rows
      .filter((p) => p.kind === "task" && p.sourceKind === "call_item" && p.meta.task && (!session || p.meta.task.session === session))
      .map((p) => ({
        session: p.meta.task!.session, itemId: p.meta.task!.itemId, what: p.body, type: p.meta.task!.type,
        due: p.meta.task!.due, who: p.meta.task!.who, status: p.status, edited: p.edited,
        task: p.sentRef ? { url: p.meta.task!.url, status: p.meta.task!.status, done: p.status === "live" } : undefined,
      }));
  },
});

// ---- the executor ------------------------------------------------------------------------

/** Called by mail.dispatch for a claimed task proposal. Returns the ClickUp task id. */
export async function dispatchTask(tenant: Doc<"tenants">, p: Doc<"proposals">): Promise<{ id: string; url: string; status: string }> {
  if (!tenant.tasks) throw new Error(`tenant ${tenant.slug} has no task list configured`);
  const t = p.meta.task;
  const made = await createTask(token(), tenant.tasks.clickupListId, {
    name: p.body,
    description: t ? description({ id: t.itemId, type: t.type, what: p.body, quote: p.basis[0] ?? "", who: t.who, lane: t.lane, destination: "clickup.task" }, t.session) : p.body,
    dueMs: dueMs(t?.due),
  });
  return { id: made.id, url: made.url, status: made.status };
}

export const noteTask = internalMutation({
  args: { proposalId: v.id("proposals"), url: v.string(), status: v.string(), done: v.boolean() },
  handler: async (ctx, { proposalId, url, status, done }) => {
    const p = await ctx.db.get(proposalId);
    if (!p || !p.meta.task) return;
    await ctx.db.patch(proposalId, { meta: { ...p.meta, task: { ...p.meta.task, url, status, syncedAt: Date.now() } } });
    if (done && (await markLive(ctx, proposalId))) await appendEvent(ctx, p.tenantId, "task.done", { proposalId, status });
  },
});

// ---- the sync ----------------------------------------------------------------------------

export const openTasks = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ proposalId: Id<"proposals">; ref: string }>> => {
    const out: Array<{ proposalId: Id<"proposals">; ref: string }> = [];
    for (const tenant of await ctx.db.query("tenants").take(500)) {
      for (const p of await withStatus(ctx, tenant._id, "sent")) {
        if (p.kind === "task" && p.sentRef) out.push({ proposalId: p._id, ref: p.sentRef });
      }
    }
    return out.slice(0, 100);
  },
});

/** Every 15 minutes: read each open task back from ClickUp. A failed read is skipped, not fatal. */
export const sync = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    if (!process.env.CLICKUP_API_TOKEN) return 0;
    let n = 0;
    for (const { proposalId, ref } of await ctx.runQuery(internal.tasks.openTasks, {})) {
      try {
        const s = await getTask(token(), ref);
        await ctx.runMutation(internal.tasks.noteTask, { proposalId, url: s.url, status: s.status, done: s.done });
        n++;
      } catch (e) {
        console.warn(`task sync ${ref}: ${String(e)}`);
      }
    }
    return n;
  },
});
