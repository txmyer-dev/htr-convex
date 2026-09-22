# Hold the Room — Convex All Gas Hackathon

**An everyday app, not a dev tool.** For anyone who runs on their inbox — a bakery, a clinic front
desk, a contractor, a small law office. It reads every customer message, drafts the reply in the
owner's voice quoting what the customer actually asked, and **sends nothing until the owner
approves**: one tap on a live page, or a one-word email reply (`1`, `2 no`, `3 tell them Tuesday
works`). What the owner teaches it that the website does not say, a second agent puts on the site,
signed, and it re-reads the site to confirm. The user is a business owner answering customers —
never a developer.

- **Live URL:** https://famous-spider-906.convex.site — the front door itself. Take an inbox, send
  a customer email, watch a draft appear, and rule it. No login, no localhost.
- **Demo video (< 3 min):** https://youtu.be/6GhkyDQ3Z_k
- **Social post (X / LinkedIn):** ⟵ ADD LINK
- **Repo (public):** https://github.com/txmyer-dev/htr-convex · the second agent:
  https://github.com/txmyer-dev/htr-web-agent · the site it edits: https://github.com/txmyer-dev/felaniam-site
- **Started:** 2026-09-04 · **Last updated:** 2026-09-22 · **129 tests, offline**

## The stack, and the real work each sponsor does

- **Convex — the entire system is one deployment.** The database *is* the queue; every ruling is a
  single transaction; the owner's live page is a Convex query that re-renders the instant state
  changes — no server, no websocket. In use: **schema + indexes**, **queries**, **mutations**,
  **actions**, **HTTP actions** (the AgentMail webhooks and the server-rendered ruling pages),
  **scheduled functions + crons** (digest clock, hourly expiry, 15-minute demo sweep, weekly site
  re-read), **vector search** (site chunks retrieved per message), and the
  **@convex-dev/static-hosting component**, which serves this very page from the same deployment.
  **Auth:** no accounts by design — the owner's email address is the identity for rulings by reply;
  every Send / Skip link and the surface URL is HMAC-signed per tenant.
- **OpenAI — generates.** `gpt-5.4-mini` writes every draft as `{reply, basis-quotes}` and distills
  what the owner teaches into a fact; `text-embedding-3-small` embeds the site and the incoming
  message for retrieval. Not decoration: no model call, no draft.
- **Firecrawl — crawls.** Reads the business site (crawled, then weekly), the sender's own domain on
  first contact, and any page a customer's message links to; the draft rests on what the site
  actually says, and Firecrawl re-reads the site to confirm a taught fact went live.
- **AgentMail — sends and receives.** The real inbox on both sides: inbound customer mail through a
  Svix-signed webhook, the owner's approved reply back in the customer's own thread as the owner,
  and a leased inbox pool so any judge can try the whole loop live from the front door.

**Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, crons, scheduled
functions, realtime queries, vector search, `@convex-dev/static-hosting`.
**Convex deployment:** https://famous-spider-906.convex.cloud (surface served from
https://famous-spider-906.convex.site).

## Log

### 2026-09-04 - d2355de
The whole loop on Convex, self-contained. An email lands in the tenant's AgentMail inbox and
arrives through the Svix-verified webhook; one mutation records the message and contact,
filters automated mail, and schedules the drafter. The drafter action asks an OpenAI-compatible
model for a reply plus verbatim basis quotes, and its record mutation proposes the draft,
supersedes older drafts to the same person, and requests a digest. The digest numbers what
waits and emails the owner; the owner's reply comes back through the same webhook and rules
by number. Signed drafts dispatch in the counterparty's thread. Hourly expiry sends a hold
notice and re-lists. Pure modules under `convex/lib` are tested in node; the loop is tested
with convex-test, network off. Convex features: schema, indexes, queries, mutations, actions,
HTTP actions, crons, scheduled functions, realtime query in the Vite surface (`convex/schema.ts`,
`convex/mail.ts`, `convex/drafter.ts`, `convex/digest.ts`, `convex/rulings.ts`, `convex/http.ts`,
`convex/crons.ts`, `src/App.tsx`).

