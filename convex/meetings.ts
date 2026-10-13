// The meeting recorder (Fireflies), a standard extension. Its webhook says a meeting is ready;
// the notes are read back through the meetings claw and kept as a meeting row. Action items go
// down the call line's path (tasks.takeCallItems) as task proposals when there is a task list;
// the note goes out once, in the next digest's Meetings section, and to the phone.
//
//   POST /intake/{slug}/meetings   Fireflies webhook (X-Hub-Signature), or the intake key as bearer

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { meetingsClaw } from "./adapters/resolve";
import { requestDigest } from "./digest";
import { appendEvent, recordAction } from "./events";
import type { Meeting } from "./lib/meetings/fireflies";
import { findDeadline } from "./lib/reader/deadline";
import type { CallItem } from "./lib/tasks/intake";
import { takeCallItems, type IntakeOutcome } from "./tasks";

const RETRY_MS = 5 * 60_000; // a meeting can be transcribed before it is summarized
const TRIES = 4;

/** The webhook's transaction: once per meeting, then the read is scheduled. */
export const received = internalMutation({
  args: { tenantId: v.id("tenants"), meetingId: v.string(), event: v.string() },
  handler: async (ctx, { tenantId, meetingId, event }): Promise<"duplicate" | "fetching"> => {
    if (!(await recordAction(ctx, tenantId, `meeting:${meetingId}`, "receive_meeting", { event }))) return "duplicate";
    await appendEvent(ctx, tenantId, "meeting.received", { meetingId, event });
    await ctx.scheduler.runAfter(0, internal.meetings.read, { tenantId, meetingId, attempt: 1 });
    return "fetching";
  },
});

export const read = internalAction({
  args: { tenantId: v.id("tenants"), meetingId: v.string(), attempt: v.number() },
  handler: async (ctx, { tenantId, meetingId, attempt }): Promise<"recorded" | "waiting" | "gone"> => {
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant) return "gone";
    const claw = meetingsClaw(tenant);
    if (!claw) throw new Error("FIREFLIES_API_KEY is not set on the deployment (or the tenant's adapters.meetings.keyEnv)");
    const m = await claw.get(meetingId);
    if (!m) return "gone";
    if (!m.overview && m.actionItems.length === 0 && attempt < TRIES) {
      await ctx.scheduler.runAfter(RETRY_MS, internal.meetings.read, { tenantId, meetingId, attempt: attempt + 1 });
      return "waiting";
    }
    await ctx.runMutation(internal.meetings.record, { tenantId, meeting: m });
    return "recorded";
  },
});

const meetingArg = v.object({
  id: v.string(), title: v.string(), at: v.number(), durationMin: v.optional(v.number()), attendees: v.array(v.string()),
  organizer: v.optional(v.string()), overview: v.optional(v.string()), bullets: v.optional(v.string()),
  actionItems: v.array(v.object({ who: v.optional(v.string()), what: v.string() })), url: v.optional(v.string()),
});

/** One meeting's items as the call line hands them in: the owner's own are commitments, the rest are owed. */
export function itemsOf(m: Meeting, ownerNames: string[], timeZone: string): CallItem[] {
  const mine = (who?: string) => !who || ownerNames.some((n) => n.length >= 3 && who.toLowerCase().includes(n.toLowerCase()));
  return m.actionItems.map((a, i) => {
    const due = findDeadline(a.what, m.at, timeZone);
    return {
      id: `a${i + 1}`, type: mine(a.who) ? "my_commitment" : "owed_to_me", what: a.what, quote: a.what, who: mine(a.who) ? undefined : a.who,
      due: due ? new Date(due.deadline).toISOString() : undefined, privacy: "shareable", destination: "clickup.task",
    };
  });
}

export const record = internalMutation({
  args: { tenantId: v.id("tenants"), meeting: meetingArg },
  handler: async (ctx, { tenantId, meeting: m }): Promise<{ tasks: IntakeOutcome | null }> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const row = {
      tenantId, vendor: "fireflies" as const, meetingId: m.id, title: m.title, at: m.at, durationMin: m.durationMin,
      attendees: m.attendees, overview: m.overview, bullets: m.bullets, actionItems: m.actionItems, url: m.url,
    };
    const before = await ctx.db.query("meetings").withIndex("by_tenant_meeting", (q) => q.eq("tenantId", tenantId).eq("meetingId", m.id)).unique();
    if (before) await ctx.db.patch(before._id, row);
    else await ctx.db.insert("meetings", row);
    await appendEvent(ctx, tenantId, "meeting.recorded", { meetingId: m.id, title: m.title, items: m.actionItems.length });
    // With a task list, each item is a task proposal (ruled like any other); without one, the note carries them.
    const tasks = tenant.tasks && m.actionItems.length ? await takeCallItems(ctx, tenant, `fireflies:${m.id}`, itemsOf(m, tenant.owner.names, tenant.timeZone)) : null;
    if (!tasks?.proposed) await requestDigest(ctx, tenant); // takeCallItems asked already when it proposed
    return { tasks };
  },
});

/** Meetings not yet reported, oldest first. */
export async function unreported(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<Doc<"meetings">[]> {
  return await ctx.db.query("meetings").withIndex("by_tenant_digest", (q) => q.eq("tenantId", tenantId).eq("digestId", undefined)).take(20);
}

export const markPushed = internalMutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    await ctx.db.patch(meetingId, { pushedAt: Date.now() });
  },
});

export const recent = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) =>
    await ctx.db.query("meetings").withIndex("by_tenant_meeting", (q) => q.eq("tenantId", tenantId)).order("desc").take(20),
});
