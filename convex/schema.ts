// The spine. Tables and indexes, not an object model (the discipline of HTR db.py, restated
// for Convex). Three tables carry the loop: proposals (the lifecycle), rulings (what the owner
// said and what it meant), digests (the numbering a ruling resolves against). events is
// append-only by convention; actions holds the idempotency keys that make replayed webhooks
// harmless. Mutations are transactions, so the status guards in proposals.ts are the store's
// WHERE clauses.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { STATUSES } from "./lib/proposals/lifecycle";

export const status = v.union(...STATUSES.map((s) => v.literal(s)));
export const channel = v.union(v.literal("email"), v.literal("sms"), v.literal("call"));
export const direction = v.union(v.literal("in"), v.literal("out"));

/** The install block. One document per client; adding a client is adding a document. */
export const tenantFields = {
  slug: v.string(), // the path segment in every URL: /webhooks/<slug>/...
  displayName: v.string(),
  timeZone: v.string(),
  owner: v.object({
    name: v.string(),
    names: v.array(v.string()), // how people address the owner; the reader looks for these
    email: v.string(), // THE identity: a ruling by email is checked against this address
    digestAt: v.string(), // "immediate" or "HH:MM" local
    quietHours: v.optional(v.array(v.string())), // ["21:00", "08:00"]
    defaultDeadlineDays: v.number(),
    discloseAssistant: v.boolean(),
    autonomyTier: v.number(), // 0 = everything above the line is ruled
  }),
  business: v.object({
    site: v.optional(v.string()), // Firecrawl reads it; drafts rest on what it says
    bookingLink: v.optional(v.string()),
    agentName: v.string(), // who signs the hold notice's disclosure
    webAgent: v.optional(v.string()), // the address of the agent that edits the site; site proposals go to it
  }),
  channels: v.object({
    inboxId: v.optional(v.string()), // the AgentMail inbox: counterparties write to it, digests go out of it
    inboxAddress: v.optional(v.string()),
    webhookId: v.optional(v.string()),
    webhookSecret: v.optional(v.string()), // this inbox's Svix secret; AGENTMAIL_WEBHOOK_SECRET is the fallback
  }),
  hold: v.optional(v.union(v.null(), v.object({ since: v.number(), until: v.optional(v.string()) }))),
  digestScheduled: v.optional(v.id("_scheduled_functions")), // immediate mode: the debounced digest
  // A try-it tenant: made from the front door, on a leased inbox, gone after the lease.
  demo: v.optional(v.object({ startedAt: v.number(), expiresAt: v.number(), endedAt: v.optional(v.number()) })),
};

/** What a draft rested on besides the message itself: the pages Firecrawl read. */
export const grounding = v.object({
  site: v.optional(v.array(v.object({ url: v.string(), title: v.optional(v.string()), fetchedAt: v.number() }))),
  sender: v.optional(v.object({ url: v.string(), title: v.optional(v.string()), fetchedAt: v.number() })),
  // What the owner has told the room (the facts table), when any of it was in the prompt.
  facts: v.optional(v.array(v.object({ question: v.optional(v.string()), at: v.number() }))),
  // The pages they linked in their message, read at draft time.
  links: v.optional(v.array(v.object({ url: v.string(), title: v.optional(v.string()), fetchedAt: v.number() }))),
});