### 2026-09-04 - 688563e
A third ruling link. `/rulings/{slug}/{id}/edit` shows the draft's words in a form on the
server-rendered page; posting them signs the draft with the owner's own words. The token binds
tenant, proposal, and verdict like Send and Skip (`convex/http.ts`, `convex/lib/rulings/token.ts`).

### 2026-09-04 - 9e82f45
The drafter talks chat-completions over plain fetch. The OpenAI SDK used URL features the Convex
runtime does not implement, so a small client replaces it: any OpenAI-compatible base URL,
normalised however it was written, SSE bodies concatenated for gateways that stream anyway.
Default model set to gpt-5.4-mini. Tests on the client and on basis filtering
(`convex/lib/llm/openaiCompat.ts`, `convex/drafter.ts`, `tests/drafter.test.ts`).

### 2026-09-04 - 0e71514
The live React surface shipped to Netlify as an interim host: `netlify.toml`, an `npm run deploy`
script, and the Netlify link state ignored. First real loop proven on the dev deployment: an
inbound email, a draft, a digest to the owner, and a signed draft sent from the tenant inbox.

### 2026-09-04 - 6521058
A dead site is not knowledge. Firecrawl returns an origin's 404 page as markdown with
`success: true`, and the first refresh against the configured business site stored "page not
found" as what the business says. The scraper now refuses 4xx and 5xx pages and empty pages;
`knowledge:clear` forgets a tenant's rows. Four tests on the scraper with a fake fetch
(`convex/knowledge.ts`, `tests/knowledge.test.ts`).

### 2026-09-04 - e4757db
Hackathon setup: the official Convex plugin, the managed Convex AI files, and this log.
Frontend hosting chosen as Convex static hosting; the surface moves off Netlify to
`https://<deployment>.convex.site` below.

### 2026-09-05 - quoting shapes
Preparing the first live ruling by email reply: the quote stripper knew Gmail's one-line
"On ... wrote:" and ">" marks only. Gmail wraps the attribution over two lines on a phone, and
Outlook quotes with a "____" rule and a "From:" header block and no ">" marks at all, so the
digest's own numbered lines came back as rulings ("2 waiting on you." read as draft 2, edited to
"waiting on you."). The stripper now cuts on a bare "wrote:" (and walks back to the "On" line),
the rule, and the header block. Three tests on those shapes (`convex/lib/rulings/parse.ts`,
`tests/parse.test.ts`).

### 2026-09-05 - first ruling by email reply, live
The last untested path closed. A counterparty email from a Gmail account to the tenant inbox
became a draft in three seconds and a digest to the owner sixty seconds later. The owner replied
from Gmail with "1 tell Felix yes, December is fine" and the quoted digest below it; the webhook
landed in `mail.receive`, the owner's address matched, the quote was stripped, the number
resolved through the latest digest, the draft was edited to the owner's words and signed, the
confirmation went back in the owner's thread, and the reply went out to the counterparty in
their thread, all within four seconds of the reply arriving. The ruling row holds the raw reply
verbatim, quoted digest included: the correction log in the owner's own words.

### 2026-09-05 - the edit is the lesson
The owner's rule, decided after the first live edit: the agent drafts; if the owner edits, the
words go out as written, no rewrite, no second confirmation; the agent learns from the edit after
the fact. So an edit ruling now keeps the draft it replaced next to the owner's words
(`rulings.draftBody`), and the drafter's context query reads the tenant's last five edits, newest
first, as draft-to-sent pairs. They ride in the prompt as `owner_corrections` with one line of
instruction: match the owner's wording, length, and tone, never the earlier drafts. Edits only
(a skip says nothing about what instead) and per tenant only. Pure module
`convex/lib/drafter/lessons.ts` with tests; a loop test proves an edit by email reply shows up
in the next draft's context and a plain sign does not (`convex/rulings.ts`, `convex/drafter.ts`,
`convex/schema.ts`, `tests/lessons.test.ts`, `tests/loop.test.ts`, `tests/drafter.test.ts`).

