// Email, both channels, one inbox (AgentMail). Counterparties write to the inbox; the digest
// goes out of it to the owner; the owner's reply comes back into it as a ruling; signed drafts
// go out of it to the counterparty, in the thread they answer.
//
// `receive` is the transaction the webhook lands in. Everything that touches the network is an
// action scheduled from it.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { appendEvent, recordAction } from "./events";
import { calendarClaw, mailClaw, notifyClaw } from "./adapters/resolve";
import type { MailClaw, Notice, Sent } from "./adapters/ports";
import { checkTime, formatSlot } from "./lib/calendar/availability";
import { busyFor } from "./lib/calendar/busy";
import { eventIdFor } from "./lib/calendar/id";
import { AgentMail } from "./lib/mail/agentmail";
import { stripFooter, type InboundMail } from "./lib/mail/inbound";
import { looksAutomated } from "./lib/reader/automated";
import { alertAt, score } from "./lib/reader/priority";
import { acknowledgeSite } from "./facts";
import { siteToken } from "./lib/rulings/token";
import { SITE_HEADER } from "./lib/site/publish";
import { bySource, supersede } from "./proposals";
import { handleOwnerReply } from "./rulings";
import { dispatchTask } from "./tasks";
import { liveSurfaceUrl, siteSecret, siteUrl } from "./surface";

export function client(): AgentMail {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not set on the deployment");
  return new AgentMail(apiKey);
}

const reSubject = (s: string | undefined) => (s ? (/^re:/i.test(s) ? s : `Re: ${s}`) : "Re: your message");

export const inboundMail = v.object({
  id: v.string(), inboxId: v.string(), threadId: v.string(), fromAddress: v.string(), fromName: v.optional(v.string()),
  to: v.array(v.string()), subject: v.string(), text: v.string(), receivedAt: v.number(),
  messageId: v.optional(v.string()), inReplyTo: v.optional(v.string()), references: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
});

// ---- inbound ----------------------------------------------------------------------------------

export type ReceiveOutcome = "duplicate" | "ruling" | "automated" | "drafting" | "echo" | "site";

/** The header the front door's pretend customer signs with; see demo.ts. */
export const CUSTOMER_HEADER = "x-htr-customer";

export async function receiveMail(ctx: MutationCtx, tenant: Doc<"tenants">, m: InboundMail): Promise<ReceiveOutcome> {
  if (!(await recordAction(ctx, tenant._id, `mail:${m.id}`, "receive_mail", { from: m.fromAddress }))) return "duplicate";
  await appendEvent(ctx, tenant._id, "mail.received", { from: m.fromAddress, subject: m.subject });

  // The front door's pretend customer writes from one of our own inboxes (demo.ts), signed with
  // the customer's name in a header; the name is honoured only from our own domain. The reply
  // the owner signs goes back to that inbox, into whatever room holds it: mail from a demo inbox
  // is never drafted there. Nothing answers itself.
  let vouched = false; // a person by construction: skip the automated-mail nets (AgentMail adds List-Unsubscribe to everything it sends)
  if (m.fromAddress.toLowerCase().endsWith("@agentmail.to")) {
    const pool = await ctx.db.query("demoInboxes").withIndex("by_inbox", (q) => q.eq("inboxId", m.fromAddress.toLowerCase())).unique();
    if (pool) {
      await appendEvent(ctx, tenant._id, "mail.echo", { from: m.fromAddress, subject: m.subject });
      return "echo";
    }
    const customer = m.headers?.[CUSTOMER_HEADER];
    if (customer) {
      m = { ...m, fromName: customer, text: stripFooter(m.text) };
      vouched = true;
    }
  }

  if (m.fromAddress.toLowerCase() === tenant.owner.email.toLowerCase()) {
    const out = await handleOwnerReply(ctx, tenant, m.fromAddress, m.text);
    if (out.confirmation) {
      await ctx.scheduler.runAfter(0, internal.mail.sendToOwner, {
        tenantId: tenant._id, subject: reSubject(m.subject), text: out.confirmation, inReplyTo: m.id,
      });
    }
    return "ruling";
  }

  // The web agent wrote back: an acknowledgment of a site request, never a draft.
  if (tenant.business.webAgent && m.fromAddress.toLowerCase() === tenant.business.webAgent.toLowerCase()) {
    await acknowledgeSite(ctx, tenant, m);
    return "site";
  }

  const automated = vouched ? false : looksAutomated({ fromAddress: m.fromAddress, subject: m.subject, text: m.text, headers: m.headers });
  const contact = await ctx.db
    .query("contacts")
    .withIndex("by_tenant_address", (q) => q.eq("tenantId", tenant._id).eq("address", m.fromAddress))
    .unique();
  const priority = score({
    subject: m.subject, text: m.text, automated, ownerNames: tenant.owner.names, priorFromSender: contact?.count ?? 0,
    ...(await threadSignals(ctx, tenant._id, m.threadId)), nowMs: Date.now(), timeZone: tenant.timeZone,
  });
  const messageId = await ctx.db.insert("messages", {
    tenantId: tenant._id, channel: "email", direction: "in", fromAddress: m.fromAddress, toAddress: m.to[0],
    body: m.text.slice(0, 8000), at: m.receivedAt, vendorRef: m.id, threadId: m.threadId,
    meta: { subject: m.subject, messageId: m.messageId, references: m.references, name: m.fromName, automated, priority },
  });
  if (contact) await ctx.db.patch(contact._id, { name: m.fromName ?? contact.name, lastSeenAt: m.receivedAt, count: contact.count + 1 });
  else await ctx.db.insert("contacts", { tenantId: tenant._id, address: m.fromAddress, name: m.fromName, lastSeenAt: m.receivedAt, count: 1 });
  if (automated) return "automated";
  if (priority.level === "high") {
    const at = alertAt(Date.now(), tenant.owner.quietHours, tenant.timeZone);
    await ctx.scheduler.runAt(at, internal.mail.alertOwner, { messageId });
    await appendEvent(ctx, tenant._id, "mail.priority", { messageId, score: priority.score, reasons: priority.reasons, alertAt: at });
  }
  await ctx.scheduler.runAfter(0, internal.drafter.draft, { messageId });
  return "drafting";
}

