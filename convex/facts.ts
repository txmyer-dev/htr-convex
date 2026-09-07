// The second brain: what the owner has told the room.
//
// A draft that could not answer a question names the gap; the owner's reply to it is the answer,
// kept here in the owner's own words (`answer`) and put in front of the drafter from then on. A
// reply is a letter, though, with a greeting and a name in it, and a model handed a letter copies
// the letter; so each fact is also distilled, once, into one or two plain statements about the
// business (`statement`), and that is what the drafter reads. The owner's words stay as the record.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { requestDigest } from "./digest";
import { extractJson, normalizeBaseUrl } from "./drafter";
import { appendEvent } from "./events";
import { chatCompletion } from "./lib/llm/openaiCompat";
import type { InboundMail } from "./lib/mail/inbound";
import { saysOnSite, SITE_NAME, siteRequest, siteSubject } from "./lib/site/publish";
import { markLive as markLiveProposal, propose, withStatus } from "./proposals";

export const DISTILL =
  "You turn a business owner's reply into what it tells you about the business. " +
  "Return JSON: {\"statement\": string}: one or two plain sentences, third person, present tense, facts only " +
  "(hours, prices, policies, places, how to book). No greeting, no names of people, no sign-off, no pleasantries. " +
  "If the reply states no fact about the business, return {\"statement\": null}.";

/** The text the drafter reads for a fact: the distilled statement when there is one, else the owner's words. */
export function factText(f: Pick<Doc<"facts">, "answer" | "statement">): string {
  return f.statement ?? f.answer;
}

/**
 * Keep a fact in the owner's words. Once per (question, answer): a replayed ruling teaches
 * nothing new. Schedules the distillation. Returns true when something was learned.
 */
export async function learn(ctx: MutationCtx, tenantId: Id<"tenants">, answer: string, question?: string, proposalId?: Id<"proposals">): Promise<boolean> {
  const text = answer.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const recent = await ctx.db.query("facts").withIndex("by_tenant_at", (q) => q.eq("tenantId", tenantId)).order("desc").take(50);
  if (recent.some((f) => f.answer === text && (f.question ?? null) === (question ?? null))) return false;
  const factId = await ctx.db.insert("facts", { tenantId, question, answer: text, proposalId, at: Date.now() });
  await appendEvent(ctx, tenantId, "fact.learned", { factId, question, proposalId });
  await ctx.scheduler.runAfter(0, internal.facts.distill, { factId });
  return true;
}

export const setStatement = internalMutation({
  args: { factId: v.id("facts"), statement: v.optional(v.string()) },
  handler: async (ctx, { factId, statement }) => {
    const f = await ctx.db.get(factId);
    if (!f) return;
    await ctx.db.patch(factId, { statement, distilledAt: Date.now() });
  },
});

export const get = internalQuery({
  args: { factId: v.id("facts") },
  handler: async (ctx, { factId }) => await ctx.db.get(factId),
});

/** Pure: the model's JSON to a statement, or null when it found no fact. */
export function toStatement(content: string): string | null {
  const data = extractJson(content);
  const s = data && typeof data.statement === "string" ? data.statement.replace(/\s+/g, " ").trim() : "";
  return s && !/^(null|none)$/i.test(s) ? s.slice(0, 600) : null;
}

/** One model call per fact. A failure leaves the owner's words as the text the drafter reads. */
export const distill = internalAction({
  args: { factId: v.id("facts") },
  handler: async (ctx, { factId }): Promise<string | null> => {
    const f: Doc<"facts"> | null = await ctx.runQuery(internal.facts.get, { factId });
    if (!f) return null;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    try {
      const content = await chatCompletion({
        baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL),
        apiKey,
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        messages: [
          { role: "system", content: DISTILL },
          { role: "user", content: JSON.stringify({ asked: f.question ?? null, owner_replied: f.answer }) },
        ],
        json: true,
      });
      const statement = toStatement(content);
      await ctx.runMutation(internal.facts.setStatement, { factId, statement: statement ?? undefined });
      // Something the site does not say, for a tenant with a web agent: ask to put it there.
      if (statement) await ctx.runMutation(internal.facts.proposeSite, { factId });
      return statement;
    } catch (e) {
      await ctx.runMutation(internal.drafter.noteEvent, { tenantId: f.tenantId, kind: "fact.distill_failed", payload: { factId, error: String(e).slice(0, 200) } });
      return null;
    }
  },
});