### 2026-09-05 - the surface on convex.site
The live surface is served by the deployment itself. `@convex-dev/static-hosting` is registered
in `convex/convex.config.ts` without an httpPrefix, and `convex/http.ts` registers the static
catch-all after the app's own routes, so the AgentMail webhook and the Send / Skip / Edit links
in every digest already sent keep their root URLs; `/` and any unclaimed path serve the built
Vite app (SPA fallback on). The owner's link is now `https://<deployment>.convex.site/?t=<slug>&k=`,
printed by `tenants:surfaceUrl` and used by the digest's "Everything, live" link and the
ruling pages' back link; `/r/<slug>` stays as the server-rendered fallback. `npm run deploy`
builds, deploys the backend, and uploads; `npm run deploy:dev` uploads to the dev deployment.
Netlify config removed. Verified on the dev deployment: index and hashed assets served with
long-term caching, SPA paths fall back to index, the webhook still answers 401 unsigned, the
ruling and tenant routes still gate on their tokens, and the bundle points at this deployment's
backend (`convex/convex.config.ts`, `convex/http.ts`, `convex/surface.ts`, `convex/digest.ts`,
`convex/tenants.ts`, `package.json`).

### 2026-09-06 - the front door, and Firecrawl in three places
The live URL used to be a dead end without the owner's link. Now `/` is a front door: a name, an
email, a business, and (optionally) its website give anyone an inbox address and the live page
for two hours, as the owner. AgentMail inboxes are scarce (three on the free plan), so a demo
leases one from a small pool instead of making its own; each pool inbox has one webhook at
`/webhooks/pool/mail` whose secret lives with the inbox, and the route resolves the inbox in the
event to the tenant holding its lease. A "Send a customer email" button on the page writes to
the demo inbox from client zero's inbox, the customer's name in a header; AgentMail files an
inbox's mail to itself under "sent" and never delivers it, which the first attempt found. The
signed reply lands back in client zero's room and is never drafted there. An hourly sweep
releases expired leases and forgets ended demos a day later; "End demo" frees the inbox now.

Firecrawl now feeds the drafter three ways: the business site at install and on a Monday cron,
and the sender's own domain on first contact from a company address (never webmail). What the
drafter had in front of it is kept on the proposal as `grounding`, and the card, the digest, and
the server-rendered page say "Drafted from your site (firecrawl.dev) and who they are (acme.com)."