/** What the thread says before this message: did the owner write in it, and how did they rule on its drafts. */
async function threadSignals(ctx: MutationCtx, tenantId: Id<"tenants">, threadId: string | undefined) {
  const out = { repliesToOwner: false, threadRulings: { agreed: 0, skipped: 0 } };
  if (!threadId) return out;
  const thread = await ctx.db.query("messages").withIndex("by_tenant_thread", (q) => q.eq("tenantId", tenantId).eq("threadId", threadId)).take(50);
  for (const msg of thread) {
    if (msg.direction === "out") {
      out.repliesToOwner = true;
      continue;
    }
    const p = await bySource(ctx, tenantId, msg.channel, msg._id);
    if (!p) continue;
    if (p.status === "signed" || p.status === "sending" || p.status === "sent") out.threadRulings.agreed++;
    else if (p.status === "rejected") out.threadRulings.skipped++;
  }
  return out;
}

/** High priority: the owner's phone now (or when quiet hours end), before any draft exists. */
export const alertOwner = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<boolean> => {
    const msg = await ctx.runQuery(internal.mail.message, { messageId });
    if (!msg) return false;
    const tenant = await ctx.runQuery(internal.tenants.get, { tenantId: msg.tenantId });
    const notify = tenant && notifyClaw(tenant);
    if (!tenant || !notify) return false;
    await notify.push(priorityNotice(msg, await liveSurfaceUrl(tenant.slug)));
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId: tenant._id, kind: "mail.alerted", payload: { messageId } });
    return true;
  },
});

export const message = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => await ctx.db.get(messageId),
});

export function priorityNotice(msg: Doc<"messages">, surface: string): Notice {
  const who = msg.meta.name ? `${msg.meta.name} <${msg.fromAddress}>` : msg.fromAddress;
  const why = msg.meta.priority?.reasons.length ? `\n\nWhy now: ${msg.meta.priority.reasons.join(", ")}` : "";
  return {
    title: `Priority: ${msg.meta.subject || "(no subject)"}`.slice(0, 200),
    message: `From ${who}\n\n${msg.body.replace(/\s+/g, " ").trim().slice(0, 600)}${why}\n\nA draft follows.`,
    tags: ["rotating_light"],
    priority: 4,
    click: surface,
  };
}

export const receive = internalMutation({
  args: { tenantId: v.id("tenants"), mail: inboundMail },
  handler: async (ctx, { tenantId, mail }): Promise<ReceiveOutcome> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    return await receiveMail(ctx, tenant, mail);
  },
});

