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
ruling is one transaction, the surface is live without a websocket to write.

## The shape

```
                 AgentMail inbox (one per client)
   counterparty ──────────────▶ webhook ──▶ mail.receive (one transaction)
                                              │  from the owner?  → rulings.handleOwnerReply
                                              │  from a person?   → messages + contacts, schedule drafter.draft
                                              └  automated mail?  → recorded, never drafted
   drafter.draft (action) ── reader: latestUnanswered ── OpenAI (JSON: body + basis) ── drafter.record
                                                                                            │ propose, supersede older, requestDigest
   digest.run (scheduled, debounced 60 s / at the owner's hour) ── build (numbering) ── one email to the owner
                                                                                        Send / Skip links · the live surface
   owner rules ── by reply · by link · from the surface ──▶ proposal pending → signed ──▶ mail.dispatch → sent
   crons: hourly expiry (expire, hold notice, re-list) · digest clock
```

Everything in `convex/lib/` is pure and tested in node. Everything in `convex/*.ts` is a Convex
function and tested with `convex-test` against an in-memory backend. The network is off in
tests; scheduled actions are visible, never run.

## Run it

```bash
npm install
npm test                      # 47 tests, offline
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
   `message.received` webhook at `https://<deployment>.convex.site/webhooks/tony/mail`, and
   returns the webhook secret once: `npx convex env set AGENTMAIL_WEBHOOK_SECRET whsec_...`.
   Counterparties write to the inbox address; the owner's digests come from it.
4. **Firecrawl**: `npx convex run knowledge:refresh '{"slug":"tony"}'` reads `business.site` into
   the `knowledge` table; the drafter puts it in front of the model so prices and hours come
   from the site.
5. **The surface**: `npx convex run tenants:surfaceUrl '{"slug":"tony"}'` prints the owner's link.
   `/r/<slug>?k=` is server-rendered on convex.site; `npm run dev:frontend` serves the live
   React version at `/?t=<slug>&k=<key>`.
6. Send the inbox an email from any other address. A draft, then a digest, arrives at
   `owner.email`. Reply `1`, or tap Send. The loop is closed.

## The surface

| Route (convex.site) | Called by | Does |
|---|---|---|
| `POST /webhooks/{slug}/mail` | AgentMail | Svix-verified; a ruling from the owner, or an inbound email |
| `GET\|POST /rulings/{slug}/{id}/{sign\|reject}?t=` | the Send / Skip links | one tap rules; token binds tenant, proposal, verdict |
| `GET /r/{slug}?k=` | you | the ruling page |
| `GET /tenants/{slug}/proposals?k=` | you | every proposal and its status |
| `GET /healthz` | anyone | liveness |

Public Convex functions (the React app): `proposals.list`, `tenants.surface`,
`rulings.ruleFromSurface`, `mail.retrySend`. All take the surface key.

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

A reply from any address other than the owner's is logged and ignored. Quoted text below the
owner's words is stripped before parsing. A number resolves only through the latest digest, and
only to a draft still pending: a stale digest cannot rule a newer draft.

## Layout

```
convex/schema.ts          the spine: tenants, messages, proposals, rulings, digests, events, actions, contacts, knowledge
convex/install.ts         the tenant block (client zero)
convex/lib/               pure: rulings/parse, digest/render+expiry, reader/waiting+deadline+automated, mail/svix+inbound+agentmail, time
convex/proposals.ts       the lifecycle as guarded transitions
convex/rulings.ts         apply a ruling once: by reply, by link, from the surface; hold; expiry
convex/digest.ts          number, debounce, build, send
convex/drafter.ts         reader → OpenAI → proposal
convex/mail.ts            AgentMail in (receive) and out (digest, confirmations, notices, dispatch); provisioning
convex/knowledge.ts       Firecrawl: the business site
convex/http.ts            the routes above
convex/crons.ts           expiry, digest clock
src/                      the live surface (Vite + React)
tests/                    node for lib, convex-test for the loop
STEALS.md                 the ledger
```
