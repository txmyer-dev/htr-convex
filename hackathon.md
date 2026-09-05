# Hackathon log

- **Project:** Hold the Room
- **Event:** Convex All Gas Hackathon
- **What it does:** An email assistant that reads everything, drafts every reply in the owner's voice with quotes from the counterparty, and sends nothing until the owner rules by reply, signed link, or a live page.
- **Live app:** https://famous-spider-906.convex.site
- **Repo:** private
- **Frontend:** Convex static hosting
- **Convex deployment:** https://famous-spider-906.convex.cloud
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP actions, crons, scheduled functions, realtime queries
- **Auth:** none
- **AI models:** gpt-5.4-mini
- **Started:** 2026-09-04T04:42:55Z
- **Last updated:** 2026-09-05T02:50:00Z

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
