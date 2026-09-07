// The drafter: the first reader decides whether a message waits on the owner, then one model
// call writes a reply in the owner's voice plus the quotes it rests on (the Basis discipline,
// STEALS: icm-agent via HTR adapters/llm_openai_compat.py). Any quote the model claims that is
// not actually in the source is dropped, so the owner never rules on evidence that was made up.
//
// OpenAI-compatible over fetch: OPENAI_BASE_URL points it at Omniroute or anything else that
// speaks chat completions. Two things Firecrawl read are in the prompt: the business site
// (knowledge table) so prices and hours come from the site, not from the model, and the sender's
// own site (contact profile, read on first contact from a company address) so the reply knows
// who is writing. So are the owner's last corrections: each edit ruling is a draft and the
// words the owner sent instead, and the model is told to match the owner, not the earlier
// drafts. The owner never confirms twice; the edit is the lesson. What the drafter had in front
// of it is kept on the proposal as `grounding`, so the owner can see why the draft says what it says.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { requestDigest } from "./digest";
import { appendEvent } from "./events";
import { profileSender, retrieve, scrape, type Profile } from "./knowledge";
import { MAX_LESSONS, toLessons, type Lesson } from "./lib/drafter/lessons";
import { notesFromChunks } from "./lib/knowledge/chunk";
import { linksIn } from "./lib/knowledge/links";
import { rankPages } from "./lib/knowledge/rank";
import { chatCompletion } from "./lib/llm/openaiCompat";
import { findDeadline } from "./lib/reader/deadline";
import { latestUnanswered, type Msg } from "./lib/reader/waiting";
import { bySource, pendingFor, propose, supersede } from "./proposals";
import { grounding } from "./schema";

export const SYSTEM =
  "You draft one reply that a business owner will send as themselves. " +
  "Plain, warm, specific. For SMS: under 300 characters. For email: a short email, no subject line, " +
  "a greeting and a sign-off with the owner's first name, under 900 characters. " +
  "Never invent facts, prices, or dates that are not in the input or the business notes. If the request " +
  "needs the owner's decision, say the owner will confirm. " +
  "sender_notes, when present, is what the sender's own website says about them: use it to address them and " +
  "their business correctly, never to claim things they did not write. " +
  "their_links, when present, are the pages they linked in their message, read for you: answer about what is on them. " +
  "owner_facts, when present, are things the owner has told you, often as a reply they once sent to someone else: " +
  "what they state is true and may be used, but write a fresh reply to this counterparty; never copy an earlier greeting, name, or sign-off. " +
  "owner_corrections, when present, are earlier drafts and what the owner actually sent instead: match the " +
  "owner's wording, length, and tone, never the earlier drafts. " +
  "If their message asks for something that neither business_notes, owner_facts, nor the thread answers, do not guess: " +
  "say the owner will confirm that point, and name what is missing in gap as a short noun phrase (\"Saturday opening hours\"). " +
  "Otherwise gap is null. " +
  'Return JSON: {"body": string, "basis": [verbatim quotes from their message the reply rests on], "gap": string | null}.';

export type DraftRequest = {
  businessName: string;
  ownerName: string;
  counterparty: string;
  channel: "email" | "sms" | "call";
  theirMessage: string;
  prior: string[]; // earlier lines in the thread, oldest first, "in: ..." / "out: ..."
  deadlineHint?: string;
  businessNotes?: string; // what the site says, trimmed
  senderNotes?: string; // what the sender's own site says, trimmed
  linkNotes?: Array<{ url: string; title?: string; text: string }>; // the pages they linked, read at draft time
  facts?: Fact[]; // what the owner has told the room, newest first
  lessons?: Lesson[]; // the owner's recent corrections for this tenant, newest first
};

export type Fact = { question?: string; answer: string };

/** A draft; `gap` names what they asked that nothing the room knows answers, so the owner can fill it. */
export type Draft = { body: string; basis: string[]; gap?: string };

export const MAX_GAP = 120;

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
  const gapRaw = typeof data?.gap === "string" ? data.gap.replace(/\s+/g, " ").trim() : "";
  const gap = gapRaw && !/^(null|none|n\/a)$/i.test(gapRaw) ? gapRaw.slice(0, MAX_GAP) : undefined;
  return { body: body.slice(0, 1200), basis: basis.length ? basis : [req.theirMessage.trim().slice(0, 300)], ...(gap ? { gap } : {}) };
}

export const OPENAI_DEFAULT = "https://api.openai.com/v1";