Two defects found by the live run and fixed: AgentMail stamps List-Unsubscribe on everything it
sends, so the automated-mail nets rejected the pretend customer (a message our own header vouches
for now skips them, and AgentMail's footer is stripped); and the address parser dropped the first
character of a bare address (`oom-1@...`). Verified live on the deployment: a demo started from
the form, a customer email became a draft on the page in five seconds, a draft for a Firecrawl
demo quoted the Scale plan's price from the scraped pricing page with `grounding.site` recorded,
a signed draft dispatched in-thread, and its echo in client zero's room was logged and not
drafted. 85 tests (`convex/demo.ts`, `convex/knowledge.ts`, `convex/drafter.ts`, `convex/mail.ts`,
`convex/http.ts`, `convex/crons.ts`, `convex/schema.ts`, `convex/lib/knowledge/domain.ts`,
`convex/lib/mail/inbound.ts`, `src/App.tsx`, `tests/demo.test.ts`, `tests/domain.test.ts`,
`tests/grounding.test.ts`, `tests/inbound.test.ts`).

### 2026-09-06 - a shorter lease
A demo now lasts thirty minutes, not two: a judge's try takes ten, the pool holds two inboxes on
the free plan, and "End demo" still frees one sooner. The sweep that releases expired leases runs
every fifteen minutes instead of hourly (`convex/demo.ts`, `convex/crons.ts`, `src/App.tsx`, `README.md`).

### 2026-09-06 - the second brain: gap and teach
A site does not say everything, and the drafter was told never to guess, so a question the site
could not answer got "Tony will confirm" and nothing else ever happened. Now the drafter names
what it could not answer as the proposal's `gap` ("dog access and nearby parking"), the digest
line and the card say "you haven't told me: ...", and the owner answers the way they already
rule: reply with the number and the words. The words go out as the reply, and they are kept in a
new `facts` table as the answer to that question, in the owner's own voice. Every later draft
for the tenant has the facts in front of it (`owner_facts`), the card says "Drafted from your
site and one thing you told me", and a bare `remember ...` reply teaches without being asked.
Verified live on a demo room against felaniam.cloud: the booking question was answered from the
site, the dog-and-parking question was named as the gap, an edit ruling stored the fact, and the
next customer's parking question was drafted from it with `grounding.facts` recorded. One defect
found and fixed on the way: the first draft from a fact copied the owner's earlier reply whole,
greeting and calendar link included, and a prompt line did not stop it; so each fact is now
distilled once, by a scheduled action, into a plain statement about the business, and that is
what the drafter reads (the owner's words stay as the record). A second: every pretend customer
writes from one inbox, so the contact's first name stuck to every later customer; the name on
the message now wins. 92 tests (`convex/facts.ts`, `tests/facts.test.ts`, `convex/schema.ts`, `convex/drafter.ts`, `convex/rulings.ts`,
`convex/digest.ts`, `convex/proposals.ts`, `convex/views.ts`, `convex/http.ts`,
`convex/lib/rulings/parse.ts`, `convex/lib/digest/render.ts`, `convex/lib/knowledge/domain.ts`,
`src/App.tsx`, `tests/loop.test.ts`, `tests/drafter.test.ts`, `tests/digest.test.ts`, `tests/parse.test.ts`).

### 2026-09-06 - the whole site, not the homepage
The business site was one scrape: the homepage, and nothing behind it. Now `knowledge:refresh`
and the Monday cron use Firecrawl's crawl: start the job, poll until it completes, follow `next`,
keep every live page as markdown (dead and empty pages dropped, the homepage first), up to
`HTR_CRAWL_PAGES` (default 20, a credit each). A full read replaces what the site used to say,
so a page the site removed is forgotten; extra URLs passed to refresh are additions. If the crawl
fails the one page is scraped as before. Discovery skips the sitemap and follows the homepage's
links two hops out: the first live crawl of a large site spent the twenty pages on whatever the
sitemap listed first (blog posts, glossary entries, a sign-in page, a tracked link with a query
string) and never reached pricing; the second, from the nav, got pricing, use cases, and compare
in the first ten. Sign-in, cart, account, search, and tag paths are excluded, and any URL with a
query string is dropped. The drafter's site budget went from one page to a slice of each of several, with the URL on
each heading so a draft can point at the page. And which pages: the first live draft against the
crawled site still could not find pricing, because the budget filled with the first four pages by
URL. `lib/knowledge/rank.ts` now orders the pages by the words they share with the message (a hit
in the title or URL counts triple), homepage first, and `grounding.site` names only the pages
that made it into the prompt, not everything stored. 96 tests (`convex/knowledge.ts`, `convex/drafter.ts`, `tests/knowledge.test.ts`,
`tests/grounding.test.ts`, `.env.example`, `README.md`).

### 2026-09-06 - from the room to the site
A fact the site does not say is a site that is behind, and HTR does not touch the site. So a
distilled fact, for a tenant that names a web agent (`business.webAgent`: the address of the
agent that edits the site), becomes a proposal of a third kind, `site`: the request HTR would
send that agent, numbered in the digest and ruled like any draft. Signed, it goes out in a new
thread to the agent with the owner copied and an `x-htr-site` header carrying an HMAC of tenant
and proposal under `HTR_SITE_SECRET` (its own secret, so the VPS never holds the ruling one).
`mail.receive` got a third branch beside the owner and a person: mail from the web agent's
address is an acknowledgment, matched to the request by thread id (the send now returns the
thread and the proposal remembers it), never drafted; unmatched replies are logged. The
acknowledgment schedules a re-read of the site, and when a page carries most of the fact's
words the proposal moves `sent -> live` (a new status; a sent email still ends at sent) and the
fact records the page. A miss is retried twice, five minutes apart, for a slow deploy. The web
agent itself is the next piece; client zero's `webAgent` stays unset until its inbox exists.
`convex/facts.ts`, `convex/lib/site/publish.ts`, `convex/lib/proposals/lifecycle.ts`,
`convex/lib/rulings/token.ts`, `convex/mail.ts`, `convex/proposals.ts`, `convex/schema.ts`,
`convex/surface.ts`, `convex/install.ts`, `convex/lib/digest/render.ts`, `src/App.tsx`,
`tests/loop.test.ts`, `tests/publish.test.ts`, `tests/lifecycle.test.ts`. 105 tests.

### 2026-09-06 - the web agent
The other end of a site request: an agent with its own email address, on the VPS next to the
site's nginx container, with the page mounted read-write (`~/dev/htr-web-agent`, Node 24, no
dependencies, one file). AgentMail delivers to `web-felaniam@agentmail.to`; the webhook is
Svix-verified, then the `x-htr-site` header is checked against `HTR_SITE_SECRET`, and anything
not signed by HTR is logged and never answered. For a signed request the agent hands the page
and the fact to the model and gets back `{edits: [{find, replace}], note}`; every find must
occur exactly once, an edit may not remove more than it adds, the changed page must carry most
of the fact's words, and only then is the old page backed up and the new one written (nginx
serves it at once). It replies-all in the thread, so the owner copied on the request sees "Live.
I added the parking and dog-friendly details to the Practical section." Verified live, end to
end, on client zero: `remember Dogs are welcome at the office, and there is a parking garage on
4th Street a block away` distilled to a statement, became a site proposal, was signed from the
surface, went out signed, the agent put the sentence under Practical on felaniam.cloud, replied,
HTR matched the reply by thread, Firecrawl read the site again, and the proposal moved to
`live` with the fact pointing at the page. The first attempt failed on the model call (the
gateway URL in the environment has no scheme; HTR normalizes it and the agent did not), and
that failure exercised the rest: the agent's "couldn't place this" reply was acknowledged, the
re-read found nothing, the retry was scheduled, and a new `proposals:resend` put the request
back to signed and out again. The pool paid for the inbox: AgentMail's free plan has three,
client zero holds one, so the second demo inbox was retired (`demo:retire`) and
`HTR_DEMO_POOL` is 1 until AgentMail answers about the developer plan. The site repo's deploy
now refuses to push over a page the agent has changed (`deploy/pull.sh` brings it back first).
106 tests (`convex/proposals.ts`, `convex/demo.ts`, `convex/install.ts`,
`convex/lib/proposals/lifecycle.ts`, `tests/loop.test.ts`, `tests/lifecycle.test.ts`;
`~/dev/htr-web-agent/{server.mjs,test.mjs,Dockerfile,deploy/}`; `~/dev/felaniam-site/deploy/`).

