// The drafter: the first reader decides whether a message waits on the owner, then one model
// call writes a reply in the owner's voice plus the quotes it rests on (the Basis discipline,
// STEALS: icm-agent via HTR adapters/llm_openai_compat.py). Any quote the model claims that is
// not actually in the source is dropped, so the owner never rules on evidence that was made up.
//
// OpenAI SDK, OpenAI-compatible: OPENAI_BASE_URL points it at Omniroute or anything else that
// speaks chat completions. The business site (Firecrawl, knowledge table) is in the prompt so
// prices and hours come from the site, not from the model.

import { v } from "convex/values";
import OpenAI from "openai";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { requestDigest } from "./digest";
import { appendEvent } from "./events";
import { findDeadline } from "./lib/reader/deadline";
import { latestUnanswered, type Msg } from "./lib/reader/waiting";
import { bySource, pendingFor, propose, supersede } from "./proposals";

export const SYSTEM =
  "You draft one reply that a business owner will send as themselves. " +
  "Plain, warm, specific. For SMS: under 300 characters. For email: a short email, no subject line, " +
  "a greeting and a sign-off with the owner's first name, under 900 characters. " +
  "Never invent facts, prices, or dates that are not in the input or the business notes. If the request " +
  "needs the owner's decision, say the owner will confirm. " +
  'Return JSON: {"body": string, "basis": [verbatim quotes from their message the reply rests on]}.';

export type DraftRequest = {
  businessName: string;
  ownerName: string;
  counterparty: string;
  channel: "email" | "sms" | "call";
  theirMessage: string;
  prior: string[]; // earlier lines in the thread, oldest first, "in: ..." / "out: ..."
  deadlineHint?: string;
  businessNotes?: string; // what the site says, trimmed
};

export type Draft = { body: string; basis: string[] };

/** Models wrap JSON in fences or prose despite response_format. Take the first {...} that parses. */
export function extractJson(content: string): Record<string, unknown> | null {
  let text = content.trim();
  if (text.startsWith("```")) text = text.replace(/^```[a-zA-Z]*\s*|\s*```$/g, "");
  const candidates = [text, ...(text.match(/\{[\s\S]*\}/g) ?? [])];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Turn model output into a Draft; basis quotes that are not in the source are dropped. */
export function toDraft(content: string, req: DraftRequest): Draft {
  const data = extractJson(content);
  const body = (data ? String(data.body ?? "") : content.replace(/^`+|`+$/g, "")).trim();
  if (!body) throw new Error("model returned an empty draft");
  const source = `${req.theirMessage}\n${req.prior.join("\n")}`;
  const claimed = Array.isArray(data?.basis) ? (data!.basis as unknown[]).map((x) => String(x).trim()) : [];
  const basis = claimed.filter((q) => q && source.includes(q));
  return { body: body.slice(0, 1200), basis: basis.length ? basis : [req.theirMessage.trim().slice(0, 300)] };
}

export async function callModel(req: DraftRequest): Promise<Draft> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set on the deployment");
  const client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL || undefined });
  const user = JSON.stringify({
    business: req.businessName, owner: req.ownerName, counterparty: req.counterparty, channel: req.channel,
    their_message: req.theirMessage, prior: req.prior, deadline_hint: req.deadlineHint ?? null,
    business_notes: req.businessNotes ?? null,
  });
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    response_format: { type: "json_object" },
  });
  return toDraft(res.choices[0]?.message?.content ?? "", req);
}

// ---- the two ends of the action -------------------------------------------------------------

export type DraftContext = {
  msg: Doc<"messages">;
  tenant: Doc<"tenants">;
  thread: Doc<"messages">[];
  contact: Doc<"contacts"> | null;
  knowledge: Doc<"knowledge">[];
  already: boolean;
};

