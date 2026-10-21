// The digest: number what waits, send one message, remember the numbering.
//
// `request` is how a new draft asks for a digest. Immediate mode debounces sixty seconds so
// drafts that land together share one message (the scheduler is the queue; the tenant row
// remembers the pending job). Timed mode is the cron in crons.ts, which calls `run` at the
// owner's hour. `build` is the transaction; `run` is the action that sends it.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { appendEvent } from "./events";
import { plainOverview, renderDigest, renderMeeting, renderMeetings, type DigestItem, type MeetingItem } from "./lib/digest/render";
import { describeGrounding } from "./lib/knowledge/domain";
import { notifyClaw } from "./adapters/resolve";
import { noticeFor } from "./lib/notify/ntfy";
import { eventWhen, eventWho, signLabel } from "./lib/proposals/lifecycle";
import type { Notice } from "./adapters/ports";
import { rulingLinks } from "./lib/rulings/token";
import { unreported } from "./meetings";
import { expire, pendingFor } from "./proposals";
import { liveSurfaceUrl, rulingSecret, siteUrl } from "./surface";

export const DEBOUNCE_MS = 60_000;

export async function requestDigest(ctx: MutationCtx, tenant: Doc<"tenants">) {
  if (tenant.owner.digestAt !== "immediate") return; // the cron will get to it at the owner's hour
  if (tenant.digestScheduled) {
    const job = await ctx.db.system.get(tenant.digestScheduled);
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return;
  }
  const id = await ctx.scheduler.runAfter(DEBOUNCE_MS, internal.digest.run, { tenantId: tenant._id });
  await ctx.db.patch(tenant._id, { digestScheduled: id });
}

export type BuiltDigest = {
  digestId: Id<"digests">;
  body: string;
  items: Array<{ n: number; proposalId: Id<"proposals">; item: DigestItem; grounding?: Doc<"proposals">["grounding"]; pushed: boolean }>; // item.gap: what the room could not answer
  meetings: Array<{ meetingId: Id<"meetings">; item: MeetingItem; pushed: boolean }>; // reported once, in this digest
};

export const build = internalMutation({
  args: { tenantId: v.id("tenants"), weekly: v.optional(v.boolean()) },
  handler: async (ctx, { tenantId, weekly }): Promise<BuiltDigest | null> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    if (weekly) {
      // Last call was last week: what is still waiting now is dropped, quietly (no notice goes out).
      // Not an event card: its deadline before the meeting is its only expiry, and it redrafts (KTD9).
      for (const p of await pendingFor(ctx, tenantId)) {
        if (p.lastCallAt === undefined || p.kind === "event") continue;
        if ((await expire(ctx, p._id)) !== null) await appendEvent(ctx, tenantId, "proposal.last_call_passed", { proposalId: p._id });
      }
    }
    // High priority leads; otherwise the order they arrived in (sort is stable).
    const pending = (await pendingFor(ctx, tenantId)).sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high"));
    const meetings = await unreported(ctx, tenantId);
    if (pending.length === 0 && meetings.length === 0) return null;
    const now = Date.now();
    const numbered = pending.map((p, i) => [i + 1, p] as const);
    const waiting = numbered.length
      ? renderDigest(numbered.map(([n, p]) => [n, p] as [number, DigestItem]), { timeZone: tenant.timeZone, nowMs: now })
      : "";
    const body = [waiting, renderMeetings(meetings, tenant.timeZone, ownerOf(tenant))].filter(Boolean).join("\n\n");
    const digestId = await ctx.db.insert("digests", {
      tenantId,
      mapping: numbered.map(([n, p]) => ({ n, proposalId: p._id })),
      body,
      sentAt: now,
      weekly,
    });
    for (const [n, p] of numbered) await ctx.db.patch(p._id, { digestId, digestNo: n, ...(weekly ? { lastCallAt: now } : {}) });
    for (const m of meetings) await ctx.db.patch(m._id, { digestId });
    await appendEvent(ctx, tenantId, "digest.built", { digestId, count: numbered.length, meetings: meetings.length });
    return {
      digestId,
      body,
      items: numbered.map(([n, p]) => ({
        n,
        proposalId: p._id,
        item: { toAddress: p.toAddress, toName: p.toName, body: p.body, basis: p.basis, kind: p.kind, sourceKind: p.sourceKind, deadline: p.deadline, gap: p.gap, priority: p.priority, event: p.meta.event },
        grounding: p.grounding,
        pushed: p.pushedAt !== undefined,
      })),
      meetings: meetings.map((m) => ({ meetingId: m._id, item: m, pushed: m.pushedAt !== undefined })),
    };
  },
});