### 2026-09-06 - the pages they send
"Can you quote this?" with a link is a question about what is behind the link. The drafter now
reads the pages a message links to, with Firecrawl, at draft time: at most two, a slice of each,
never an image, an unsubscribe or tracking link, or one of our own ruling links
(`lib/knowledge/links.ts`). They go in the prompt as `their_links`, the model is told to answer
about what is on them, and `grounding.links` names them, so the card says "Drafted from your
site (felaniam.cloud) and the page they sent (firecrawl.dev)." A page that will not read is
noted and skipped; the draft still goes out on the rest. Firecrawl is now in four places: the
business site, the sender's site, the pages they send, and the re-read that confirms a site
request went live. 109 tests (`convex/drafter.ts`, `convex/schema.ts`,
`convex/lib/knowledge/domain.ts`, `convex/lib/knowledge/links.ts`, `tests/links.test.ts`,
`tests/grounding.test.ts`).

### 2026-09-06 - the site in pieces
Ranking whole pages by shared words found pricing when the customer said "cost"; it would not
find "how late are you open" on a page that says "hours". So the site is now retrieved, not
ranked: when a site is read, each page is cut into chunks under their headings
(`lib/knowledge/chunk.ts`), the chunks are embedded in one call (`lib/llm/embed.ts`,
`text-embedding-3-small`, 1536 dimensions) by a scheduled action, and they replace the tenant's
old chunks in one transaction. The new `chunks` table carries a Convex vector index filtered by
tenant. At draft time the drafter embeds the message, asks the index for the eight closest
chunks, puts the homepage's opening in front of them so the model knows what the business is
before what it says about this, and drafts from that; `grounding.site` names only the pages the
chunks came from, and a `retrieve.hit` event records how many and how close. No key or a failed
call falls back to the ranked pages. Demo purge now takes the chunks with it. 114 tests
(`convex/schema.ts`, `convex/knowledge.ts`, `convex/drafter.ts`, `convex/demo.ts`,
`convex/lib/knowledge/chunk.ts`, `convex/lib/llm/embed.ts`, `tests/chunk.test.ts`,
`tests/grounding.test.ts`, `.env.example`).