export const context = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<DraftContext | null> => {
    const msg = await ctx.db.get(messageId);
    if (!msg) return null;
    const tenant = await ctx.db.get(msg.tenantId);
    if (!tenant) return null;
    const thread = await ctx.db
      .query("messages")
      .withIndex("by_tenant_from", (q) => q.eq("tenantId", msg.tenantId).eq("channel", msg.channel).eq("fromAddress", msg.fromAddress))
      .collect();
    const outbound = await ctx.db
      .query("messages")
      .withIndex("by_tenant_thread", (q) => q.eq("tenantId", msg.tenantId).eq("threadId", msg.threadId))
      .filter((q) => q.eq(q.field("direction"), "out"))
      .collect();
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_tenant_address", (q) => q.eq("tenantId", msg.tenantId).eq("address", msg.fromAddress))
      .unique();
    const knowledge = await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", msg.tenantId)).take(8);
    const already = msg.vendorRef ? await bySource(ctx, msg.tenantId, msg.channel, msg._id) : null;
    return { msg, tenant, thread: [...thread, ...outbound].sort((a, b) => a.at - b.at), contact, knowledge, already: already !== null };
  },
});

export const record = internalMutation({
  args: {
    messageId: v.id("messages"),
    body: v.string(),
    basis: v.array(v.string()),
    deadline: v.optional(v.number()),
    toName: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, body, basis, deadline, toName }) => {
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new Error("draft for unknown message");
    const tenant = await ctx.db.get(msg.tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const kind = msg.channel === "sms" ? "sms" : "email";
    const p = await propose(ctx, {
      tenantId: msg.tenantId, toAddress: msg.fromAddress, toName, body, basis, deadline, kind,
      sourceKind: msg.channel, sourceId: msg._id,
      meta: { subject: msg.meta.subject, threadId: msg.threadId, messageId: msg.vendorRef, references: msg.meta.references },
    });
    // The newest message is the one to answer; older pending drafts to this address are moot.
    for (const older of await pendingFor(ctx, msg.tenantId)) {
      if (older._id !== p._id && older.toAddress === p.toAddress && older.kind === kind) await supersede(ctx, older._id);
    }
    await requestDigest(ctx, tenant);
    return p._id;
  },
});

function trimNotes(pages: Doc<"knowledge">[], budget = 6000): string | undefined {
  if (pages.length === 0) return undefined;
  let out = "";
  for (const k of pages) {
    const chunk = `# ${k.title ?? k.url}\n${k.markdown}\n\n`;
    if (out.length + chunk.length > budget) {
      out += chunk.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += chunk;
  }
  return out.trim() || undefined;
}

/** The job: scheduled by mail.receive for every inbound message from a person. Idempotent. */
export const draft = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<Id<"proposals"> | null> => {
    const c: DraftContext | null = await ctx.runQuery(internal.drafter.context, { messageId });
    if (!c || c.already) return null;
    const { msg, tenant, thread } = c;
    const toMsg = (m: Doc<"messages">): Msg => ({ id: m._id, sender: m.direction === "in" ? m.fromAddress : "us", content: m.body, createdAt: m.at });
    const inbound = thread.filter((m) => m.direction === "in").map(toMsg);
    const outbound = thread.filter((m) => m.direction === "out").map(toMsg);
    const newest = latestUnanswered(inbound, outbound);
    if (!newest || newest.id !== msg._id) return null; // answered, or superseded by a newer message

    const now = Date.now();
    const found = findDeadline(msg.body, now, tenant.timeZone);
    const deadline = found && found.deadline > now ? found.deadline : now + tenant.owner.defaultDeadlineDays * 86_400_000;
    const hint = found && found.deadline > now ? found.hint : undefined;
    const prior = thread.filter((m) => m._id !== msg._id).slice(-6).map((m) => `${m.direction}: ${m.body}`);
    const name = c.contact?.name ?? msg.meta.name;
    const req: DraftRequest = {
      businessName: tenant.displayName, ownerName: tenant.owner.name, counterparty: name ?? msg.fromAddress,
      channel: msg.channel, theirMessage: (msg.meta.subject ? `Subject: ${msg.meta.subject}\n\n` : "") + msg.body,
      prior, deadlineHint: hint, businessNotes: trimNotes(c.knowledge),
    };
    const d = await callModel(req);
    return await ctx.runMutation(internal.drafter.record, { messageId, body: d.body, basis: d.basis, deadline, toName: name });
  },
});

export const noteEvent = internalMutation({
  args: { tenantId: v.id("tenants"), kind: v.string(), payload: v.any() },
  handler: async (ctx, { tenantId, kind, payload }) => appendEvent(ctx, tenantId, kind, payload),
});
