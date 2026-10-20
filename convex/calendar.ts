// The desk reads a stored snapshot, not Google (KTD8). Every ten minutes, and after the event
// dispatcher writes, each tenant with the calendar grant has its window (local today through the
// next 7 days, every calendar it hasn't hidden) read and stored whole, replacing the last one. A
// Google error keeps the last snapshot and says when it was taken. Mail-only tenants never get here.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { calendarClaw } from "./adapters/resolve";
import { hasCalendar } from "./lib/google/auth";
import { atLocalHour, localDaysBetween, localParts } from "./lib/time";
import { requireSurface } from "./surface";

const DAYS = 8; // today and the next 7
const MAX_ROWS = 2000; // a week of every calendar is far below this

const row = v.object({
  eventId: v.string(), calendarId: v.string(), calendar: v.string(), title: v.string(), allDay: v.boolean(),
  startMs: v.number(), endMs: v.number(), status: v.string(), attendees: v.array(v.string()),
  organizerSelf: v.boolean(), responseStatus: v.optional(v.string()),
});

/** HTR may read this tenant's calendar: the owner's Gmail, granted with the calendar scopes. */
const readsCalendar = (t: Doc<"tenants">) => !t.demo && t.adapters?.mail?.kind === "gmail" && hasCalendar(t.channels.gmail?.scope);

const snapshotOf = (ctx: QueryCtx, tenantId: Id<"tenants">) =>
  ctx.db.query("calendarSnapshots").withIndex("by_tenant", (q) => q.eq("tenantId", tenantId)).unique();

const rowsOf = (ctx: QueryCtx, tenantId: Id<"tenants">, before: number) =>
  ctx.db.query("calendarEvents").withIndex("by_tenant_start", (q) => q.eq("tenantId", tenantId).lt("startMs", before)).take(MAX_ROWS);

// ---- the refresh ---------------------------------------------------------------------------------

export const tenantsToRefresh = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"tenants">[]> => (await ctx.db.query("tenants").take(200)).filter(readsCalendar),
});

export const tenantById = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<Doc<"tenants"> | null> => await ctx.db.get(tenantId),
});

/** The new window, whole: the tenant's old rows go, these come in, in one transaction. */
export const store = internalMutation({
  args: { tenantId: v.id("tenants"), windowStart: v.number(), windowEnd: v.number(), at: v.number(), events: v.array(row) },
  handler: async (ctx, { tenantId, windowStart, windowEnd, at, events }) => {
    for await (const old of ctx.db.query("calendarEvents").withIndex("by_tenant_start", (q) => q.eq("tenantId", tenantId))) {
      await ctx.db.delete(old._id);
    }
    for (const e of events) await ctx.db.insert("calendarEvents", { tenantId, ...e });
    const fresh = { windowStart, windowEnd, refreshedAt: at, failedAt: undefined, error: undefined };
    const snap = await snapshotOf(ctx, tenantId);
    if (snap) await ctx.db.patch(snap._id, fresh);
    else await ctx.db.insert("calendarSnapshots", { tenantId, ...fresh });
  },
});

/** A refresh that failed: the rows stay, the snapshot says when and why. */
export const recordFailure = internalMutation({
  args: { tenantId: v.id("tenants"), at: v.number(), error: v.string() },
  handler: async (ctx, { tenantId, at, error }) => {
    const snap = await snapshotOf(ctx, tenantId);
    if (snap) await ctx.db.patch(snap._id, { failedAt: at, error });
    else await ctx.db.insert("calendarSnapshots", { tenantId, failedAt: at, error });
  },
});

export type RefreshOutcome = "refreshed" | "skipped" | "failed";

