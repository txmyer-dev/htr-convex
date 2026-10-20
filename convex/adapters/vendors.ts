// One adapter per vendor, each a thin wrap of its wire in lib/*. Nothing here reads the
// environment or the tenant: ./resolve.ts hands each one its credentials.

import { GoogleCalendar, isGoogleGenerated } from "../lib/calendar/google";
import type { GoogleCreds } from "../lib/google/auth";
import { AgentMail } from "../lib/mail/agentmail";
import { getMeeting, whoAmI } from "../lib/meetings/fireflies";
import { Gmail, type GmailCreds } from "../lib/mail/gmail";
import { chatCompletion } from "../lib/llm/openaiCompat";
import { embed } from "../lib/llm/embed";
import { push } from "../lib/notify/ntfy";
import { crawl, scrape } from "../lib/reader/firecrawl";
import { createTask, getTask, openTasksTagged } from "../lib/tasks/clickup";
import type { CalendarClaw, LlmClaw, MailClaw, MeetingsClaw, NotifyClaw, ReaderClaw, TaskClaw } from "./ports";

type Fetch = typeof fetch;

async function ok(f: Fetch, url: string, init: RequestInit, what: string): Promise<void> {
  const res = await f(url, init);
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function agentMail(apiKey: string, inboxId: string, f: Fetch = fetch): MailClaw {
  const c = new AgentMail(apiKey, undefined, f);
  return {
    name: "agentmail",
    send: async (m) => {
      const r = await c.send(inboxId, m);
      return { ref: r.messageId, threadId: r.threadId };
    },
    reply: async (messageId, m) => {
      const r = await c.reply(inboxId, messageId, m);
      return { ref: r.messageId, threadId: r.threadId };
    },
    probe: () => ok(f, `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}`, { headers: { authorization: `Bearer ${apiKey}` } }, "AgentMail"),
  };
}

export function gmail(creds: GmailCreds, address: string | undefined, f: Fetch = fetch): MailClaw {
  const c = new Gmail(creds, address, f);
  return {
    name: "gmail",
    send: async (m) => {
      const r = await c.send(m);
      return { ref: r.messageId, threadId: r.threadId };
    },
    reply: async (messageId, m) => {
      const r = await c.reply(messageId, m);
      return { ref: r.messageId, threadId: r.threadId };
    },
    pull: (sinceMs, seen) => c.pull(sinceMs, seen),
    probe: async () => {
      await c.profile();
    },
  };
}

/** The probe is a short free/busy over every non-hidden calendar: one failing one makes every time unknown (KTD7). */
export function googleCalendar(creds: GoogleCreds, f: Fetch = fetch): CalendarClaw {
  const c = new GoogleCalendar(creds, f);
  return {
    name: "google-calendar",
    calendars: () => c.calendars(),
    events: (w, ids) => c.events(w, ids),
    freeBusy: (w, ids) => c.freeBusy(w, ids),
    primaryBusy: (w, exclude) => c.primaryBusy(w, exclude),
    get: (id) => c.get(id),
    insert: (ev, id) => c.insert(ev, id),
    move: (id, start, end, tz) => c.move(id, start, end, tz),
    probe: async () => {
      const cals = (await c.calendars()).filter((x) => !isGoogleGenerated(x.id));
      const now = Date.now();
      const { errors } = await c.freeBusy({ start: now, end: now + 3_600_000 }, cals.map((x) => x.id));
      const bad = cals.filter((x) => errors[x.id]).map((x) => `${x.summary} (${errors[x.id]})`);
      if (bad.length) throw new Error(`free/busy failed for ${bad.join(", ")}`);
    },
  };
}

export function fireflies(apiKey: string, f: Fetch = fetch): MeetingsClaw {
  return {
    name: "fireflies",
    get: (meetingId) => getMeeting(apiKey, meetingId, f),
    probe: async () => {
      await whoAmI(apiKey, f);
    },
  };
}

export function clickUp(token: string, teamId: string | undefined, f: Fetch = fetch): TaskClaw {
  return {
    name: "clickup",
    create: (listId, t) => createTask(token, listId, t, f),
    get: (id) => getTask(token, id, f),
    listTagged: async (tag) => (teamId ? await openTasksTagged(token, teamId, tag, f) : []),
    probe: () => ok(f, "https://api.clickup.com/api/v2/user", { headers: { Authorization: token } }, "ClickUp"),
  };
}

export function ntfy(cfg: { url: string; topic: string; token?: string }, f: Fetch = fetch): NotifyClaw {
  return {
    name: "ntfy",
    push: (n) => push(cfg, { topic: cfg.topic, ...n }, f),
  };
}

export function firecrawl(apiKey: string, f: Fetch = fetch): ReaderClaw {
  return {
    name: "firecrawl",
    scrape: (url, cap) => scrape(url, apiKey, f, cap),
    crawl: (url, opts) => crawl(url, apiKey, f, opts),
  };
}

export function openAiCompat(o: { baseUrl: string; apiKey: string; model: string; embedModel: string }, f: Fetch = fetch): LlmClaw {
  return {
    name: "openai-compat",
    chat: (messages, opts = {}) => chatCompletion({ baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model, messages, ...opts }, f),
    embed: (texts) => embed(texts, { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.embedModel }, f),
    probe: () => ok(f, `${o.baseUrl}/models`, { headers: { authorization: `Bearer ${o.apiKey}` } }, "model gateway"),
  };
}
