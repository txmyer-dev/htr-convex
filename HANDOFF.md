> **Superseded 2026-10-18.** Live HTR is now self-hosted Convex on the GCP VM
> (`htr.34-136-84-15.sslip.io`); `famous-spider-906` and `brave-sockeye-180` are retired —
> **do not deploy to them.** AgentMail holds only `tony-htr`. Current plan:
> `~/wiki/02-PROJECTS/felani-am/crew-launch-handoff.md`.

# Handoff — one HTR: core → claws → extensions

*Started 2026-10-13 on Tony's Windows laptop (phases 1–2); updated the same day on **hostvps**
after phase 3's build. Read this, then `docs/merge-plan.md` (the approved plan).*

## Where things stand

| | |
|---|---|
| Branch | work on **`core-merge`**; `main` is fast-forwarded to it after each phase |
| Tests | `npm test`: **212 passing**, offline. `npm run typecheck`: clean. Gate commits on the test **exit status** |
| Live deployment | Convex **`famous-spider-906`** (a *dev* deployment, team tony-myers, project htr-convex), which is the live one. Phases 1–2 are deployed there; **phase 3 is not** (deploy when the phase is done) |
| Test backend | Self-hosted Convex on hostvps: `/root/convex-selfhost-test` (compose), public at `https://htr-test.felaniam.cloud` (Traefik file `/etc/dokploy/traefik/dynamic/htr-test.yml`). Deployed from the detached worktree `/root/htr-selfhost`, whose `.env.local` points only at it. Test tenant `tony-gmail-test` (Gmail connected; no ntfy topic, by Tony's request) |
| Plan | `docs/merge-plan.md`, approved by Tony 2026-10-13. Phases 1–2 **done**; phase 3 **built**, rehearsal pending |
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

## Phase 3, built on hostvps (2026-10-13)

All on `core-merge`, pushed. Each verified on the test backend against Tony's real accounts.

1. **Self-hosted Convex verified:** vector search, crons, scheduler, file storage, static hosting and
   http actions all work on the open-source backend (pinned in `compose.yml` to build `5c7cb5b`).
2. **Gmail claw** (`lib/mail/gmail.ts`, `gmail.ts`): a 2-minute pull cron, threaded replies, consent
   as an http route (`gmail:connectUrl` → `/oauth/google/{slug}/start` → `/oauth/google/callback`),
   and a grant kept on `tenant.channels.gmail`. Verified: connect, pull, classify, threaded reply.
   OAuth client: GCP project `hold-the-room`, **published "In production"**. Testing mode expires
   grants after 7 days, which is what killed Python HTR's token (`invalid_grant`).
3. **Priority** (`lib/reader/priority.ts`): scored at intake. High (≥ 6) → `mail.alertOwner` ntfy
   push right away, or when `quietHours` end. The digest leads with it (`‼`). Also fixed:
   `digest.run` skipped the email for tenants without an AgentMail inbox (`hasMail`).
4. **Fireflies extension** (`lib/meetings/fireflies.ts`, `meetings.ts`): `POST /intake/{slug}/meetings`
   (X-Hub-Signature or the intake key) → read over GraphQL → `meetings` row. Action items go through
   `tasks.takeCallItems` when there's a task list, plus a Meetings section in the digest and a push.
   Verified with a real meeting.
5. **Packaging:** `compose.yml` + `Caddyfile`, `npm run setup` / `npm run update` (`scripts/`),
   `install:create` / `install:status`, `migrations.ts`, `INSTALL.md`. The hackathon front door is
   opt-in (`VITE_HTR_FRONT_DOOR=1`, set in Tony's `.env.local`); otherwise `/` is a closed door. Ben
   never runs `install:apply` (Tony's `TENANTS`). The demo pool stays closed while `HTR_DEMO_POOL`
   is unset.

**Live env:** `CLICKUP_API_TOKEN` and `HTR_NTFY_TOPIC` (`htr-tony-e1d4107c42c3a0f0`) were set on
famous-spider-906 with Tony's OK. The heartbeat shows all five claws up.

## Next

1. **Rehearse `INSTALL.md` on a throwaway VPS** (the "done when" in the plan). Ports 80/443 must be
   free, so hostvps (Traefik) can't host it.
2. Deploy phase 3 to live and fast-forward `main`, once the rehearsal passes and Tony agrees.
3. `call-listener/cl/htr.py:15` still hard-codes the `tony` slug (that's in the call-listener repo).
4. Composio / treg / jev: setup stores the keys, but nothing probes or uses them yet (phase 5).
5. Rulings by email reply don't work for Gmail installs (own mail is excluded from the pull).
   Rulings by ntfy and the web page do.
6. A weekly-digest owner gets meeting notes as pushes, not in the Sunday email.

Phase 4 (retire Python HTR on hostvps) can run any time. Its teardown list is in the plan.
**Confirm each destructive step with Tony.** Park the Retell number; don't delete it.
Python HTR's Gmail token is dead anyway.

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