/**
 * OPENAI_BASE_URL as people actually write it: blank, a bare host, no scheme, no /v1, a
 * trailing slash. Always returns a full URL: the SDK reads the raw env var itself when given
 * nothing, which is exactly the value being repaired here.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  let s = (raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return OPENAI_DEFAULT;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/v1";
  return u.toString().replace(/\/+$/, "");
}

/** The user turn: everything the model may draw on, as one JSON object. */
export function userPayload(req: DraftRequest): string {
  const lessons = req.lessons ?? [];
  return JSON.stringify({
    business: req.businessName, owner: req.ownerName, counterparty: req.counterparty, channel: req.channel,
    their_message: req.theirMessage, prior: req.prior, deadline_hint: req.deadlineHint ?? null,
    business_notes: req.businessNotes ?? null,
    sender_notes: req.senderNotes ?? null,
    their_links: req.linkNotes?.length ? req.linkNotes.map((l) => ({ url: l.url, title: l.title ?? null, text: l.text })) : null,
    owner_facts: req.facts?.length ? req.facts.map((f) => (f.question ? { asked: f.question, owner_said: f.answer } : { owner_said: f.answer })) : null,
    owner_corrections: lessons.length
      ? lessons.map((l) => ({ their_message: l.theirMessage, first_draft: l.draft, owner_sent: l.sent }))
      : null,
  });
}

export async function callModel(req: DraftRequest): Promise<Draft> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set on the deployment");
  const content = await chatCompletion({
    baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL),
    apiKey,
    model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userPayload(req) }],
    json: true,
  });
  return toDraft(content, req);
}

// ---- the two ends of the action -------------------------------------------------------------

export type DraftContext = {
  msg: Doc<"messages">;
  tenant: Doc<"tenants">;
  thread: Doc<"messages">[];
  contact: Doc<"contacts"> | null;
  knowledge: Doc<"knowledge">[];
  facts: Doc<"facts">[];
  lessons: Lesson[];
  already: boolean;
};

export const MAX_FACTS = 30;

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
    const inThread = await ctx.db
      .query("messages")
      .withIndex("by_tenant_thread", (q) => q.eq("tenantId", msg.tenantId).eq("threadId", msg.threadId))
      .collect();
    const outbound = inThread.filter((m) => m.direction === "out");
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_tenant_address", (q) => q.eq("tenantId", msg.tenantId).eq("address", msg.fromAddress))
      .unique();
    const knowledge = (await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", msg.tenantId)).take(50)).sort((a, b) => a.url.length - b.url.length || (a.url < b.url ? -1 : 1));
    const facts = await ctx.db.query("facts").withIndex("by_tenant_at", (q) => q.eq("tenantId", msg.tenantId)).order("desc").take(MAX_FACTS);
    const lessons = await recentLessons(ctx, msg.tenantId);
    const already = msg.vendorRef ? await bySource(ctx, msg.tenantId, msg.channel, msg._id) : null;
    return { msg, tenant, thread: [...thread, ...outbound].sort((a, b) => a.at - b.at), contact, knowledge, facts, lessons, already: already !== null };
  },
});

/**
 * The owner's last edits for this tenant, newest first: the draft each replaced and the words
 * that went out. The counterparty's side is the basis the draft rested on.
 */
