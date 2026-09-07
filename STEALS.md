# STEALS

The ledger. This repo is self-contained: it builds, tests, and runs from its own files and
public packages only. Every module that came from somewhere else is listed here, with where it
came from and what changed in the port. This file is the only place the source repositories are
named. Nothing in the repo can reach for them.

All sources are ours (MIT where public), so this is provenance, not permission. Hackathon rule
observed: Waggle (Sept 2026) and HTR (Sept 2026) are in-window and ported; switchboard's code is
not, so what HTR had stolen from switchboard (config, jobs, web app, voice tools) is
**re-expressed** here on Convex primitives, not copied.

| here | from | changed |
|---|---|---|
| `convex/lib/rulings/parse.ts` | waggle `src/rulings/parse.ts`; HTR `rulings/parse.py` | TypeScript again; numbered form, word marks, four commands from HTR; `stripQuoted` new (email replies quote the digest) |
| `convex/lib/reader/waiting.ts` | waggle `src/tools/waiting.ts`; HTR `reader/waiting.py` | ms timestamps; `latestUnanswered` from HTR |
| `convex/lib/reader/deadline.ts` | HTR `reader/deadline.py` | Intl instead of zoneinfo (`lib/time.ts` new) |
| `convex/lib/reader/automated.ts` | HTR `adapters/mail_gmail.py` (the filter, not the code) | rewritten as header + sender + subject + body nets; Gmail categories are not available |
| `convex/lib/proposals/lifecycle.ts` | waggle `src/proposals/store.ts`; HTR `proposals/store.py` | the status graph as data; the store itself is `convex/proposals.ts` (mutations) |
| `convex/lib/digest/render.ts` | HTR `digest/render.py` | unchanged in behaviour; `DigestItem` is any row with the fields |
| `convex/lib/digest/expiry.ts` | HTR `digest/expiry.py` | `isOverdue` pure; the pass is `rulings.expirePass` |
| `convex/lib/rulings/token.ts` | HTR `rulings/controller.py` (`ruling_token`) | Web Crypto; `rulingLinks` new |
| `convex/proposals.ts` | HTR `proposals/store.py` | transitions guarded by the mutation transaction instead of `WHERE status IN` |
| `convex/rulings.ts` | waggle `src/rulings/controller.ts`; HTR `rulings/controller.py` | transport is the digest email out and the AgentMail webhook back; link and surface rulings; dispatch is a scheduled action |
| `convex/digest.ts` | HTR `rulings/controller.py` (`send_digest`), `jobs.py` (`enqueue_once`) | debounce via `scheduler` + `tenant.digestScheduled`; HTML email with buttons new |
| `convex/drafter.ts` | HTR `jobs.py` (`_draft`), `adapters/llm_openai_compat.py`; icm-agent (the Basis discipline) | OpenAI SDK; business notes from Firecrawl in the prompt |
| `convex/mail.ts` | HTR `jobs.py` (`_mail_pull`, `_dispatch_email`), `web/app.py` (`sms_webhook`) | push (webhook) instead of pull; one inbox for both channels |
| `convex/events.ts` | HTR `events.py` (switchboard, re-expressed) | `appendEvent`, `recordAction` as Convex inserts |
| `convex/http.ts` | HTR `web/app.py` (switchboard, re-expressed) | `httpRouter`; mail webhook and ruling links |
| `convex/crons.ts` | HTR `worker.py` (switchboard, re-expressed) | `cronJobs` |
| `tests/parse.test.ts`, `tests/digest.test.ts`, `tests/reader.test.ts`, `tests/lifecycle.test.ts` | HTR `tests/test_parse.py`, `test_digest.py`, `test_reader.py`, `test_store.py`; waggle `rulings.test.ts`, `store.test.ts` | ported with the modules |
| `tests/loop.test.ts` | HTR `tests/test_loop.py` (the shape) | rewritten on convex-test |

New here, no source: `convex/schema.ts`, `convex/install.ts`, `convex/surface.ts`,
`convex/knowledge.ts` (the business site and the sender's site, by Firecrawl),
`convex/lib/knowledge/domain.ts` (whose domain is worth reading; what a draft rested on),
`convex/lib/knowledge/rank.ts` (which pages of the site go in front of the drafter),
`convex/lib/knowledge/links.ts` (which links in a message are worth reading),
`convex/lib/knowledge/chunk.ts` (a page in pieces; the pieces the drafter reads), `convex/lib/llm/embed.ts` (embeddings over the same endpoint),
`convex/demo.ts` (the front door: the inbox pool and its leases), `convex/facts.ts` (the second brain: what the owner teaches), `convex/lib/mail/{svix,inbound,agentmail}.ts`,
`convex/lib/time.ts`, `convex/lib/drafter/lessons.ts` (the owner's edits as the drafter's lessons),
`src/` (the front door and the live surface).

Not carried over (yet): voice (Retell's six in-call tools, `post_call`), Twilio SMS, the
Gmail adapter, `python -m htr.check`. When HTR steals this build back, `STEALS.md` there gets
the rows.
