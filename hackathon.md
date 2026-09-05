# Hackathon log

- **Project:** Hold the Room
- **Event:** Convex All Gas Hackathon
- **What it does:** An email assistant that reads everything, drafts every reply in the owner's voice with quotes from the counterparty, and sends nothing until the owner rules by reply, signed link, or a live page.
- **Live app:** not deployed
- **Repo:** private
- **Frontend:** Convex static hosting
- **Convex deployment:** https://famous-spider-906.convex.cloud
- **Components:** none
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP actions, crons, scheduled functions, realtime queries
- **Auth:** none
- **AI models:** gpt-5.4-mini
- **Started:** 2026-09-04T04:42:55Z
- **Last updated:** 2026-09-04T22:42:19Z

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

### 2026-09-04 - working tree
Hackathon setup: the official Convex plugin, the managed Convex AI files, and this log.
Frontend hosting chosen as Convex static hosting; the surface will move off Netlify to
`https://<deployment>.convex.site` in a later build step.