/**
 * Re-run the automated rule over what is still waiting (Python HTR's mail_reclassify). Run it
 * whenever the rule changes: a pending email draft whose message, or whose recipient, now reads
 * as automated is superseded, and its message is marked. Headers aren't stored, so this sees
 * sender, subject and body only. Pending drafts are few; one bounded pass is enough.
 */
export const reclassify = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.object({ checked: v.number(), withdrawn: v.number() }),
  handler: async (ctx, { tenantId }) => {
    const pending = await ctx.db
      .query("proposals")
      .withIndex("by_tenant_status", (q) => q.eq("tenantId", tenantId).eq("status", "pending"))
      .take(500);
    let withdrawn = 0;
    for (const p of pending) {
      if (p.kind !== "email") continue;
      const msg = p.sourceKind === "email" && p.sourceId ? await ctx.db.get(p.sourceId as Id<"messages">) : null;
      const fromMessage = msg ? looksAutomated({ fromAddress: msg.fromAddress, subject: msg.meta.subject, text: msg.body }) : false;
      if (!fromMessage && !looksAutomated({ fromAddress: p.toAddress })) continue;
      if ((await supersede(ctx, p._id)) === null) continue;
      if (msg) await ctx.db.patch(msg._id, { meta: { ...msg.meta, automated: true } });
      await appendEvent(ctx, tenantId, "mail.reclassified", { proposalId: p._id, to: p.toAddress });
      withdrawn++;
    }
    return { checked: pending.length, withdrawn };
  },
});

// ---- outbound ---------------------------------------------------------------------------------

/** To the owner, from the assistant's inbox. A reply when we have the message it answers. */
export const sendToOwner = internalAction({
  args: { tenantId: v.id("tenants"), subject: v.string(), text: v.string(), html: v.optional(v.string()), inReplyTo: v.optional(v.string()) },
  handler: async (ctx, { tenantId, subject, text, html, inReplyTo }): Promise<string | null> => {
    const tenant = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant) throw new Error("unknown tenant");
    const mail = mailClaw(tenant);
    const res = inReplyTo ? await mail.reply(inReplyTo, { text, html }) : await mail.send({ to: [tenant.owner.email], subject, text, html });
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "mail.sent_owner", payload: { subject, ref: res.ref } });
    return res.ref ?? null;
  },
});

/** The hold notice: the one thing the assistant sends alone. */
export const sendNotice = internalAction({
  args: { tenantId: v.id("tenants"), toAddress: v.string(), subject: v.string(), text: v.string(), inReplyTo: v.optional(v.string()) },
  handler: async (ctx, { tenantId, toAddress, subject, text, inReplyTo }) => {
    const tenant = await ctx.runQuery(internal.tenants.get, { tenantId });
    if (!tenant) throw new Error("unknown tenant");
    const mail = mailClaw(tenant);
    const res = inReplyTo ? await mail.reply(inReplyTo, { text }) : await mail.send({ to: [toAddress], subject, text });
    await ctx.runMutation(internal.drafter.noteEvent, { tenantId, kind: "notice.sent", payload: { to: toAddress, ref: res.ref } });
  },
});

/**
 * A signed proposal goes out as the owner, once. The status transitions are the idempotency:
 * only SIGNED becomes SENDING; a failure leaves FAILED, which a retry puts back to SIGNED first.
 * Each kind goes out through its claw (DISPATCH below); the core never names a vendor.
 */
export const dispatch = internalAction({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, { proposalId }): Promise<DispatchOutcome> => {
    const p = await ctx.runMutation(internal.proposals.claimForSend, { proposalId });
    if (!p) return "nothing to do"; // already sent, or never signed
    const tenant = await ctx.runQuery(internal.tenants.get, { tenantId: p.tenantId });
    if (!tenant) throw new Error("unknown tenant");
    try {
      const out = await DISPATCH[p.kind](tenant, p, ctx);
      if ("noLongerFree" in out) {
        // Nothing was written or sent: the card closes, and its email is drafted again (R16).
        await ctx.runMutation(internal.proposals.closeNoLongerFree, { proposalId, reason: out.noLongerFree });
        await pushEventNotice(tenant, p, noLongerFreeNotice(p, out.noLongerFree, await liveSurfaceUrl(tenant.slug)));
        return "no longer free";
      }
      await ctx.runMutation(internal.proposals.finishSend, { proposalId, ref: out.ref, threadId: out.threadId });
      if (out.task) await ctx.runMutation(internal.tasks.noteTask, { proposalId, url: out.task.url, status: out.task.status, done: false });
      if (p.kind === "event") await ctx.scheduler.runAfter(0, internal.calendar.refresh, { tenantId: tenant._id }); // the desk shows it
      return "sent";
    } catch (e) {
      await ctx.runMutation(internal.proposals.finishSend, { proposalId, error: String(e) });
      // An owner who approved an event card from the phone has no other way to learn nothing went out.
      if (p.kind === "event") await pushEventFailure(tenant, p, String(e));
      throw e;
    }
  },
});