### 2026-09-07 - the request that does not go live
The two agents had a success path and nothing else. The web agent's "I couldn't place this" reply
was handled like "Live.": the request stayed `sent`, three re-reads logged `site.not_yet`, and the
only way back was a command line. Now the first line of the agent's reply is a contract: `Live.`
schedules the Firecrawl re-read as before; `Not live. <why>. Nothing was changed.` moves the request
`sent -> failed` at once, with the agent's reason on the surface and an "Ask again" button that
sends it afresh in a new thread (`facts.retrySite`, the same as `proposals:resend`). And a `Live`
that three reads of the site never confirm is `failed` too, "said it was live, but 3 reads of the
site haven't found it", with a "Read the site again" button that re-reads without asking the agent
to edit the page twice (`failed -> sent`, the thread kept). The lifecycle grew the two edges; the
web agent's reply is built by one function with a test on the first line. The README now draws the
second agent in the shape, says how the two talk in four steps, and where it goes: agents on a
relay with their own keys (NIP-19, NIP-17/44, NIP-42) instead of a mail provider in the middle,
with the one open hurdle named, the owner cc'd on the thread. All three repos are now on GitHub
(htr-convex, htr-web-agent, felaniam-site, private); the live page was pulled back into the site
repo with the agent's first edit in it. Deployed to the web agent and to the deployment. 118 tests
(`convex/lib/site/publish.ts`, `convex/lib/proposals/lifecycle.ts`, `convex/facts.ts`,
`convex/proposals.ts`, `convex/schema.ts`, `src/App.tsx`, `tests/publish.test.ts`,
`tests/lifecycle.test.ts`, `tests/loop.test.ts`; `~/dev/htr-web-agent/{server.mjs,test.mjs}`).

### 2026-09-19 - the whole story on the surface, and a secret that can't be borrowed
Two hardening passes on top of the loop. **"What happened":** every ruled item on the surface now
carries its story in order — draft, ruling, sent to the thread or the agent, the agent's reply, each
Firecrawl re-read — merged from the events and rulings already recorded, by one pure function
(`lib/proposals/timeline.ts`); a site request still on its way opens itself so the owner watches it
land. Nothing new is written to tell it. **The site secret is its own:** `HTR_SITE_SECRET` no longer
falls back to `HTR_RULING_SECRET` and may not equal it — the web agent on the VPS holds a copy of the
site secret, while the ruling secret signs every Send / Skip link and derives every surface key, so a
fallback would have handed an agent that edits one website the power to rule the room. Missing now
throws: no site request goes out, the safe failure. The demo pool moved to AgentMail's Developer plan
(8 inboxes, `demo:warm` pre-fills it). 129 tests (`convex/events.ts`, `convex/proposals.ts`,
`convex/surface.ts`, `convex/schema.ts`, `src/App.tsx`, `tests/timeline.test.ts`,
`tests/secrets.test.ts`, `tests/loop.test.ts`).

### 2026-09-22 - submission
Repo made public; the front door's copy rewritten in a business owner's words with a "What runs it"
footer that names Convex, AgentMail, and Firecrawl and what each carries; this log aligned to the
judging criteria. Live, 129 tests green. Remaining: the demo video and the social post, linked at the
top.
