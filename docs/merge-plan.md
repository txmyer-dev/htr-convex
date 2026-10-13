# Merge plan — one HTR: core, then claws, then extensions

*2026-10-13. **DRAFT — awaiting owner approval.** Ruling: `_decisions#htr-is-core-then-claws-then-extensions`
(builds on `python-htr-retires-into-convex`, `htr-is-the-spine`). Deadline that sets the order:
Ben's beta MVP, due **2026-10-30**.*

## Where we start (measured 2026-10-13)

- **htr-convex already holds the core.** Reader (waiting, deadline), drafter, proposals lifecycle,
  rulings grammar (a superset of Python's), digest + debounce, expiry, ntfy push with Send/Skip/Edit,
  call-listener intake, ClickUp tasks. **149 tests, all green, offline, ~5 s.**
- **Python HTR (`~/dev/HTR`, 3.4k lines, 61 tests) has no users.** What it has that Convex lacks:
  voice (Retell), SMS (Twilio), Gmail, local calendar/contacts, a heartbeat, a handful of reader
  rules, and the **`ports/` + `adapters/` pattern**.
- **The `wip/convex-steals-0913-0921` branch is Convex code copied back into Python.** Drop it, except
  one rule (phase 1, item 5).
- **htr-convex has no claw layer.** Every vendor is a hand-written `fetch` wrapper in `convex/lib/*`
  (AgentMail, OpenAI-compat + embeddings, Firecrawl inline in `knowledge.ts`, ClickUp, ntfy), wired
  directly at call sites. `convex/adapters/` is empty. `mail.dispatch` (`mail.ts:147-181`) is a
  hard-coded `task → ClickUp, else AgentMail` switch.
- **Config is global, not per tenant** (ntfy topic, ClickUp token, LLM). Ben needs his own tenant.

## Definitions (so the layers stay clean)

- **Core** — the funnel: inbound → reader → drafter → proposal → ruling → dispatch → event. Knows
  *kinds* of action, never vendors.
- **Claw** — an in-core port for one capability (`mail`, `messaging`, `tasks`, `notify`, `reader`,
  `llm`, later `calendar`, `voice`) plus swappable adapters, chosen per tenant. A claw that writes
  only fires on a ruled proposal (or an AUTO kind that earned it, `autonomy-is-earned-per-kind`).
- **Extension** — something outside the core that feeds it or is driven by it (call-listener,
  Fireflies, the receptionist, the web agent). Enters only through an `/intake/{slug}/<source>`
  route or a claw, never around them.

## Phase 1 — Fold Python's rules into the core (≈ 10/14–10/15)

Pure-function work, no schema changes. Each item lands with the Python test that pins it.

1. **Automated-sender nets** (`lib/reader/automated.ts`): add the missing domains (`@ntfy.sh`,
   `@devpost.com`, `@fireflies.ai`, `@google.com`, `@github.com`, `@discord.com`, `@alerts`,
   `@updates.`, `@info.`, `@billing`), local parts (`team@`, `news@`, `invoice`, `notes@`,
   `calendar-`), subjects ("meeting recap", "notes: meeting", "password reset", "confirm your email").
2. **Header bug:** `h["precedence"] ?? h["auto-submitted"]` ignores `auto-submitted` whenever
   `precedence` exists. Check each independently: any `auto-submitted` other than `no`, plus
   `x-auto-response-suppress`, plus `precedence: junk`.
3. **Lenient JSON** in `drafter.ts extractJson`: retry with control characters escaped (Python's
   `strict=False`), so a draft with raw newlines isn't demoted to plain text.
4. **`reclassify` internal mutation** (from `mail_reclassify.py`): re-run the automated rule over
   recorded mail and withdraw pending drafts to automated senders. Run once after items 1–2.
5. **Unchanged edit = Send** (the one wip-branch rule): `rulings.ts:71-78` always calls `edit()`, and
   with `p.gap` set it `learn()`s the draft's own text as a fact. Treat identical words as a plain sign.
6. Port the table tests: `test_gmail_categories_and_senders_decide`,
   `test_notification_domains_are_automated`, JSON-with-raw-newlines.

**Done when:** 149 + new tests green, `npm run typecheck` clean, reclassify run on prod data.

## Phase 2 — The claw layer (≈ 10/16–10/18)

Wrap, don't rewrite: `lib/*` modules and their tests stay as they are.

1. **Ports** in `convex/adapters/`, typed from Python's `ports/*`:
   - `mail { send, reply }` → AgentMail (now), Gmail (phase 3)
   - `tasks { create, get, listTagged }` → ClickUp
   - `notify { push(title, body, actions, click?, priority?) }` → ntfy
   - `reader { scrape, crawl }` → Firecrawl (moved out of `knowledge.ts` into `lib/reader/firecrawl.ts`,
     re-exported so existing test imports hold)
   - `llm { chat, embed }` → OpenAI-compat (OmniRoute-capable)
2. **Per-tenant resolver** (Python's `adapters/__init__.py *_for(tenant)`): a `tenants.adapters` map
   (`{ mail: "agentmail" | "gmail", notify: {topic}, tasks: {lists}, ... }`) plus `clawFor(tenant, port)`.
   Secrets stay in env, keyed by name (`secretName` per tenant, as the spine plan has for agents).
   Ends the shared global ntfy/ClickUp config.
3. **Dispatch by registry:** `mail.dispatch` becomes `kind → claw` lookup. Same lifecycle, same tests.
4. **Heartbeat cron** (from `jobs.py _heartbeat`): probe each tenant's claws, push a failure to the
   owner on ntfy.
5. **Call sites swapped:** `mail.ts`, `tasks.ts`, `digest.pushNew`, `drafter.ts`, `facts.ts`, `knowledge.ts`.

**Done when:** no call site constructs a vendor client directly; a second tenant runs on config alone
(port Python's `test second tenant on config alone`); all tests green.

## Phase 3 — Ben's MVP as a self-hosted install (≈ 10/19–10/27, Ben installs 10/28–10/30)

**Delivery shape (owner, 2026-10-13):** Ben gets a working repo he launches on **his own VPS**. One
setup script collects every API key and OAuth grant up front, and then he's running. No Tony-hosted
tenant, no Tony data.

Ben's spec: Fireflies meeting processing + email priority filtering + AI note digest + mobile alerts.

**Features (built on the claws):**

1. **Gmail mail adapter** (from `mail_gmail.py` + `gmail_auth.py`): OAuth consent as an HTTP route
   (redirect byte-for-byte what Google was told), scopes `gmail.readonly` + `gmail.send`, pull cron
   excluding Promotions/Social/Updates/Forums, owner's own mail skipped, dedupe by provider id, send in
   thread (`threadId`, In-Reply-To/References). Ben uses **his own Google Cloud OAuth client in testing
   mode** with himself as test user, so no Google verification is needed.
2. **Priority, not just automated/not:** a score from what the reader already knows (waiting-on-you,
   deadline, known contact, thread with a prior ruling). High priority → immediate ntfy alert even before
   the draft lands; the rest wait for the digest.
3. **Fireflies extension:** `POST /intake/{slug}/meetings` (Fireflies webhook → fetch transcript/summary)
   → action items into the existing call-items path (task proposals → tasks claw) and a **meeting note** record.
4. **Notes in the digest:** a "Meetings" section (summary + decisions + items) beside the numbered
   decisions. Weekly mode stays.

**Packaging (the part that makes it his):**

5. **Self-hosted Convex.** `compose.yml` runs the open-source Convex backend + dashboard, with Caddy for
   TLS on his domain. Functions deploy to it with `npx convex deploy` against the self-hosted URL.
   *Verify on day one of the phase* that self-hosted Convex covers everything HTR uses: vector search,
   crons, scheduler, file storage, the static-hosting component.
6. **`npm run setup`** — an interactive script, one pass:
   - asks for the domain, the owner's email, and each key: LLM (base URL + key + model), Fireflies,
     ntfy topic (offers to generate one), optional ClickUp, optional Firecrawl;
   - walks him through creating the Google OAuth client (exact console steps printed), then opens the
     consent URL and stores the refresh token;
   - writes the secrets to Convex env (`npx convex env set`), never to a committed file;
   - creates the one tenant, runs a health check on every claw, and prints what passed and what didn't.

   **Node, not Python:** the repo is already Node and deploying Convex needs Node, so a Python script
   would add a second runtime for Ben to install. (Owner's call — see open questions.)
7. **Strip Tony-specific code from the install path:** the demo inbox pool, the hackathon front door,
   the hard-coded `tony` slug, felaniam references. They stay in the repo behind config, or move out.
8. **`npm run update`** — git pull, deploy, run migrations, health check. This is how he gets fixes.
9. **`INSTALL.md`** — VPS requirements, DNS, `docker compose up`, `npm run setup`, what "working" looks like.

**Done when:** on a fresh VPS, someone other than Tony goes from `git clone` to a real email and a real
meeting reaching his phone and a ruling, using only `INSTALL.md`. Rehearse it on a throwaway VPS first.

## Phase 4 — Retire Python HTR (any time after phase 1; ~half a day)

Destructive steps; **each one confirmed with the owner at execution.**

1. Back up `/opt/htr/data/htr.db` (or the Postgres volume) and `data/*.jsonl`.
2. Stop and remove on hostvps: `htr-web`, `htr-worker`, `postgres` + volume `htr-postgres`, any
   `htr-web`/`htr-worker` systemd units (the ":8001 old switchboard services"), `/etc/htr/env`, `/opt/htr`.
3. Remove n8n workflow `HTRFrontDoor0001` and the `sb.felaniam.cloud` route.
4. Retell agent `htr-tony` and +1 276 277 8988: **park, not delete** — slice 3 needs a line. Detach the
   webhook so nothing hits a dead service.
5. Rotate the Twilio creds, the Gmail refresh token, `HTR_TONY_RETELL_SECRET`.
6. Archive GitHub `txmyer-dev/HTR` (with its wip branch) and move `~/dev/HTR` to `~/attic`. The voice
   code stays readable there as the reference for phase 5.

## Phase 5 — Extensions, after Ben ships (not scheduled)

- **Voice claw** (spine slice 3, LiveKit replacing Retell): port `tools/surface.py` rules (0.8 s budget,
  degrade to human, idempotent per call+tool call, past day snaps forward, `send_link` declines honestly),
  `_post_call`, `calls`/`appointments` tables, provisioning, and all the Python voice tests.
- **Messaging claw** (Twilio SMS): signature check, SMS expiry notices, fail loudly without a texting channel.
- **Calendar claw** (Google first), contacts `upsertFromCall`.
- **Receptionist** on voice + calendar claws.
- **Spine slices 1–2** (agents registry, widened proposals, runs + trace, leases, `uncertain` actions),
  when a second executor needs them. **Verified callers** (slice 4).

## Open questions for the owner

All settled 2026-10-13 (owner): claws may write into third-party systems
(`_decisions#integrations-are-the-claws`); Ben self-hosts with his own OAuth client; **setup is Node**;
**Fireflies is a standard add-on** (setup offers it to every install); Ben installs from `htr-convex`
**directly or from a fork**; work happens on branch **`core-merge`**, merged after each phase.

**Bring-your-own accounts (owner):** each user brings their own **Composio**, **treg** and **jev**.
Setup asks for each (all optional), stores them in Convex env, and health-checks them. They are claw
adapters, never Tony's accounts: Composio as a broad adapter behind the claws (many apps through one
key), treg for data and generation tools, jev for recall and the per-kind confidence that
`autonomy-is-earned-per-kind` reads. Wiring each beyond the key + health check is phase 5 unless Ben's
MVP needs it.

**Approved by the owner 2026-10-13.**