export default defineSchema({
  tenants: defineTable(tenantFields).index("by_slug", ["slug"]),

  messages: defineTable({
    tenantId: v.id("tenants"),
    channel,
    direction,
    fromAddress: v.string(),
    toAddress: v.optional(v.string()),
    body: v.string(),
    at: v.number(),
    vendorRef: v.optional(v.string()), // AgentMail message_id: the dedupe key
    threadId: v.optional(v.string()),
    meta: v.object({
      subject: v.optional(v.string()),
      messageId: v.optional(v.string()), // RFC 5322 Message-ID
      references: v.optional(v.string()),
      name: v.optional(v.string()),
      automated: v.optional(v.boolean()),
    }),
  })
    .index("by_tenant_at", ["tenantId", "at"])
    .index("by_tenant_thread", ["tenantId", "threadId"])
    .index("by_tenant_from", ["tenantId", "channel", "fromAddress", "at"])
    .index("by_tenant_vendor_ref", ["tenantId", "vendorRef"]),

  proposals: defineTable({
    tenantId: v.id("tenants"),
    kind: v.union(v.literal("email"), v.literal("sms"), v.literal("site")), // site: a request to the web agent, see facts.ts
    toAddress: v.string(),
    toName: v.optional(v.string()),
    body: v.string(),
    basis: v.array(v.string()), // verbatim quotes the draft rests on
    summary: v.string(),
    status,
    sourceKind: v.optional(v.string()), // email | sms | call_message | relist
    sourceId: v.optional(v.string()),
    deadline: v.optional(v.number()),
    digestNo: v.optional(v.number()),
    digestId: v.optional(v.id("digests")),
    edited: v.boolean(),
    sentRef: v.optional(v.string()),
    error: v.optional(v.string()),
    grounding: v.optional(grounding), // what the drafter had in front of it, so the owner can see why
    gap: v.optional(v.string()), // what they asked that nothing the room knows answers; the owner's edit becomes the fact
    meta: v.object({
      subject: v.optional(v.string()),
      threadId: v.optional(v.string()),
      messageId: v.optional(v.string()),
      references: v.optional(v.string()),
    }),
    createdAt: v.number(),
    ruledAt: v.optional(v.number()),
    sentAt: v.optional(v.number()),
  })
    .index("by_tenant_status", ["tenantId", "status", "createdAt"])
    .index("by_tenant_source", ["tenantId", "sourceKind", "sourceId"])
    .index("by_tenant_created", ["tenantId", "createdAt"]),

  rulings: defineTable({
    tenantId: v.id("tenants"),
    proposalId: v.optional(v.id("proposals")),
    digestId: v.optional(v.id("digests")),
    from: v.string(), // the address or surface the ruling came from
    raw: v.string(), // the owner's own words
    verdict: v.string(), // sign | reject | edit | expired | command:<name> | ignored
    editBody: v.optional(v.string()),
    draftBody: v.optional(v.string()), // on an edit: what the draft said before the owner's words replaced it
    at: v.number(),
  }).index("by_tenant_at", ["tenantId", "at"]),

  digests: defineTable({
    tenantId: v.id("tenants"),
    mapping: v.array(v.object({ n: v.number(), proposalId: v.id("proposals") })),
    body: v.string(),
    sentAt: v.number(),
    ref: v.optional(v.string()), // the digest email's message id, so a reply threads back
  }).index("by_tenant_sent", ["tenantId", "sentAt"]),

  events: defineTable({
    tenantId: v.id("tenants"),
    kind: v.string(),
    payload: v.any(),
    at: v.number(),
  }).index("by_tenant_at", ["tenantId", "at"]),

  actions: defineTable({
    tenantId: v.id("tenants"),
    idempotencyKey: v.string(),
    kind: v.string(),
    payload: v.any(),
    at: v.number(),
  }).index("by_tenant_key", ["tenantId", "idempotencyKey"]),

  contacts: defineTable({
    tenantId: v.id("tenants"),
    address: v.string(),
    name: v.optional(v.string()),
    lastSeenAt: v.number(),
    count: v.number(),
    // Who is writing: Firecrawl reads the sender's domain on first contact (never a webmail domain).
    profile: v.optional(v.object({ url: v.string(), title: v.optional(v.string()), markdown: v.string(), fetchedAt: v.number() })),
    profiledAt: v.optional(v.number()), // when we last tried, so a dead domain is not read on every message
  }).index("by_tenant_address", ["tenantId", "address"]),

  knowledge: defineTable({
    tenantId: v.id("tenants"),
    url: v.string(),
    title: v.optional(v.string()),
    markdown: v.string(),
    fetchedAt: v.number(),
  }).index("by_tenant_url", ["tenantId", "url"]),

  // What the owner taught the room. A draft that could not answer a question is marked with the
  // gap; the owner's reply to it is the answer, kept here in the owner's own words and put in
  // front of the drafter from then on. The site is the first brain; this is the second.
  facts: defineTable({
    tenantId: v.id("tenants"),
    question: v.optional(v.string()), // the gap the draft named; absent for a bare "remember ..."
    answer: v.string(), // the owner's words
    proposalId: v.optional(v.id("proposals")), // the draft whose ruling taught it
    statement: v.optional(v.string()), // the same, distilled to plain facts about the business; what the drafter reads
    distilledAt: v.optional(v.number()),
    siteProposalId: v.optional(v.id("proposals")), // the request to put it on the site, when the tenant has a web agent
    onSite: v.optional(v.object({ url: v.string(), at: v.number() })), // the page Firecrawl found it on, once it was
    at: v.number(),
  }).index("by_tenant_at", ["tenantId", "at"]),

  // The business site in pieces, each with its embedding, so the drafter can pull the few that
  // speak to the message instead of the first pages by URL. Rebuilt whenever the site is re-read.
  chunks: defineTable({
    tenantId: v.id("tenants"),
    url: v.string(),
    title: v.optional(v.string()),
    text: v.string(),
    embedding: v.array(v.float64()),
    fetchedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["tenantId"] }),

  // The front door's inboxes. AgentMail inboxes are few (three on the free plan), so demos lease
  // one from this pool rather than making their own; the webhook and its secret live with the inbox.
  demoInboxes: defineTable({
    inboxId: v.string(),
    address: v.string(),
    webhookId: v.string(),
    webhookSecret: v.string(),
    tenantId: v.optional(v.id("tenants")), // who holds the lease
    leasedUntil: v.optional(v.number()),
  })
    .index("by_inbox", ["inboxId"])
    .index("by_tenant", ["tenantId"]),
});
