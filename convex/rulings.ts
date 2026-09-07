// Rule by reply (STEALS: waggle rulings/controller.ts via HTR rulings/controller.py).
//
// Every pending proposal is numbered into a digest sent to the owner. A reply from the owner's
// address is a ruling; a reply from anyone else is logged and ignored. A tap on a Send / Skip
// link, or a click on the live surface, names the proposal directly. This module applies the
// ruling once, schedules the dispatch, and says what it did.
//
// Two invariants carried over from Waggle:
// - Only the owner may rule. Checked here, not in the webhook.
// - A number in a reply resolves only through the *latest* digest's mapping, and only to a
//   proposal that is still pending. A stale digest cannot approve a newer proposal.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { appendEvent, recordAction } from "./events";
import { holdNotice, isOverdue } from "./lib/digest/expiry";
import { isEmpty, parseReply, stripQuoted, type Verdict } from "./lib/rulings/parse";
import { learn } from "./facts";
import { approve, edit, expire, pendingFor, propose, reject, type Proposal } from "./proposals";
import { requireSurface } from "./surface";

type Tenant = Doc<"tenants">;

export const HELP =
  'I read replies like: "1" or "1 yes" to send draft 1, "2 no" to skip it, ' +
  '"3 your own words" to send those instead, "all", "later", "hold", "remember <a fact>", or "?" for the list.';

const who = (p: Proposal) => p.toName || p.toAddress;

export async function latestDigest(ctx: MutationCtx, tenantId: Id<"tenants">) {
  return await ctx.db.query("digests").withIndex("by_tenant_sent", (q) => q.eq("tenantId", tenantId)).order("desc").first();
}

/**
 * The correction log: every ruling, every edit, every outcome, in the owner's own words. An edit
 * keeps the draft it replaced next to the words that went out: that pair is what the drafter
 * learns from (lib/drafter/lessons.ts), with no further word from the owner.
 */
async function record(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  proposalId: Id<"proposals"> | undefined,
  digestId: Id<"digests"> | undefined,
  from: string,
  raw: string,
  verdict: string,
  editBody?: string,
  draftBody?: string,
) {
  await ctx.db.insert("rulings", { tenantId, proposalId, digestId, from, raw, verdict, editBody, draftBody, at: Date.now() });
}

/** Apply one verdict to one pending proposal. Returns the line that tells the owner what happened. */
export async function applyVerdict(
  ctx: MutationCtx,
  tenant: Tenant,
  p: Proposal,
  n: number | string,
  verdict: Verdict,
  digestId: Id<"digests"> | undefined,
  from: string,
  raw: string,
): Promise<string> {
  if (verdict.kind === "reject") {
    if ((await reject(ctx, p._id)) === null) return `${n}: already ruled.`;
    await record(ctx, tenant._id, p._id, digestId, from, raw, "reject");
    return `Skipped ${n} (${who(p)}).`;
  }
  const words = verdict.kind === "edit" ? verdict.body : "";
  const edited = words ? (await edit(ctx, p._id, words)) !== null : false;
  const signed = await approve(ctx, p._id);
  if (signed === null) return `${n}: already ruled.`; // raced: someone else got there first
  await record(ctx, tenant._id, p._id, digestId, from, raw, edited ? "edit" : "sign", edited ? words : undefined, edited ? p.body : undefined);
  await ctx.scheduler.runAfter(0, internal.mail.dispatch, { proposalId: p._id });
  // The draft named a gap and the owner answered it: the answer is the fact, in the owner's words.
  const learned = edited && p.gap ? await learn(ctx, tenant._id, words, p.gap, p._id) : false;
  return `Sending ${n} to ${who(p)}${edited ? " with your words" : ""}.${learned ? ` Remembered: ${p.gap}.` : ""}`;
}

// ---- inbound: the owner wrote back ----------------------------------------------------------

export type ReplyOutcome = { confirmation: string | null; ignored: boolean };

