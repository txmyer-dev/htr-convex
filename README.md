# Hold the Room, on Convex

An assistant that reads everything, drafts everything, and sends nothing until you rule.

An email arrives at the assistant's inbox. The reader decides it waits on you. The drafter
writes a reply in your voice, resting on quotes from what they actually said. You get one
numbered email, or a live page, and you rule: `1`, `2 no`, `3 tell them Tuesday works`, or a
tap on Send. What you signed goes out as you, in their thread. What you edited is logged in your
own words. Nothing goes out otherwise. A draft you never rule on expires: the counterparty is
told a reply is coming, and the item heads the next digest.

This is the Convex rebuild of [HTR](https://github.com/txmyer-dev/HTR) (Python, SMS, live on a
VPS) for the Convex "All Gas" hackathon. Same loop, new spine: the database is the queue, every
ruling is one transaction, the surface is live without a websocket to write, and the whole thing,
surface included, is served from one Convex deployment.

## Try it

The front door is the live app itself: [famous-spider-906.convex.site](https://famous-spider-906.convex.site).
Give it a name, your email, a business, and (optionally) its website. You get an inbox address
and the live page. Email the address from any account, or press "Send a customer email" on the
page. A draft in your voice is on the page in seconds, the numbered digest is in your own inbox a
minute later, and your reply, or a tap, rules it. Thirty minutes later the inbox goes back to the pool
and a day after that the demo is forgotten.

Demo inboxes are leased from a small pool sized by `HTR_DEMO_POOL` (8 in production — the
Developer plan's 10-inbox account cap, less client zero's inbox and the web agent's). The pool
grows on demand, or is filled ahead of time with `npx convex run demo:warm`. If every inbox is
taken, the door says when the next one frees.

## The shape

```
                 AgentMail inbox (one per client; demos lease from a pool)
   counterparty ──────────────▶ webhook ──▶ mail.receive (one transaction)
                                              │  from the owner?  → rulings.handleOwnerReply
                                              │  from a person?   → messages + contacts, schedule drafter.draft
                                              └  automated mail?  → recorded, never drafted
   drafter.draft (action) ── reader: latestUnanswered ── Firecrawl: the sender's site, on first contact
                          ── OpenAI (JSON: body + basis; the business site and the sender's site in the prompt)
                          ── drafter.record: propose (with grounding), supersede older, requestDigest
   digest.run (scheduled, debounced 60 s / at the owner's hour) ── build (numbering) ── one email to the owner
                                                                                        Send / Skip links · the live surface
   owner rules ── by reply · by link · from the surface ──▶ proposal pending → signed ──▶ mail.dispatch → sent
   owner teaches ── an edit on a named gap · "remember ..." ──▶ facts (distilled once) ──▶ every later draft
                                                              └─ the site doesn't say it? ──▶ a `site` proposal, ruled like any draft
   the web agent ◀── signed request (x-htr-site), owner cc'd ── mail.dispatch          (a second agent, its own inbox, on the VPS)
   the web agent ──▶ "Live. ..." / "Not live. ..." in the thread ──▶ mail.receive ──▶ Firecrawl re-reads the site ──▶ sent → live | failed
   crons: hourly expiry (expire, hold notice, re-list) · digest clock · demo sweep every 15 min · weekly site re-read
```

Everything in `convex/lib/` is pure and tested in node. Everything in `convex/*.ts` is a Convex
function and tested with `convex-test` against an in-memory backend. The network is off in
tests; scheduled actions are visible, never run.

## Run it

```bash
npm install
npm test                      # 126 tests, offline
npx convex dev                # first time: creates the deployment, writes .env.local
```

For an anonymous local backend (no account): `npx convex deployment select local`, then
`CONVEX_AGENT_MODE=anonymous npx convex dev`.

## Configure an install

1. **`convex/install.ts`** is the one file that varies per client. `owner.email` is the identity
   every email ruling is checked against. `digestAt` is `immediate` or local `HH:MM`.
   `npx convex run install:apply` after editing.
2. **Secrets** live on the deployment, never in the repo (`.env.example` lists them):
   ```bash
   npx convex env set HTR_RULING_SECRET <long random string>
   npx convex env set OPENAI_API_KEY ...           # and OPENAI_BASE_URL / OPENAI_MODEL for Omniroute
   npx convex env set AGENTMAIL_API_KEY ...
   npx convex env set FIRECRAWL_API_KEY ...
   ```
3. **AgentMail**: `npx convex run mail:provision '{"slug":"tony"}'` creates the inbox, points its
   `message.received` webhook at `https://<deployment>.convex.site/webhooks/tony/mail`, and keeps
   the webhook secret on the tenant (`AGENTMAIL_WEBHOOK_SECRET` in the environment is the
   fallback for client zero). Counterparties write to the inbox address; the owner's digests
   come from it.
4. **Firecrawl**, in four places. `npx convex run knowledge:refresh '{"slug":"tony"}'` crawls
   `business.site` (up to `HTR_CRAWL_PAGES`, default 20, one credit each) into the `knowledge`
   table now, replacing what the site used to say; a Monday-morning cron reads every tenant's
   site again, since sites change. The drafter reads the site front first, a slice of each page. And on the first message from a company address (never
   webmail) the drafter reads the sender's own domain into the contact's `profile`, so the
   reply knows who is writing. And when a message links a page ("can you quote this?"), the
   drafter reads it, at most two per message. All of it goes in the prompt, and what the drafter
   had in front of it is kept on the proposal as `grounding`: the card and the digest say
   "Drafted from your site (sams-bakery.com), who they are (acme.com), and the page they sent."
5. **The surface**: `npx convex run tenants:surfaceUrl '{"slug":"tony"}'` prints the owner's link,
   `https://<deployment>.convex.site/?t=<slug>&k=<key>`. The React app (`src/`) is built and
   uploaded to the deployment by the static hosting component: `npm run deploy:dev` puts it on
   the dev deployment, `npm run deploy` builds, deploys the backend, and uploads to production.
   `/r/<slug>?k=` is the same surface server-rendered, for a client without JavaScript.
   In development, `npm run dev` runs Vite with HMR against the dev backend.
6. Send the inbox an email from any other address. A draft, then a digest, arrives at
   `owner.email`. Reply `1`, or tap Send. The loop is closed.

## The surface

| Route (convex.site) | Called by | Does |
|---|---|---|
| `POST /webhooks/{slug}/mail` | AgentMail | Svix-verified with the tenant's secret; a ruling from the owner, or an inbound email |
| `POST /webhooks/pool/mail` | AgentMail | the same for every demo inbox: the event names the inbox, the inbox knows its secret and its lease |
| `GET\|POST /rulings/{slug}/{id}/{sign\|reject}?t=` | the Send / Skip links | one tap rules; token binds tenant, proposal, verdict |
| `GET /` | anyone | the front door: take an inbox, be the owner for thirty minutes |
| `GET /?t={slug}&k=` | you | the live surface (the React app, static hosting) |
| `GET /r/{slug}?k=` | you | the same, server-rendered |
| `GET /tenants/{slug}/proposals?k=` | you | every proposal and its status |
| `GET /healthz` | anyone | liveness |

Public Convex functions (the React app): `proposals.list`, `proposals.timeline`, `tenants.surface`,
`rulings.ruleFromSurface`, `facts.retrySite`, `mail.retrySend`, `demo.sendAsCustomer`, `demo.end`. All take the
surface key. `demo.start` is the one public function that takes none: it is the front door.

## Who may rule

There are no accounts, by design: the owner already has an identity, their email address, and
that is the only one the loop trusts.

- **By reply**: a ruling by email is accepted only from `owner.email`; the Svix signature on the
  webhook proves AgentMail delivered it, and the address on the message proves who wrote it.
  Anyone else's reply is logged and ignored.
- **By link**: every Send / Skip / Edit link carries an HMAC of tenant, proposal, and verdict
  under `HTR_RULING_SECRET`. A leaked link can rule that one draft that one way and nothing else.
- **On the surface**: the page URL carries a per-tenant key derived the same way. It is a
  capability, like the links: whoever holds the owner's digest holds the room. The digest goes
  only to `owner.email`.

Convex Auth is the step after this, when a second person needs into the same room; a demo tenant
made at the front door is the same shape, with the visitor's email as the owner's.

## Two agents

Hold the Room does not touch the website. When the owner teaches it something the site does not
say, it asks the agent that does: [the web agent](https://github.com/txmyer-dev/htr-web-agent),
one file of Node on the VPS next to the site's nginx container, with its own AgentMail address.
The two never share a database, a process, or a key that rules anything. They talk the way two
people would, in a thread the owner is copied on, and each one checks the other's work.

1. **A fact becomes a request.** The owner's words are distilled once into a statement about the
   business. For a tenant that names a web agent (`business.webAgent`), the statement becomes a
   proposal of kind `site`: "Please add this to felaniam.cloud, where it belongs, in the site's
   own voice: ... Reply in this thread when it is live." It is numbered in the digest and shown
   on the surface, and nothing leaves until the owner rules it, like any draft.
2. **The request goes out signed.** A new thread from the tenant's inbox to the agent, the owner
   cc'd, with one header: `x-htr-site: <tenant>:<proposal>:<HMAC>` under `HTR_SITE_SECRET`. The
   agent verifies the Svix signature on its webhook, then the header, then a tenant allowlist;
   anything else is logged and never answered, so nothing can make it talk.
3. **The agent does the work and says so.** It hands the page and the fact to a model, applies
   find/replace edits under guards (each find exactly once, no net deletion, the fact's words on
   the page), backs up, writes, and replies-all in the thread. The first line of the reply is the
   contract: `Live. <where it went>` or `Not live. <why>. Nothing was changed.`
4. **HTR believes the site, not the reply.** The reply is matched to the request by thread id
   and never drafted. `Live` schedules a Firecrawl re-read: when a page carries most of the fact's
   words the proposal moves `sent → live` and the fact records the page. Three misses, five
   minutes apart, and the request is `failed` with the reason on the surface and a button to read
   the site again. `Not live` is `failed` at once, with the agent's reason and a button to ask
   again, which sends the request afresh in a new thread. The command line has the same:
   `npx convex run proposals:resend '{"proposalId":"..."}'`.

The site's own deploy refuses to push over a page the agent has changed; `deploy/pull.sh` there
brings the live page back first.

### What happened

Every ruled item on the surface has a "What happened" line under it, and a site request still on
its way opens by itself. It is the request's story in order, live, one line per step:

```
3:02 PM  Request drafted for your website's agent, from what you taught it
3:04 PM  Signed by you, by email reply
3:04 PM  Sent to your website's agent, signed, with you copied
3:05 PM  The agent replied: "Live. Added to the visit section."
3:05 PM  Read the site (4 pages): not there yet
3:10 PM  Read the site: it's there (https://felaniam.cloud/visit). Live.
```

Nothing new is recorded to tell it. Every handler already appends an event, and every ruling is
already a row; an event that names a request now carries its id on the row as well as in the
payload (`events.appendEvent` lifts it), both tables are indexed by request, and
`proposals.timeline` merges the two in the order they were written. The words live in one pure
function (`lib/proposals/timeline.ts`). A request still on its way ends with where it is now:
waiting on your ruling, waiting for the agent's reply, or reading the site again shortly. The
point is the one step 4 makes: the agent's `Live.` is one line of the story and the re-read is
another, so the page shows which of them made it live. Events written before this carry the id only
in the payload; `npx convex run events:backfillProposalIds '{"paginationOpts":{"numItems":200,"cursor":null}}'`
names them, one page at a time.

## Where this goes: the spine

Two agents that never share a key, a request that carries a signature, a ruling before anything
moves, and the surface as the truth, not the reply: that is already the shape of a larger system.
This deployment is where it grows. **Agents think, executors act, the spine carries, the owner
rules.**

| Here today | Becomes |
|---|---|
| `proposals` (email, sms, site) and their lifecycle | typed **requests** between agents, same lifecycle, same digest, same rulings |
| the site protocol: request, ruling, signed header, edit, Firecrawl re-read decides `live` | the template every executor follows: it acts only on a ruled, signed request and proves the effect on the surface itself |
| `business.webAgent` and one `HTR_SITE_SECRET` | a registry of **agents**, each with its own secret, what it accepts, and whom it may ask for what |
| `events` and the request timeline above | the one event log, and a record of every run under every request |
| the surface and the digest | **the desk**: one queue for everything that waits on the owner, with a push to the phone |

The rules that make it safe are the ones already here. Agents that draft hold no keys to the
things they change; an **executor** owns exactly one surface (the web agent owns one site's
files) and acts only on a request the spine has checked against the registry and the owner has
ruled. The spine checks and carries; it never picks a recipient and never decides. A request of a
kind the sender is not registered for is refused, with an event, never dropped. Next after the
web agent: a publisher (a post is a pull request, the owner's ruling is the merge, and the check is
the live URL) and a clerk for the owner's notes.

**Transport stays pluggable.** Email is the transport today because it exists and the owner already
reads it. Agents on servers the owner runs will speak signed HTTP to the spine instead, and the
relay shape (each agent known by its public key, NIP-17 encrypted events, NIP-42 relay auth) stays
the option for agents on hosts nobody shares. Above the transport nothing changes: the lifecycle,
the ruling, the surface as the truth.

**The honest limit today:** the web agent and HTR share one `HTR_SITE_SECRET`. The header proves a
request came from HTR, not which agent is talking, so a second executor would need its own secret.
The agent registry is the first step of the spine for that reason.

## Rulings

| Reply | Meaning |
|---|---|
| `1` · `1 ✅` · `1 yes` | sign draft 1 and send it as you |
| `2 no` · `2 ❌` | reject draft 2; nothing sent |
| `3 tell them Tuesday works` | replace draft 3's words with those, then send |
| `all` | sign every draft in the last digest |
| `later` | leave everything for the next digest |
| `hold` · `hold until 9` | hold the room; drafts keep stacking |
| `?` | send the digest now |
| `remember parking is free after 6` | teach the room a fact, outside any draft |

An edit is also a lesson. The draft it replaced and the words that went out are kept on the
ruling, and the drafter puts the owner's last five corrections for this tenant in front of the
model before it writes. The owner is never asked to confirm twice: the correction is the ruling
and the training at once. Edits only (a skip says "not this" without saying what), and never
across tenants.

A reply from any address other than the owner's is logged and ignored. Quoted text below the
owner's words is stripped before parsing. A number resolves only through the latest digest, and
only to a draft still pending: a stale digest cannot rule a newer draft.

## The second brain

The site is the first brain: Firecrawl reads it, and drafts rest on it. But a site does not say
everything, and the drafter is told not to guess. When a message asks for something that neither
the site, the thread, nor anything the owner has said answers, the draft says the owner will
confirm, and names what is missing as its `gap`. The digest line says so: `3 Sam (email): "Are
you open Saturday?" → Tony will confirm. · you haven't told me: Saturday opening hours`. The
owner answers the way they rule: `3 Yes, Saturdays 9 to 2`. Those words go out to Sam, and they
are kept in the `facts` table as the answer to that question, in the owner's own words, and
distilled once by the model into a plain statement about the business ("Dogs are welcome; there
is a garage on 4th Street"), since a reply handed to a drafter as a fact comes back with its
greeting. From then on every draft for this tenant has the owner's facts in front of it, alongside the site,
and the card says "Drafted from your site (felaniam.cloud) and one thing you told me." A bare
`remember ...` teaches a fact without waiting to be asked. Nothing is confirmed twice: the reply
is the ruling and the lesson at once.

## The site in pieces

Twenty pages do not fit in a prompt. When a site is read, each page is cut into chunks under
their headings (`lib/knowledge/chunk.ts`), the chunks are embedded in one call
(`OPENAI_EMBED_MODEL`, 1536 dimensions), and they replace the tenant's old chunks in one
transaction. The `chunks` table carries a Convex vector index filtered by tenant. At draft time
the drafter embeds the message, asks the index for the eight closest chunks, puts the homepage's
opening in front of them, and drafts from that; `grounding.site` names only the pages those
chunks came from. Without embeddings (no key, a failed call) it falls back to whole pages ranked
by the words they share with the message (`lib/knowledge/rank.ts`).

## From the room to the site

A fact the site does not say is a site that is behind. HTR does not touch the site; it writes to
the agent that does. When a tenant names a web agent (`business.webAgent`, the address of the
agent that edits the site, its own AgentMail inbox on your own server), every distilled fact
becomes a proposal of a third kind, `site`: "Please add this to felaniam.cloud: Dogs are welcome
at the office." It is numbered in the digest and ruled like any draft. Signed, it goes out as a
new thread to the web agent with the owner copied and a signed header on it (`x-htr-site`, an
HMAC of tenant and proposal under `HTR_SITE_SECRET`), so the agent acts only on what HTR sent.
The agent replies in the thread when the page is live; mail from its address is never drafted,
only matched to the request by thread. Then Firecrawl reads the site again, and when a page says
what the fact says, the proposal is `live` and the fact points at the page. The assistant taught
itself a fact, asked permission to publish it, and checked the web to see that it was.

The web agent itself is a separate, small thing: [htr-web-agent](https://github.com/txmyer-dev/htr-web-agent),
one Node file on the VPS with the page mounted, its own AgentMail inbox, and the same secret. It
edits the page as `{find, replace}` pairs the model proposes, refuses any edit that is not
unique or removes more than it adds, keeps a backup, and replies-all in the thread. If it
cannot carry a request out, its reply says so and `npx convex run proposals:resend` asks again.

## Layout

```
convex/convex.config.ts   components: static hosting (the surface, served from this deployment)
convex/schema.ts          the spine: tenants, messages, proposals, rulings, digests, events, actions, contacts, knowledge, chunks (vector index), facts, demoInboxes
convex/install.ts         the tenant block (client zero)
convex/demo.ts            the front door: the inbox pool, the lease, the pretend customer, the sweep
convex/lib/               pure: rulings/parse+token, digest/render+expiry, reader/waiting+deadline+automated, mail/svix+inbound+agentmail, knowledge/domain+rank+links+chunk, llm/openaiCompat+embed, proposals/lifecycle+timeline, site/publish, time
convex/proposals.ts       the lifecycle as guarded transitions; the surface's list and each request's timeline
convex/events.ts          the event log (the request an event names, on the row) and the idempotency ledger
convex/rulings.ts         apply a ruling once: by reply, by link, from the surface; hold; expiry
convex/facts.ts           the second brain: what the owner teaches, distilled once; and from the room to the site: the request, the acknowledgment, the re-read
convex/digest.ts          number, debounce, build, send
convex/drafter.ts         reader → OpenAI → proposal
convex/mail.ts            AgentMail in (receive) and out (digest, confirmations, notices, dispatch); provisioning
convex/knowledge.ts       Firecrawl: the business site (crawled now, weekly) and the sender's site (first contact); the site in pieces, embedded, retrieved
convex/http.ts            the routes above
convex/crons.ts           expiry, digest clock, demo sweep, weekly site re-read
src/                      the live surface (Vite + React), uploaded to convex.site by `npm run deploy`
tests/                    node for lib, convex-test for the loop
STEALS.md                 the ledger
```
