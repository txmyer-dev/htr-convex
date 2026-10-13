# Handoff — one HTR: core → claws → extensions

*Written 2026-10-13 at the end of a Claude Code session on Tony's Windows laptop. Work moves to
**hostvps**. Read this, then `docs/merge-plan.md` (the approved plan), then start phase 3.*

## Where things stand

| | |
|---|---|
| Branch | work on **`core-merge`**; `main` is fast-forwarded to it after each phase |
| Tests | `npm test`: **162 passing**, offline, ~3 s. `npm run typecheck`: clean |
| Live deployment | Convex **`famous-spider-906`** (a *dev* deployment, team tony-myers, project htr-convex), which is the live one. Phases 1–2 are deployed there |
| Plan | `docs/merge-plan.md`, approved by Tony 2026-10-13. Phases 1 and 2 are **done** |
| Deadline | Ben Hidalgo's beta, **2026-10-30** (Ben installs 10/28–10/30) |

### Owner rulings behind this (in Tony's vault, `~/wiki/04-ANCHORS/_decisions.md`)

- `htr-is-core-then-claws-then-extensions`: HTR is the foundation of the agent system. Build order:
  core (one HTR on Convex), then claws (port/adapter tools), then extensions (receptionist, call-listener…).
- `integrations-are-the-claws`: reverses `bring-the-data-not-integrations`. HTR writes into people's
  real tools, but only through a claw and only after a ruling.
- `python-htr-retires-into-convex`: Python HTR (`txmyer-dev/HTR`) is folded in, then archived.
- `htr-is-one-funnel-connectors-make-the-icp`: one agent; connectors decide who it's for.

## What was done (2026-10-13)

**Phase 1 — `38176cb`** (Python HTR's rules into the core)
- `convex/lib/reader/automated.ts`: Python's sender/domain/subject nets. Each header is now its own signal:
  previously `precedence` hid `auto-submitted`. Also `x-auto-response-suppress` and `precedence: junk`.
- `convex/drafter.ts extractJson`: retries with raw control characters escaped inside strings.
- `convex/rulings.ts applyVerdict`: an "edit" in the draft's own words is a plain sign. Before, it
  `learn()`ed the draft back as a fact.
- `mail:reclassify` (internal): withdraws pending drafts the rule now calls automated. Ran on live: 0 pending.

**Phase 2 — `74e729f`** (the claw layer)
- `convex/adapters/ports.ts`: `MailClaw`, `TaskClaw`, `NotifyClaw`, `ReaderClaw`, `LlmClaw`, each with an
  optional `probe()`.
- `convex/adapters/vendors.ts`: AgentMail, ClickUp, ntfy, Firecrawl and OpenAI-compat. Each is a thin wrap of
  `lib/*`, which is unchanged.
- `convex/adapters/resolve.ts`: `mailClaw / taskClaw / notifyClaw / readerClaw / llmClaw(tenant)`.
  - Reads the tenant's new optional `adapters` block. Secrets are named by env var (`keyEnv`, `tokenEnv`),
    never stored.
  - Falls back to the deployment-wide env vars, so one install = one tenant configured by env alone.
- `mail.dispatch` is a `kind → claw` registry (`DISPATCH`). `sms` throws, because there's no messaging claw yet.
- `convex/health.ts` + an hourly cron: probes each claw, stores `clawHealth`, and pushes to the owner only on
  a change. Ran on live: mail, llm and reader are up.
- Moves, re-exported from the old homes:
  - the Firecrawl wire → `lib/reader/firecrawl.ts`
  - `normalizeBaseUrl` → `lib/llm/baseUrl.ts`
- Deliberately still outside the claws:
  - `mail.provision` (AgentMail inbox/webhook setup)
  - `demo.ts` (the front door; phase 3 takes it off the install path)
  - the ntfy CORS check in `http.ts`

## Gap found on live (not caused by this work)

`npx convex env list` on famous-spider-906 has **no `CLICKUP_API_TOKEN` and no `HTR_NTFY_TOPIC`**. So the
10/11–12 features (call items → ClickUp, per-item phone pushes) have never fired on live. Setting the two env
vars turns them on, and the heartbeat will then watch them. **Ask Tony before setting them.**

## Next: phase 3 (Ben's MVP as a self-hosted install)

Full spec in `docs/merge-plan.md` § Phase 3. Do it in this order:

1. **Verify self-hosted Convex first (day one; it is the one real risk).** On hostvps, run the open-source
   Convex backend + dashboard in Docker. Deploy this repo to it (`npx convex deploy` against the self-hosted
   URL and admin key). Confirm every feature HTR uses works there:
   - vector search (`chunks.by_embedding`)
   - crons and the scheduler
   - file storage and the `@convex-dev/static-hosting` component
   - http actions

   If any of these fails, stop and tell Tony before building more.
2. **Gmail mail adapter** (a new `MailClaw` behind `adapters.mail: { kind: "gmail" }`). Port from Python
   `HTR/src/htr/adapters/mail_gmail.py` and `gmail_auth.py` on the `main` branch:
   - OAuth consent as an http route; the redirect must match what Google was told, byte for byte
   - scopes `gmail.readonly` + `gmail.send`
   - a pull cron that excludes the Promotions, Social, Updates and Forums categories
   - skip the owner's own mail; dedupe by provider id
   - send in thread (`threadId`, In-Reply-To/References)

   Each user brings their own Google Cloud OAuth client in testing mode.
3. **Priority**: a score from what the reader knows (waiting-on-you, deadline, known contact, a thread with a
   prior ruling). High priority → an immediate push.
4. **Fireflies extension** (a standard add-on for every install): `POST /intake/{slug}/meetings` → action
   items into the existing call-items path, plus a meeting-note record → a "Meetings" section in the digest.
5. **Packaging**:
   - `compose.yml`: self-hosted Convex + dashboard + Caddy
   - `npm run setup` (**Node**, interactive):
     - asks for domain, owner email, LLM, Fireflies, ntfy, and optionally ClickUp, Firecrawl,
       **Composio, treg, jev** (each user brings their own)
     - walks through the Google OAuth client and stores the refresh token
     - writes Convex env, creates the tenant, health-checks every claw
   - `npm run update`: pull, deploy, migrate, health check
   - `INSTALL.md`
   - strip Tony-specific code from the install path: demo pool, hackathon front door, the hard-coded `tony`
     slug (also in `call-listener/cl/htr.py:15`)
6. **Done when** someone other than Tony goes from `git clone` on a fresh VPS to a real email and a real
   meeting reaching his phone and a ruling, using only `INSTALL.md`. Ben installs from this repo directly or
   from a fork.

Phase 4 (retire Python HTR on hostvps) can run any time. Its teardown list is in the plan.
**Confirm each destructive step with Tony.** Park the Retell number; don't delete it.

## How to work here

```bash
npm ci
npm test && npm run typecheck       # before every commit
npx convex codegen                  # after adding a convex/ module (regenerates _generated/api.d.ts)
npx convex dev --once               # push functions to the deployment in .env.local (live: famous-spider-906)
npx convex run health:beat          # probe every claw now
```

- Read `convex/_generated/ai/guidelines.md` before Convex work (CLAUDE.md requires it).
- The repo uses **LF** line endings. Windows Python rewrote two files as CRLF once, so prefer Node or the
  editor for scripted edits.
- Commit per step with tests green. Fast-forward `main` after each phase. Deploy to live only with the phase done.
- `.env.local` is not in git. On hostvps, run `npx convex dev` once to link the deployment (Tony's Convex login).