async function refreshTenant(ctx: ActionCtx, tenant: Doc<"tenants">): Promise<RefreshOutcome> {
  if (!readsCalendar(tenant)) return "skipped";
  const now = Date.now();
  const windowStart = atLocalHour(now, tenant.timeZone, 0, 0);
  const windowEnd = atLocalHour(now, tenant.timeZone, DAYS, 0);
  try {
    const claw = calendarClaw(tenant)!;
    const calendars = await claw.calendars();
    const names = new Map(calendars.map((c) => [c.id, c.summary]));
    const events = await claw.events({ start: windowStart, end: windowEnd }, calendars.map((c) => c.id));
    await ctx.runMutation(internal.calendar.store, {
      tenantId: tenant._id, windowStart, windowEnd, at: now,
      events: events.map((e) => ({
        eventId: e.id, calendarId: e.calendarId, calendar: names.get(e.calendarId) ?? e.calendarId, title: e.title,
        allDay: e.allDay, startMs: e.start, endMs: e.end, status: e.status, attendees: e.attendees,
        organizerSelf: e.organizerSelf, ...(e.responseStatus ? { responseStatus: e.responseStatus } : {}),
      })),
    });
    return "refreshed";
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e);
    console.error(`calendar refresh failed for ${tenant.slug}: ${error}`);
    await ctx.runMutation(internal.calendar.recordFailure, { tenantId: tenant._id, at: now, error });
    return "failed";
  }
}

/** One tenant, now: the dispatcher calls this after it writes, so the desk shows the new event. */
export const refresh = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<RefreshOutcome> => {
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.calendar.tenantById, { tenantId });
    return tenant ? await refreshTenant(ctx, tenant) : "skipped";
  },
});

/** The cron. One tenant failing doesn't stop the others. */
export const refreshAll = internalAction({
  args: {},
  handler: async (ctx): Promise<Partial<Record<RefreshOutcome, number>>> => {
    const tally: Partial<Record<RefreshOutcome, number>> = {};
    for (const tenant of await ctx.runQuery(internal.calendar.tenantsToRefresh, {})) {
      const outcome = await refreshTenant(ctx, tenant);
      tally[outcome] = (tally[outcome] ?? 0) + 1;
    }
    return tally;
  },
});

// ---- reading it ----------------------------------------------------------------------------------

/** Snapshot rows overlapping [startMs, endMs), in start order. Move matching reads this. */
export const eventsIn = internalQuery({
  args: { tenantId: v.id("tenants"), startMs: v.number(), endMs: v.number() },
  handler: async (ctx, { tenantId, startMs, endMs }): Promise<Doc<"calendarEvents">[]> =>
    (await rowsOf(ctx, tenantId, endMs)).filter((e) => e.endMs > startMs),
});

const ymd = (ms: number, zone: string) => {
  const p = localParts(ms, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/**
 * The desk's Today zone: the stored window, one entry per local day in the tenant's zone, each
 * event under every day it touches. refreshedAt is when the snapshot was taken; error is the last
 * refresh that failed since then. No snapshot yet: no days.
 */
export const today = query({
  args: { slug: v.string(), key: v.string() },
  handler: async (ctx, { slug, key }) => {
    const tenant = await requireSurface(ctx, slug, key);
    const snap = await snapshotOf(ctx, tenant._id);
    const error = snap?.error !== undefined ? { message: snap.error, at: snap.failedAt ?? null } : null;
    if (snap?.windowStart === undefined || snap.windowEnd === undefined) return { days: [], refreshedAt: null, error };
    const zone = tenant.timeZone;
    const rows = await rowsOf(ctx, tenant._id, snap.windowEnd);
    const days = Array.from({ length: localDaysBetween(snap.windowStart, snap.windowEnd, zone) }, (_, i) => {
      const start = atLocalHour(snap.windowStart!, zone, i, 0);
      const end = atLocalHour(snap.windowStart!, zone, i + 1, 0);
      return {
        date: ymd(start, zone),
        events: rows
          .filter((e) => e.startMs < end && (e.endMs > start || (e.endMs === e.startMs && e.startMs >= start)))
          .map((e) => ({
            id: e.eventId, calendarId: e.calendarId, calendar: e.calendar, title: e.title, allDay: e.allDay,
            startMs: e.startMs, endMs: e.endMs, status: e.status, attendees: e.attendees,
            organizerSelf: e.organizerSelf, responseStatus: e.responseStatus ?? null,
          })),
      };
    });
    return { days, refreshedAt: snap.refreshedAt ?? null, error };
  },
});