async function recentLessons(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<Lesson[]> {
  const recent = await ctx.db.query("rulings").withIndex("by_tenant_at", (q) => q.eq("tenantId", tenantId)).order("desc").take(60);
  const rows: Array<{ theirMessage?: string; draft?: string; sent?: string }> = [];
  for (const r of recent) {
    if (r.verdict !== "edit" || !r.editBody || !r.draftBody) continue;
    const p = r.proposalId ? await ctx.db.get(r.proposalId) : null;
    rows.push({ theirMessage: p?.basis.join("\n"), draft: r.draftBody, sent: r.editBody });
    if (rows.length >= MAX_LESSONS * 2) break; // toLessons drops the empty pairs; leave it room
  }
  return toLessons(rows);
}

export const record = internalMutation({
  args: {
    messageId: v.id("messages"),
    body: v.string(),
    basis: v.array(v.string()),
    deadline: v.optional(v.number()),
    toName: v.optional(v.string()),
    grounding: v.optional(grounding),
    gap: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, body, basis, deadline, toName, grounding, gap }) => {
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new Error("draft for unknown message");
    const tenant = await ctx.db.get(msg.tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const kind = msg.channel === "sms" ? "sms" : "email";
    const p = await propose(ctx, {
      tenantId: msg.tenantId, toAddress: msg.fromAddress, toName, body, basis, deadline, kind,
      sourceKind: msg.channel, sourceId: msg._id, grounding, gap,
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

/**
 * The site within a budget, in the order given (see lib/knowledge/rank.ts): each page gets at
 * most `perPage` so several fit. Returns the text and the pages that made it in, so the
 * grounding names what the drafter actually read, not everything that was stored.
 */
export function trimNotes<T extends Pick<Doc<"knowledge">, "url" | "title" | "markdown">>(pages: T[], budget = 12_000, perPage = 3_000): { text: string; used: T[] } | undefined {
  if (pages.length === 0) return undefined;
  let out = "";
  const used: T[] = [];
  for (const k of pages) {
    const chunk = `# ${k.title ?? k.url} (${k.url})\n${k.markdown.slice(0, perPage)}\n\n`;
    if (out.length + chunk.length > budget) {
      const room = budget - out.length;
      if (room > 200) {
        out += chunk.slice(0, room);
        used.push(k);
      }
      break;
    }
    out += chunk;
    used.push(k);
  }
  const text = out.trim();
  return text ? { text, used } : undefined;
}

/** The sender's page, short: who they are, not their whole site. */
export function trimProfile(p: NonNullable<Profile> | null, budget = 1500): string | undefined {
  if (!p) return undefined;
  const text = `# ${p.title ?? p.url}\n${p.markdown}`.slice(0, budget).trim();
  return text || undefined;
}

/** The homepage's opening, in front of whatever the index picked: what the business is, before what it says about this. */
export function withHomepage<T extends { url: string; title?: string; text: string }>(picked: T[], pages: Array<Pick<Doc<"knowledge">, "url" | "title" | "markdown">>): T[] {
  const home = [...pages].sort((a, b) => a.url.length - b.url.length || (a.url < b.url ? -1 : 1))[0];
  if (!home || picked.some((p) => p.url === home.url)) return picked;
  return [{ url: home.url, title: home.title, text: home.markdown.slice(0, 700) } as T, ...picked];
}

export const LINK_CAP = 5_000;

/**
 * The pages a message links to, read by Firecrawl now (at most two, a slice of each). A page
 * that will not read is skipped and noted; the draft still goes out, resting on the rest.
 */
export async function readLinks(ctx: ActionCtx, msg: Doc<"messages">): Promise<Array<{ url: string; title?: string; markdown: string; fetchedAt: number }>> {
  const key = process.env.FIRECRAWL_API_KEY;
  const urls = linksIn(msg.body);
  if (!key || urls.length === 0) return [];
  const out: Array<{ url: string; title?: string; markdown: string; fetchedAt: number }> = [];
  for (const url of urls) {
    try {
      const page = await scrape(url, key, fetch, LINK_CAP);
      out.push({ url: page.url, title: page.title, markdown: page.markdown, fetchedAt: Date.now() });
    } catch (e) {
      await ctx.runMutation(internal.drafter.noteEvent, { tenantId: msg.tenantId, kind: "link.failed", payload: { url, error: String(e).slice(0, 200) } });
    }
  }
  return out;
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
    const name = msg.meta.name ?? c.contact?.name; // the name on this message first: the address may be shared (the front door's pretend customers all write from one inbox)
    // First contact from a company address: read their site before writing to them.
    const profile = await profileSender(ctx, c.contact);
    // The pages they linked: "can you quote this?" is a question about what is behind the link.
    const linkNotes = await readLinks(ctx, msg);
    // The site, as much of it as speaks to the message: the vector index's pick of chunks when the
    // site has been embedded; otherwise whole pages ranked by the words they share with the message.
    const question = `${msg.meta.subject ?? ""} ${msg.body}`;
    const picked = await retrieve(ctx, msg.tenantId, question);
    const fromChunks = picked && picked.length ? notesFromChunks(withHomepage(picked, c.knowledge)) : undefined;
    const notes = fromChunks
      ? { text: fromChunks.text, used: fromChunks.used.map((url) => c.knowledge.find((k) => k.url === url) ?? { url, title: undefined, fetchedAt: Date.now() }) }
      : trimNotes(rankPages(c.knowledge, question));
    const businessNotes = notes?.text;
    const req: DraftRequest = {
      businessName: tenant.displayName, ownerName: tenant.owner.name, counterparty: name ?? msg.fromAddress,
      channel: msg.channel, theirMessage: (msg.meta.subject ? `Subject: ${msg.meta.subject}\n\n` : "") + msg.body,
      prior, deadlineHint: hint, businessNotes, senderNotes: trimProfile(profile), lessons: c.lessons,
      linkNotes: linkNotes.map((l) => ({ url: l.url, title: l.title, text: l.markdown })),
      facts: c.facts.map((f) => ({ question: f.question, answer: f.statement ?? f.answer })),
    };
    const d = await callModel(req);
    const grounding = {
      site: notes ? notes.used.map((k) => ({ url: k.url, title: k.title, fetchedAt: k.fetchedAt })) : undefined,
      sender: profile ? { url: profile.url, title: profile.title, fetchedAt: profile.fetchedAt } : undefined,
      facts: c.facts.length ? c.facts.map((f) => ({ question: f.question, at: f.at })) : undefined,
      links: linkNotes.length ? linkNotes.map((l) => ({ url: l.url, title: l.title, fetchedAt: l.fetchedAt })) : undefined,
    };
    return await ctx.runMutation(internal.drafter.record, { messageId, body: d.body, basis: d.basis, deadline, toName: name, grounding, gap: d.gap });
  },
});

export const noteEvent = internalMutation({
  args: { tenantId: v.id("tenants"), kind: v.string(), payload: v.any() },
  handler: async (ctx, { tenantId, kind, payload }) => appendEvent(ctx, tenantId, kind, payload),
});