export const setRef = internalMutation({
  args: { digestId: v.id("digests"), ref: v.string() },
  handler: async (ctx, { digestId, ref }) => {
    await ctx.db.patch(digestId, { ref });
  },
});

/** The digest email: the numbered text, then one Send / Skip pair per draft, then the live surface. */
export async function digestEmail(tenant: Doc<"tenants">, built: BuiltDigest, weekly = false): Promise<{ subject: string; text: string; html: string }> {
  const base = `${siteUrl()}/rulings`;
  const secret = rulingSecret();
  const surface = await liveSurfaceUrl(tenant.slug);
  const linkLines: string[] = [];
  const cards: string[] = [];
  for (const { n, proposalId, item, grounding } of built.items) {
    const links = await rulingLinks(base, secret, tenant.slug, proposalId);
    linkLines.push(`${n}  Send: ${links.sign}\n    Skip: ${links.reject}\n    Edit: ${links.edit}`);
    const ask = item.basis[0] ? `<p style="color:#5b6070;margin:0 0 8px">“${escapeHtml(item.basis[0])}”</p>` : "";
    const from = describeGrounding(grounding);
    // An event card: what, when, how long, and everyone Google notifies, above the reply that goes with it.
    const ev = item.kind === "event" && item.event
      ? `<p style="margin:0 0 8px"><b>${escapeHtml(item.event.title)}</b><br>${escapeHtml(eventWhen(item.event))}<br>${escapeHtml(eventWho(item.event))}</p>`
      : "";
    const sign = item.kind === "event" ? signLabel(item.kind, item.event) : "Send";
    cards.push(
      `<div style="border:1px solid #d9d8d1;border-radius:8px;padding:14px 16px;margin:12px 0">` +
        `<div style="font-weight:600;margin-bottom:6px">${n} · ${escapeHtml(item.toName || item.toAddress)}</div>${ask}${ev}` +
        `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(item.body)}</p>` +
        (from ? `<p style="color:#5b6070;font-size:.9em;margin:0 0 12px">${escapeHtml(from)}</p>` : "") +
        (item.gap ? `<p style="color:#8a5a00;font-size:.9em;margin:0 0 12px">You haven't told me: ${escapeHtml(item.gap)}. Reply <b>${n} your answer</b> and I'll send it and remember it.</p>` : "") +
        `<a href="${links.sign}" style="background:#1d222c;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;margin-right:8px">${sign}</a>` +
        `<a href="${links.reject}" style="color:#1d222c;padding:8px 14px;border:1px solid #1d222c;border-radius:6px;text-decoration:none;margin-right:8px">Skip</a>` +
        `<a href="${links.edit}" style="color:#1d222c;padding:8px 14px;border:1px solid #d9d8d1;border-radius:6px;text-decoration:none">Edit</a>` +
        `</div>`,
    );
  }
  const count = built.items.length;
  const met = built.meetings.length;
  const notes = met === 1 ? `Meeting notes: ${built.meetings[0].item.title}` : `${met} meeting notes`;
  const subject = count === 0 ? notes : `${weekly ? `Last call: ${count} still waiting on you` : `${count} waiting on you`}${met ? ` · ${met} meeting${met > 1 ? "s" : ""}` : ""}`;
  const lastCall = weekly && count ? "Last call. Anything you haven't ruled on by next week's email is dropped." : "";
  const taps = linkLines.length ? `\n\nOne tap:\n${linkLines.join("\n")}` : "";
  const text = `${lastCall ? `${lastCall}\n\n` : ""}${built.body}${taps}\n\nEverything, live: ${surface}`;
  const waiting = count ? built.body.split(/\n\nMeetings \(\d+\)\n/)[0] : "";
  const meetingHtml = met
    ? `<h2 style="font-size:1.05rem;margin:24px 0 8px">Meetings</h2>` +
      built.meetings.map(({ item }) =>
        `<div style="border:1px solid #d9d8d1;border-radius:8px;padding:14px 16px;margin:12px 0;white-space:pre-wrap">${escapeHtml(renderMeeting(item, tenant.timeZone, ownerOf(tenant)))}</div>`).join("")
    : "";
  const html =
    `<div style="font-family:system-ui,sans-serif;color:#1d222c;max-width:640px">` +
    (lastCall ? `<p style="font-weight:600">${lastCall}</p>` : "") +
    (waiting ? `<p style="white-space:pre-wrap">${escapeHtml(waiting)}</p>` : "") + `${cards.join("")}${meetingHtml}` +
    `<p><a href="${surface}">Everything, live →</a></p></div>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** How the owner shows up in an attendee list: by name, or by address. */
const ownerOf = (t: Doc<"tenants">) => [...t.owner.names, t.owner.email];

export const markPushed = internalMutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }) => {
    await ctx.db.patch(proposalId, { pushedAt: Date.now() });
  },
});

/** Each item not yet on the owner's phone, as its own notification. A failed push is retried next digest. */
async function pushNew(ctx: ActionCtx, tenant: Doc<"tenants">, built: BuiltDigest): Promise<number> {
  const notify = notifyClaw(tenant);
  if (!notify) return 0;
  const base = `${siteUrl()}/rulings`;
  const surface = await liveSurfaceUrl(tenant.slug);
  let sent = 0;
  for (const { proposalId, item, pushed } of built.items) {
    if (pushed) continue;
    try {
      await notify.push(noticeFor(item, await rulingLinks(base, rulingSecret(), tenant.slug, proposalId), surface));
      await ctx.runMutation(internal.digest.markPushed, { proposalId });
      sent++;
    } catch (e) {
      console.error(`ntfy push failed for ${proposalId}: ${e}`);
    }
  }
  for (const { meetingId, item, pushed } of built.meetings) {
    if (pushed) continue;
    try {
      await notify.push(meetingNotice(item, surface));
      await ctx.runMutation(internal.meetings.markPushed, { meetingId });
      sent++;
    } catch (e) {
      console.error(`ntfy push failed for meeting ${meetingId}: ${e}`);
    }
  }
  return sent;
}

/** A meeting on the phone: the overview and the promises; the full note is in the digest. */
export function meetingNotice(m: MeetingItem, surface: string): Notice {
  const items = m.actionItems.slice(0, 8).map((a) => `• ${a.who ? `${a.who}: ` : ""}${a.what}`).join("\n");
  return {
    title: `Meeting: ${m.title}`.slice(0, 200),
    message: [m.overview && plainOverview(m.overview, 600), items].filter(Boolean).join("\n\n").slice(0, 1500) || "No summary yet.",
    tags: ["memo"],
    click: m.url ?? surface,
  };
}

export const run = internalAction({
  args: { tenantId: v.id("tenants"), weekly: v.optional(v.boolean()) },
  handler: async (ctx, { tenantId, weekly }): Promise<Id<"digests"> | null> => {
    const built: BuiltDigest | null = await ctx.runMutation(internal.digest.build, { tenantId, weekly });
    if (!built) return null;
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant) throw new Error("unknown tenant");
    await pushNew(ctx, tenant, built);
    // The phone and the desk are the channel: no email to the owner once push is set up (htr-desk-is-where-the-owner-acts).
    // Email is only the fallback for an install with no push.
    if (notifyClaw(tenant)) return built.digestId;
    if (tenant.owner.weeklyDigest && !weekly) return built.digestId; // pushes now, the email on its weekly day
    const mail = await digestEmail(tenant, built, weekly);
    const ref = await ctx.runAction(internal.mail.sendToOwner, { tenantId, ...mail });
    if (ref) await ctx.runMutation(internal.digest.setRef, { digestId: built.digestId, ref });
    return built.digestId;
  },
});