export type DispatchOutcome = "nothing to do" | "sent" | "no longer free";

async function pushEventFailure(tenant: Doc<"tenants">, p: Doc<"proposals">, error: string) {
  await pushEventNotice(tenant, p, eventFailedNotice(p, error, await liveSurfaceUrl(tenant.slug)));
}

async function pushEventNotice(tenant: Doc<"tenants">, p: Doc<"proposals">, n: Notice) {
  const notify = notifyClaw(tenant);
  if (!notify) return;
  try {
    await notify.push(n);
  } catch (e) {
    console.error(`ntfy push failed for event card ${p._id}: ${e}`); // the card shows it regardless
  }
}

/** An event card whose time was taken before the approval landed: nothing went out, a fresh draft follows. */
export function noLongerFreeNotice(p: Doc<"proposals">, reason: string, surface: string): Notice {
  return {
    title: `Not sent: ${p.meta.event?.title ?? p.toName ?? p.toAddress}`.slice(0, 200),
    message: `${reason}. Nothing was added to your calendar or sent; a fresh reply is being drafted.`,
    tags: ["calendar"],
    priority: 3,
    click: surface,
    actions: [{ action: "view", label: "Open", url: surface }],
  };
}

/** A failed event card on the phone: its reason, and the page where Retry and Skip are. */
export function eventFailedNotice(p: Doc<"proposals">, error: string, surface: string): Notice {
  return {
    title: `Not sent: ${p.meta.event?.title ?? p.toName ?? p.toAddress}`.slice(0, 200),
    message: `${error.replace(/^Error:\s*/, "").slice(0, 600)}\n\nRetry or skip it on the page.`,
    tags: ["warning"],
    priority: 4,
    click: surface,
    actions: [{ action: "view", label: "Open", url: surface }],
  };
}

/** What a kind's dispatch did: went out, or (an event card) found its time taken and sent nothing. */
type Dispatched = (Sent & { task?: { url: string; status: string } }) | { noLongerFree: string };

/** A card's words, in the thread they answer when there is one. */
function replyOf(tenant: Doc<"tenants">, p: Doc<"proposals">): Promise<Sent> {
  const mail = mailClaw(tenant);
  return p.meta.messageId ? mail.reply(p.meta.messageId, { text: p.body }) : mail.send({ to: [p.toAddress], subject: reSubject(p.meta.subject), text: p.body });
}

/** Kind -> the claw that carries it. sms has no messaging claw yet (merge plan, phase 5): it fails loudly. */
const DISPATCH: Record<Doc<"proposals">["kind"], (tenant: Doc<"tenants">, p: Doc<"proposals">, ctx: ActionCtx) => Promise<Dispatched>> = {
  email: (tenant, p) => replyOf(tenant, p),
  site: (tenant, p) => sendSiteRequest(mailClaw(tenant), tenant, p),
  // Not mail: the tasks claw. ref = the task id the sync reads back.
  task: async (tenant, p) => {
    const made = await dispatchTask(tenant, p);
    return { ref: made.id, task: { url: made.url, status: made.status } };
  },
  sms: async () => {
    throw new Error("no messaging claw can text yet; sms proposals cannot be sent");
  },
  event: (tenant, p, ctx) => dispatchEvent(ctx, tenant, p),
};

/**
 * An event card (KTD5): the calendar write on `primary`, then the reply in thread, idempotent
 * across both. A recorded event id leaves only the reply. An event already at the card's time is
 * taken as written. Otherwise the time is checked again (R16), written, and its id recorded before
 * the reply goes, so a failed reply throws with the event recorded and a retry only replies (R15).
 */