/**
 * Apply what the owner said. `confirmation` is what to tell them back (null when the digest
 * itself is the answer, or nothing needed saying); `ignored` when the sender was not the owner.
 */
export async function handleOwnerReply(ctx: MutationCtx, tenant: Tenant, from: string, text: string): Promise<ReplyOutcome> {
  if (from.toLowerCase() !== tenant.owner.email.toLowerCase()) {
    await record(ctx, tenant._id, undefined, undefined, from, text, "ignored");
    await appendEvent(ctx, tenant._id, "ruling.ignored", { from });
    return { confirmation: null, ignored: true };
  }

  const parsed = parseReply(stripQuoted(text));
  const digest = await latestDigest(ctx, tenant._id);
  const mapping = new Map<number, Id<"proposals">>((digest?.mapping ?? []).map((m) => [m.n, m.proposalId]));
  const digestId = digest?._id;
  const notes: string[] = [];

  for (const { n, verdict } of parsed.rulings) {
    const pid = mapping.get(n);
    const p = pid ? await ctx.db.get(pid) : null;
    if (!p || p.status !== "pending") {
      notes.push(`${n}: nothing waiting under that number.`);
      await record(ctx, tenant._id, pid, digestId, from, text, "ignored");
      continue;
    }
    notes.push(await applyVerdict(ctx, tenant, p, n, verdict, digestId, from, text));
  }

  for (const { command, arg } of parsed.commands) {
    if (command === "all") {
      const targets = digestId ? (await pendingFor(ctx, tenant._id)).filter((p) => p.digestId === digestId) : [];
      if (targets.length === 0) notes.push("Nothing in the last digest is still waiting.");
      for (const p of targets) notes.push(await applyVerdict(ctx, tenant, p, p.digestNo ?? 0, { kind: "sign" }, digestId, from, text));
    } else if (command === "later") {
      const n = (await pendingFor(ctx, tenant._id)).length;
      notes.push(`Left ${n} waiting for the next digest.`);
      await record(ctx, tenant._id, undefined, digestId, from, text, "command:later");
    } else if (command === "hold") {
      await setHold(ctx, tenant, arg ?? undefined);
      notes.push(`Holding the room${arg ? ` until ${arg}` : ""}. Drafts keep stacking; reply ? any time.`);
    } else if (command === "remember") {
      await record(ctx, tenant._id, undefined, digestId, from, text, "command:remember");
      notes.push((await learn(ctx, tenant._id, arg ?? "")) ? `Remembered: ${arg}` : "I already knew that.");
    } else if (command === "digest") {
      await record(ctx, tenant._id, undefined, digestId, from, text, "command:digest");
      if ((await pendingFor(ctx, tenant._id)).length > 0) {
        await ctx.scheduler.runAfter(0, internal.digest.run, { tenantId: tenant._id });
        return { confirmation: null, ignored: false }; // the digest itself is the reply
      }
      notes.push("Nothing waiting on you.");
    }
  }

  if (isEmpty(parsed) && parsed.unparsed.length) notes.push(HELP);
  if (notes.length === 0) return { confirmation: null, ignored: false };
  await appendEvent(ctx, tenant._id, "ruling.applied", {
    rulings: parsed.rulings.length,
    commands: parsed.commands.map((c) => c.command),
  });
  return { confirmation: notes.join("\n"), ignored: false };
}

/** A ruling that names the proposal directly (a link, the surface), not a digest number. */
export async function ruleById(
  ctx: MutationCtx,
  tenant: Tenant,
  proposalId: Id<"proposals">,
  verdict: Verdict,
  via: string,
): Promise<string> {
  const p = await ctx.db.get(proposalId);
  if (!p || p.tenantId !== tenant._id || p.status !== "pending") return "Nothing waiting under that draft.";
  const note = await applyVerdict(ctx, tenant, p, p.digestNo ?? "the draft", verdict, p.digestId, via, `${via}:${verdict.kind}`);
  await appendEvent(ctx, tenant._id, "ruling.applied", { rulings: 1, via });
  return note;
}