// ---- from the room to the site ----------------------------------------------------------------
//
// A fact the site does not say is a site that is behind. When the tenant has a web agent (the
// address of the agent that edits the site), a distilled fact becomes a proposal of kind `site`:
// the request HTR would send that agent. The owner rules it like any draft. Signed, it goes out
// as a new thread to the agent, the owner copied, a signed header on it (mail.ts). The agent
// replies in the thread when the page is live; that reply is never drafted (mail.receive routes
// it here), and Firecrawl reads the site again to see the fact on a page. Then the proposal is
// `live` and the fact points at the page. Nothing here touches the site itself.

export const proposeSite = internalMutation({
  args: { factId: v.id("facts") },
  handler: async (ctx, { factId }): Promise<Id<"proposals"> | null> => {
    const f = await ctx.db.get(factId);
    if (!f || f.siteProposalId) return f?.siteProposalId ?? null;
    const tenant = await ctx.db.get(f.tenantId);
    if (!tenant?.business.webAgent || !tenant.business.site) return null;
    const statement = factText(f);
    const p = await propose(ctx, {
      tenantId: f.tenantId, kind: "site", toAddress: tenant.business.webAgent, toName: SITE_NAME,
      body: siteRequest(tenant.business.site, statement), basis: [statement],
      sourceKind: "fact", sourceId: factId,
      meta: { subject: siteSubject(tenant.business.site, statement) },
    });
    await ctx.db.patch(factId, { siteProposalId: p._id });
    await appendEvent(ctx, f.tenantId, "site.proposed", { factId, proposalId: p._id });
    await requestDigest(ctx, tenant);
    return p._id;
  },
});

/** The web agent wrote back. Find the request its thread answers; record it; go and look at the site. */
export async function acknowledgeSite(ctx: MutationCtx, tenant: Doc<"tenants">, m: InboundMail): Promise<Id<"proposals"> | null> {
  await ctx.db.insert("messages", {
    tenantId: tenant._id, channel: "email", direction: "in", fromAddress: m.fromAddress, toAddress: m.to[0],
    body: m.text.slice(0, 8000), at: m.receivedAt, vendorRef: m.id, threadId: m.threadId,
    meta: { subject: m.subject, messageId: m.messageId, references: m.references, name: m.fromName, automated: true },
  });
  const sent = (await withStatus(ctx, tenant._id, "sent")).filter((p) => p.kind === "site" && p.meta.threadId === m.threadId);
  const p = sent[sent.length - 1];
  if (!p) {
    await appendEvent(ctx, tenant._id, "site.unmatched", { from: m.fromAddress, threadId: m.threadId, subject: m.subject });
    return null;
  }
  await appendEvent(ctx, tenant._id, "site.acknowledged", { proposalId: p._id, text: m.text.slice(0, 200) });
  await ctx.scheduler.runAfter(0, internal.facts.verifySite, { proposalId: p._id, attempt: 1 });
  return p._id;
}

export const VERIFY_ATTEMPTS = 3;
export const VERIFY_RETRY_MS = 5 * 60_000;

/** Read the site again, then see whether a page says what the fact says. A miss is retried a few times: the page may take a minute to deploy. */
export const verifySite = internalAction({
  args: { proposalId: v.id("proposals"), attempt: v.number() },
  handler: async (ctx, { proposalId, attempt }): Promise<string | null> => {
    const p: Doc<"proposals"> | null = await ctx.runQuery(internal.proposals.get, { proposalId });
    if (!p || p.status !== "sent" || p.kind !== "site") return null;
    await ctx.runAction(internal.knowledge.refreshTenant, { tenantId: p.tenantId });
    const url: string | null = await ctx.runMutation(internal.facts.markLive, { proposalId });
    if (!url && attempt < VERIFY_ATTEMPTS) await ctx.scheduler.runAfter(VERIFY_RETRY_MS, internal.facts.verifySite, { proposalId, attempt: attempt + 1 });
    return url;
  },
});

/** The transaction at the end: the page that says it, the proposal live, the fact pointing at the page. */
export const markLive = internalMutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }): Promise<string | null> => {
    const p = await ctx.db.get(proposalId);
    if (!p || p.status !== "sent" || p.kind !== "site" || p.sourceKind !== "fact" || !p.sourceId) return null;
    const f = await ctx.db.get(p.sourceId as Id<"facts">);
    if (!f) return null;
    const pages = await ctx.db.query("knowledge").withIndex("by_tenant_url", (q) => q.eq("tenantId", p.tenantId)).take(100);
    const url = saysOnSite(factText(f), pages);
    if (!url) {
      await appendEvent(ctx, p.tenantId, "site.not_yet", { proposalId, pages: pages.length });
      return null;
    }
    await markLiveProposal(ctx, proposalId);
    await ctx.db.patch(f._id, { onSite: { url, at: Date.now() } });
    await appendEvent(ctx, p.tenantId, "site.live", { proposalId, factId: f._id, url });
    return url;
  },
});