async function dispatchEvent(ctx: ActionCtx, tenant: Doc<"tenants">, p: Doc<"proposals">): Promise<Dispatched> {
  const ev = p.meta.event;
  if (!ev) throw new Error("event card has no event");
  if (!ev.eventId) {
    const claw = calendarClaw(tenant);
    if (!claw) throw new Error("calendar not connected — reconnect Google");
    const id = ev.op === "insert" ? eventIdFor(p._id) : ev.targetEventId;
    if (!id) throw new Error("move card names no event to move");
    const found = await claw.get(id);
    const live = found !== null && found.status !== "cancelled";
    if (ev.op === "move" && !live) throw new Error("the event being moved was deleted on your calendar");
    if (!(live && found.start === ev.startMs && found.end === ev.endMs)) {
      const slot = { start: ev.startMs, end: ev.endMs };
      const busy = await busyFor(claw, slot, id); // the card's own event, or the one it moves, doesn't count against it
      if (checkTime(slot, { busy, nowMs: Date.now(), timeZone: tenant.timeZone }) !== "clean") {
        return { noLongerFree: `${formatSlot(ev.startMs, ev.timeZone)} is no longer free` };
      }
      if (ev.op === "move") await claw.move(id, ev.startMs, ev.endMs, ev.timeZone);
      else {
        const made = await claw.insert({ summary: ev.title, start: ev.startMs, end: ev.endMs, timeZone: ev.timeZone, attendees: ev.attendees }, id);
        if (made.exists) {
          // The id is taken: written by an earlier try, unless the owner has since deleted it.
          const again = await claw.get(id);
          if (!again || again.status === "cancelled") throw new Error("this event was deleted on your calendar");
        }
      }
    }
    await ctx.runMutation(internal.proposals.recordEvent, { proposalId: p._id, eventId: id });
  }
  return await replyOf(tenant, p);
}

/**
 * A site request: a new thread to the web agent, the owner copied, signed in a header so the
 * agent acts only on what HTR sent. The thread id comes back so the agent's reply finds the proposal.
 */
async function sendSiteRequest(mail: MailClaw, tenant: Doc<"tenants">, p: Doc<"proposals">): Promise<Sent> {
  const token = await siteToken(siteSecret(), tenant.slug, p._id);
  return await mail.send({
    to: [p.toAddress], cc: [tenant.owner.email], subject: p.meta.subject ?? `Update ${tenant.business.site ?? "the site"}`, text: p.body,
    headers: { [SITE_HEADER]: `${tenant.slug}:${p._id}:${token}` },
  });
}

/** The surface's retry button for a failed send. */
export const retrySend = action({
  args: { slug: v.string(), key: v.string(), proposalId: v.id("proposals") },
  handler: async (ctx, { slug, key, proposalId }): Promise<DispatchOutcome> => {
    await ctx.runQuery(internal.tenants.requireSurface, { slug, key });
    return await ctx.runAction(internal.mail.dispatch, { proposalId });
  },
});

// ---- provisioning ----------------------------------------------------------------------------

/**
 * `npx convex run mail:provision '{"slug":"tony"}'`: make the inbox, point its webhook at this
 * deployment, remember all of it on the tenant, secret included, so a second client needs no
 * new environment variable. The secret is also returned once, for the log.
 */
export const provision = internalAction({
  args: { slug: v.string(), username: v.optional(v.string()) },
  handler: async (ctx, { slug, username }): Promise<{ inboxId: string; webhookId: string; webhookSecret: string; url: string }> => {
    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.bySlug, { slug });
    if (!tenant) throw new Error(`unknown tenant ${slug}`);
    const c = client();
    let inboxId = tenant.channels.inboxId;
    if (!inboxId) {
      const inbox = await c.createInbox({ username: username ?? `${slug}-htr`, displayName: tenant.displayName });
      inboxId = inbox.inboxId; // an AgentMail inbox id is its address
    }
    const url = `${siteUrl()}/webhooks/${encodeURIComponent(slug)}/mail`;
    const hook = await c.createWebhook({ url, eventTypes: ["message.received"], inboxIds: [inboxId] });
    await ctx.runMutation(internal.tenants.setChannels, {
      tenantId: tenant._id, inboxId, inboxAddress: inboxId, webhookId: hook.webhookId, webhookSecret: hook.secret,
    });
    return { inboxId, webhookId: hook.webhookId, webhookSecret: hook.secret, url };
  },
});
