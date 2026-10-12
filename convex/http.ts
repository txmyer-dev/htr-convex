// The public surface, served on <deployment>.convex.site. Everything slow is scheduled.
//
//   POST /webhooks/{slug}/mail                AgentMail: a ruling from the owner, or an inbound email
//   GET|POST /rulings/{slug}/{id}/{verdict}?t= the Send / Skip links; token-signed
//   GET  /r/{slug}?k=                          the ruling surface, server-rendered (works without JS)
//   GET  /tenants/{slug}/proposals?k=          every proposal and its status, JSON
//   POST|GET /intake/{slug}/call-items          the call line: items in, their states out; bearer intake key
//   GET  /intake/{slug}/agenda?tag=raise-<series>  what waits to be raised at that series' next call
//   GET  /healthz
//   GET  /  and everything else                the live surface (src/, built and uploaded by the static hosting
//                                              component; /?t={slug}&k= is the owner's link)

import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { describeGrounding } from "./lib/knowledge/domain";
import { parseAgentMailEvent } from "./lib/mail/inbound";
import { svixVerify } from "./lib/mail/svix";
import { ntfyConfig } from "./lib/notify/ntfy";
import { rulingLinks, tokenEquals, verifyRulingToken } from "./lib/rulings/token";
import { liveSurfaceUrl, rulingSecret, siteUrl, surfaceKey } from "./surface";
import { agendaFor, intakeKey } from "./tasks";
import type { ProposalView } from "./views";

const http = httpRouter();

