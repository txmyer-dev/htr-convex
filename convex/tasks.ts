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
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { requestDigest } from "./digest";
import { appendEvent } from "./events";
import { taskClaw } from "./adapters/resolve";
import type { TaskClaw } from "./adapters/ports";
import type { AgendaTask } from "./lib/tasks/clickup";
import { accept, agendaTag, description, dueMs, listFor, sameness, type CallItem } from "./lib/tasks/intake";
import { rulingToken } from "./lib/rulings/token";
import { markLive, propose, withStatus } from "./proposals";
import { rulingSecret } from "./surface";

export async function intakeKey(slug: string): Promise<string> {
  return await rulingToken(rulingSecret(), slug, "intake", "sign");
}

function tasksOf(tenant: Doc<"tenants">) {
  const claw = taskClaw(tenant);
  if (!claw) throw new Error(`tenant ${tenant.slug} has no tasks claw (CLICKUP_API_TOKEN or adapters.tasks)`);
  return claw;
}

const callItem = v.object({
  id: v.string(), type: v.string(), what: v.string(), quote: v.string(), who: v.optional(v.string()),
  due: v.optional(v.string()), lane: v.optional(v.string()), privacy: v.optional(v.string()), destination: v.string(),
  series: v.optional(v.string()),
});

const OPEN = ["pending", "signed", "sending", "sent"] as const;

export type IntakeOutcome = { proposed: number; already: number; duplicate: number; refused: Record<string, number> };

/** One call's items in. Idempotent per (session, item); the same promise still open from an earlier call is not proposed twice. */
export const receiveCallItems = internalMutation({
  args: { tenantId: v.id("tenants"), session: v.string(), items: v.array(callItem) },
  handler: async (ctx, { tenantId, session, items }): Promise<IntakeOutcome> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    return await takeCallItems(ctx, tenant, session, items as CallItem[]);
  },
});

/** Items in, as pending task proposals: the call line's path, and the meeting recorder's (meetings.ts). */
export async function takeCallItems(ctx: MutationCtx, tenant: Doc<"tenants">, session: string, items: CallItem[]): Promise<IntakeOutcome> {
  const tenantId = tenant._id;
  if (!tenant.tasks) throw new Error(`tenant ${tenant.slug} has no task list configured`);
  const out: IntakeOutcome = { proposed: 0, already: 0, duplicate: 0, refused: {} };
  const open = (await withStatus(ctx, tenantId, ...OPEN)).filter((p) => p.kind === "task");
  const openSame = new Map(open.map((p) => [p.meta.task?.sameness ?? "", p]));
  for (const i of items) {
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
    const list = listFor(tenant.tasks, i.lane);
    const tag = i.destination === "clickup.agenda" ? agendaTag(i.series!) : undefined;
    const p = await propose(ctx, {
      tenantId, kind: "task", toAddress: "clickup", toName: tag ? `next ${i.series} (${list.listName})` : list.listName,
      body: i.what.trim(), basis: [i.quote], sourceKind: "call_item", sourceId, deadline: undefined,
      meta: { task: { type: i.type, due: i.due, who: i.who, lane: i.lane, listId: list.listId, tag, session, itemId: i.id, sameness: same } },
    });
    openSame.set(same, p);
    out.proposed++;
  }
  await appendEvent(ctx, tenantId, "call.items", { session, ...out });
  if (out.proposed) await requestDigest(ctx, tenant);
  return out;
}

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
  const made = await tasksOf(tenant).create(t?.listId ?? listFor(tenant.tasks, t?.lane).listId, {
    name: p.body,
    description: t ? description({ id: t.itemId, type: t.type, what: p.body, quote: p.basis[0] ?? "", who: t.who, lane: t.lane, destination: "clickup.task" }, t.session) : p.body,
    dueMs: dueMs(t?.due),
    tags: t?.tag ? [t.tag] : undefined,
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
  handler: async (ctx): Promise<Array<{ tenantId: Id<"tenants">; proposalId: Id<"proposals">; ref: string }>> => {
    const out: Array<{ tenantId: Id<"tenants">; proposalId: Id<"proposals">; ref: string }> = [];
    for (const tenant of await ctx.db.query("tenants").take(500)) {
      for (const p of await withStatus(ctx, tenant._id, "sent")) {
        if (p.kind === "task" && p.sentRef) out.push({ tenantId: tenant._id, proposalId: p._id, ref: p.sentRef });
      }
    }
    return out.slice(0, 100);
  },
});

/** Every 15 minutes: read each open task back through its tenant's tasks claw. A failed read is skipped, not fatal. */
export const sync = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    let n = 0;
    const claws = new Map<Id<"tenants">, TaskClaw | null>();
    for (const { tenantId, proposalId, ref } of await ctx.runQuery(internal.tasks.openTasks, {})) {
      if (!claws.has(tenantId)) {
        const tenant = await ctx.runQuery(internal.tenants.get, { tenantId });
        claws.set(tenantId, tenant ? taskClaw(tenant) : null);
      }
      const claw = claws.get(tenantId);
      if (!claw) continue;
      try {
        const s = await claw.get(ref);
        await ctx.runMutation(internal.tasks.noteTask, { proposalId, url: s.url, status: s.status, done: s.done });
        n++;
      } catch (e) {
        console.warn(`task sync ${ref}: ${String(e)}`);
      }
    }
    return n;
  },
});

/** `npx convex run tasks:intakeKeyFor '{"slug":"tony"}'`: the key call-listener puts in its .env. */
export const intakeKeyFor = internalQuery({
  args: { slug: v.string() },
  handler: async (_ctx, { slug }): Promise<string> => await intakeKey(slug),
});

// ---- the agenda ----------------------------------------------------------------------------

/** What waits to be raised at a series' next meeting: open ClickUp tasks tagged raise-<series>. */
export async function agendaFor(tenant: Doc<"tenants">, tag: string): Promise<AgendaTask[]> {
  if (!tenant.tasks?.teamId) return [];
  return (await taskClaw(tenant)?.listTagged(tag)) ?? [];
}