export const ruleByLink = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    proposalId: v.id("proposals"),
    verdict: v.union(v.literal("sign"), v.literal("reject"), v.literal("edit")),
    body: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, proposalId, verdict, body }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const ruling: Verdict = verdict === "edit" ? { kind: "edit", body: (body ?? "").trim() } : { kind: verdict };
    if (ruling.kind === "edit" && !ruling.body) return "Nothing to send: the words were empty.";
    return await ruleById(ctx, tenant, proposalId, ruling, "link");
  },
});

/** The live surface: Send, Skip, or send-these-words-instead. */
export const ruleFromSurface = mutation({
  args: {
    slug: v.string(),
    key: v.string(),
    proposalId: v.id("proposals"),
    verdict: v.union(v.literal("sign"), v.literal("reject"), v.literal("edit")),
    body: v.optional(v.string()),
  },
  handler: async (ctx, { slug, key, proposalId, verdict, body }) => {
    const tenant = await requireSurface(ctx, slug, key);
    const ruling: Verdict = verdict === "edit" ? { kind: "edit", body: (body ?? "").trim() } : { kind: verdict };
    if (ruling.kind === "edit" && !ruling.body) return "Nothing to send: the words were empty.";
    return await ruleById(ctx, tenant, proposalId, ruling, "surface");
  },
});

export const fromEmail = internalMutation({
  args: { tenantId: v.id("tenants"), from: v.string(), text: v.string() },
  handler: async (ctx, { tenantId, from, text }): Promise<ReplyOutcome> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    return await handleOwnerReply(ctx, tenant, from, text);
  },
});

// ---- hold the room ---------------------------------------------------------------------

export async function setHold(ctx: MutationCtx, tenant: Tenant, until?: string) {
  await ctx.db.patch(tenant._id, { hold: { since: Date.now(), until } });
  await appendEvent(ctx, tenant._id, "hold.set", { until });
  await record(ctx, tenant._id, undefined, undefined, tenant.owner.email, `hold ${until ?? ""}`.trim(), "command:hold");
}

export async function clearHold(ctx: MutationCtx, tenant: Tenant) {
  await ctx.db.patch(tenant._id, { hold: null });
  await appendEvent(ctx, tenant._id, "hold.cleared", {});
}

// ---- expiry -------------------------------------------------------------------------------

/**
 * Overdue drafts stop waiting: tell the counterparty (the one thing the assistant may do
 * alone), and re-list the item so it heads the next digest. Never sends the draft.
 */
export async function expirePass(ctx: MutationCtx, tenant: Tenant, now = Date.now()): Promise<Id<"proposals">[]> {
  const expired: Id<"proposals">[] = [];
  for (const p of await pendingFor(ctx, tenant._id)) {
    if (!isOverdue(p, now)) continue;
    if ((await expire(ctx, p._id)) === null) continue;
    await appendEvent(ctx, tenant._id, "proposal.expired", { proposalId: p._id });
    const first = await recordAction(ctx, tenant._id, `proposal:${p._id}:expired_notice`, "send_mail", { to: p.toAddress, reason: "expired" });
    if (first && p.kind === "email") {
      await ctx.scheduler.runAfter(0, internal.mail.sendNotice, {
        tenantId: tenant._id,
        toAddress: p.toAddress,
        subject: p.meta.subject ? `Re: ${p.meta.subject.replace(/^re:\s*/i, "")}` : "Re: your message",
        text: holdNotice(tenant),
        inReplyTo: p.meta.messageId,
      });
    }
    await propose(ctx, {
      tenantId: tenant._id, toAddress: p.toAddress, toName: p.toName, body: p.body, basis: p.basis,
      sourceKind: "relist", sourceId: p._id, kind: p.kind, meta: p.meta,
    });
    await record(ctx, tenant._id, p._id, p.digestId, "clock", "", "expired");
    expired.push(p._id);
  }
  return expired;
}

export const expireAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const tenant of await ctx.db.query("tenants").collect()) n += (await expirePass(ctx, tenant)).length;
    return n;
  },
});