const text = (body: string, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (body: string, status = 200) =>
  text(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hold the Room</title>` +
    `<body style="font-family:system-ui,sans-serif;margin:2rem auto;max-width:640px;color:#1d222c;line-height:1.5">${body}</body>`, status, "text/html; charset=utf-8");

const segments = (url: string, prefix: string) => new URL(url).pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);

http.route({
  path: "/healthz",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const tenants = await ctx.runQuery(internal.tenants.all, {});
    return json({ ok: true, tenants: tenants.length });
  }),
});

// ---- mail in ---------------------------------------------------------------------------------

// Two shapes of URL. /webhooks/{slug}/mail is a client's own inbox: the secret is on the tenant
// (or, for client zero, in the environment). /webhooks/pool/mail is every demo inbox: the event
// names the inbox, the inbox knows its secret and who holds its lease. Either way the signature
// is checked before anything is done with the message.
http.route({
  pathPrefix: "/webhooks/",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const [slug, channel] = segments(req.url, "/webhooks/");
    if (channel !== "mail") return text("not found", 404);
    const body = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return text("bad json", 400);
    }
    const { type, mail } = parseAgentMailEvent(payload);

    let tenant: Doc<"tenants"> | null;
    let secret: string | undefined;
    if (slug === "pool") {
      const row = mail?.inboxId ? await ctx.runQuery(internal.demo.inboxByAddress, { inboxId: mail.inboxId }) : null;
      if (!row) return text("unknown inbox", 404);
      secret = row.webhookSecret;
      tenant = row.tenantId ? await ctx.runQuery(internal.tenants.get, { tenantId: row.tenantId }) : null;
    } else {
      tenant = await ctx.runQuery(internal.tenants.bySlug, { slug });
      if (!tenant) return text("unknown tenant", 404);
      secret = tenant.channels.webhookSecret ?? process.env.AGENTMAIL_WEBHOOK_SECRET;
    }
    if (!secret) return text("webhook secret not configured", 500);
    const ok = await svixVerify(secret, {
      "svix-id": req.headers.get("svix-id") ?? undefined,
      "svix-timestamp": req.headers.get("svix-timestamp") ?? undefined,
      "svix-signature": req.headers.get("svix-signature") ?? undefined,
    }, body);
    if (!ok) return text("bad signature", 401);
    if (type !== "message.received" || !mail) return json({ ok: true, ignored: type || "no message" });
    if (!tenant || !tenant.channels.inboxId) return json({ ok: true, ignored: "no lease" });
    if (mail.inboxId && mail.inboxId !== tenant.channels.inboxId) return json({ ok: true, ignored: "other inbox" });
    const outcome = await ctx.runMutation(internal.mail.receive, { tenantId: tenant._id, mail });
    return json({ ok: true, outcome });
  }),
});

// ---- the call line in -----------------------------------------------------------------------------
//   POST /intake/{slug}/call-items   {session, items: [...]}  -> pending task proposals
//   GET  /intake/{slug}/call-items[?session=]               -> what became of each item
//   GET  /intake/{slug}/agenda?tag=raise-<series>          -> open ClickUp tasks with that tag
// Bearer = tasks.intakeKey(slug): may hand items in and read them back, never rule.

const intake = httpAction(async (ctx, req) => {
  const [slug, what] = segments(req.url, "/intake/");
  if (what !== "call-items" && what !== "agenda") return text("not found", 404);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenEquals(await intakeKey(slug), bearer)) return text("bad key", 401);
  const tenant = await ctx.runQuery(internal.tenants.bySlug, { slug });
  if (!tenant) return text("unknown tenant", 404);
  if (what === "agenda") {
    const tag = new URL(req.url).searchParams.get("tag") ?? "";
    if (req.method !== "GET" || !/^raise-[a-z0-9-]+$/.test(tag)) return text("GET ?tag=raise-<series>", 400);
    return json(await agendaFor(tenant, tag));
  }
  if (req.method === "GET") {
    const session = new URL(req.url).searchParams.get("session") ?? undefined;
    return json(await ctx.runQuery(internal.tasks.callItemStates, { tenantId: tenant._id, session }));
  }
  let body: { session?: unknown; items?: unknown };
  try {
    body = await req.json();
  } catch {
    return text("bad json", 400);
  }
  if (typeof body.session !== "string" || !Array.isArray(body.items)) return text("need {session, items[]}", 400);
  const items = body.items.map((i: any) => ({
    id: String(i.id ?? ""), type: String(i.type ?? ""), what: String(i.what ?? ""), quote: String(i.quote ?? ""),
    who: i.who ? String(i.who) : undefined, due: i.due ? String(i.due) : undefined, lane: i.lane ? String(i.lane) : undefined,
    privacy: i.privacy ? String(i.privacy) : undefined, destination: String(i.destination ?? ""),
    series: i.series ? String(i.series) : undefined,
  }));
  return json(await ctx.runMutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: body.session, items }));
});
http.route({ pathPrefix: "/intake/", method: "GET", handler: intake });
http.route({ pathPrefix: "/intake/", method: "POST", handler: intake });

// ---- rulings by link ------------------------------------------------------------------------------

// The ntfy web app taps Send / Skip with a cross-origin fetch, and clears the notification only
// when it can read a 200: let the ntfy server's origin (and only it) read the answer.
function ntfyOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  const cfg = ntfyConfig();
  return origin && cfg && origin === new URL(cfg.url).origin ? origin : null;
}

const ruleByLink = httpAction(async (ctx, req) => {
  const res = await ruleByLinkInner(ctx, req);
  const origin = ntfyOrigin(req);
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  return res;
});

async function ruleByLinkInner(ctx: Parameters<Parameters<typeof httpAction>[0]>[0], req: Request): Promise<Response> {
  const [slug, proposalId, verdict] = segments(req.url, "/rulings/");
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (verdict !== "sign" && verdict !== "reject" && verdict !== "edit") return page("<p>verdict must be sign, reject, or edit</p>", 400);
  if (!(await verifyRulingToken(rulingSecret(), slug, proposalId, verdict, t))) return page("<p>That link is not valid.</p>", 401);
  const tenant = await ctx.runQuery(internal.tenants.bySlug, { slug });
  if (!tenant) return page("<p>Unknown tenant.</p>", 404);
  const back = await liveSurfaceUrl(slug);
  let body: string | undefined;
  if (verdict === "edit") {
    if (req.method === "GET") {
      // The edit form: the current words, ready to be replaced. Posting them signs the draft.
      const p = await ctx.runQuery(internal.proposals.get, { proposalId: proposalId as Id<"proposals"> });
      if (!p || p.tenantId !== tenant._id || p.status !== "pending") return page(`<p>Nothing waiting under that draft.</p><p><a href="${back}">Everything waiting →</a></p>`);
      return page(
        `<h1 style="font-size:1.2rem">Your words to ${escapeHtml(p.toName || p.toAddress)}</h1>` +
          (p.basis[0] ? `<p style="color:#5b6070">“${escapeHtml(p.basis[0])}”</p>` : "") +
          `<form method="post"><textarea name="words" rows="8" style="width:100%;font:inherit;padding:.6rem;border:1px solid #d9d8d1;border-radius:8px">${escapeHtml(p.body)}</textarea>` +
          `<p><button type="submit" style="background:#1d222c;color:#fff;padding:8px 14px;border-radius:6px;border:0;font:inherit">Send my words</button> ` +
          `<a href="${back}" style="margin-left:8px">Back</a></p></form>`,
      );
    }
    const form = await req.formData();
    body = String(form.get("words") ?? "");
  }
  const note = await ctx.runMutation(internal.rulings.ruleByLink, { tenantId: tenant._id, proposalId: proposalId as Id<"proposals">, verdict, body });
  return page(`<p>${escapeHtml(note)}</p><p><a href="${back}">Everything waiting →</a></p>`);
}
http.route({ pathPrefix: "/rulings/", method: "GET", handler: ruleByLink });
http.route({
  pathPrefix: "/rulings/",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, req) => {
    const origin = ntfyOrigin(req);
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "", Vary: "Origin",
      },
    });
  }),
});
http.route({ pathPrefix: "/rulings/", method: "POST", handler: ruleByLink });

// ---- the read-only views --------------------------------------------------------------------------

http.route({
  pathPrefix: "/tenants/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const [slug, what] = segments(req.url, "/tenants/");
    const key = new URL(req.url).searchParams.get("k") ?? "";
    if (!tokenEquals(await surfaceKey(slug), key)) return text("bad key", 401);
    if (what !== "proposals") return text("not found", 404);
    return json(await ctx.runQuery(internal.views.proposals, { slug }));
  }),
});

http.route({
  pathPrefix: "/r/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const [slug] = segments(req.url, "/r/");
    const key = new URL(req.url).searchParams.get("k") ?? "";
    if (!tokenEquals(await surfaceKey(slug), key)) return page("<p>That link is not valid.</p>", 401);
    const tenant = await ctx.runQuery(internal.tenants.bySlug, { slug });
    if (!tenant) return page("<p>Unknown tenant.</p>", 404);
    const rows: ProposalView[] = await ctx.runQuery(internal.views.proposals, { slug });
    const pending = rows.filter((p) => p.status === "pending");
    const base = `${siteUrl()}/rulings`;
    const cards: string[] = [];
    for (const p of pending) {
      const links = await rulingLinks(base, rulingSecret(), slug, p.id);
      cards.push(
        `<div style="border:1px solid #d9d8d1;border-radius:8px;padding:14px 16px;margin:12px 0">` +
          `<div style="font-weight:600">${p.digestNo ? `${p.digestNo} · ` : ""}${escapeHtml(p.toName || p.toAddress)}</div>` +
          (p.subject ? `<div style="color:#5b6070">${escapeHtml(p.subject)}</div>` : "") +
          (p.basis[0] ? `<p style="color:#5b6070;margin:8px 0">“${escapeHtml(p.basis[0])}”</p>` : "") +
          `<p style="white-space:pre-wrap">${escapeHtml(p.body)}</p>` +
          (describeGrounding(p.grounding) ? `<p style="color:#5b6070;font-size:.9em">${escapeHtml(describeGrounding(p.grounding)!)}</p>` : "") +
          (p.gap ? `<p style="color:#8a5a00;font-size:.9em">You haven't told me: ${escapeHtml(p.gap)}. Edit with your answer and I'll remember it.</p>` : "") +
          `<a href="${links.sign}" style="background:#1d222c;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;margin-right:8px">${p.kind === "task" ? "Add task" : "Send"}</a>` +
          `<a href="${links.reject}" style="color:#1d222c;padding:8px 14px;border:1px solid #1d222c;border-radius:6px;text-decoration:none;margin-right:8px">Skip</a>` +
          `<a href="${links.edit}" style="color:#1d222c;padding:8px 14px;border:1px solid #d9d8d1;border-radius:6px;text-decoration:none">Edit</a></div>`,
      );
    }
    const recent = rows.filter((p) => p.status !== "pending").slice(0, 20)
      .map((p) => `<li><span style="color:#5b6070">${p.status}</span> · ${escapeHtml(p.summary)}</li>`).join("");
    return page(
      `<h1 style="font-size:1.4rem">${escapeHtml(tenant.displayName)}</h1>` +
        `<p>${pending.length === 0 ? "Nothing waiting on you." : `${pending.length} waiting on you.`}</p>${cards.join("")}` +
        (recent ? `<h2 style="font-size:1rem;margin-top:2rem">Ruled</h2><ul>${recent}</ul>` : ""),
    );
  }),
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Last: the built surface for "/" and any path no route above claims. Exact routes and the
// longer prefixes above win, so the webhook and the ruling links keep their URLs.
registerStaticRoutes(http, components.staticHosting);

export default http;
