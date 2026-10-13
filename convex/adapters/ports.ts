// The claws: one port per capability the agent acts or reads through, typed after Python HTR's
// ports/ (2026-09). The core knows ports, never vendors; an adapter wraps one vendor's wire
// (lib/*) and is chosen per tenant by ./resolve.ts. A port that writes only ever runs on a
// ruled proposal (_decisions#integrations-are-the-claws).

import type { ChatMessage } from "../lib/llm/openaiCompat";
import type { InboundMail } from "../lib/mail/inbound";
import type { AgendaTask, NewTask, TaskState } from "../lib/tasks/clickup";

export type Sent = { ref: string; threadId?: string };

/** Probe: a cheap read that proves the adapter's credentials and endpoint work. */
type Probe = { readonly name: string; probe?: () => Promise<void> };

export interface MailClaw extends Probe {
  send(m: { to: string[]; cc?: string[]; subject: string; text: string; html?: string; headers?: Record<string, string> }): Promise<Sent>;
  /** A reply in the thread of a message this adapter delivered (its vendor id). */
  reply(messageId: string, m: { text: string; html?: string }): Promise<Sent>;
  /** A mailbox HTR reads rather than one that calls in (Gmail): mail since `sinceMs`, oldest first, minus the ids `seen` names. */
  pull?(sinceMs: number, seen?: (ids: string[]) => Promise<string[]>): Promise<InboundMail[]>;
}

export interface TaskClaw extends Probe {
  create(listId: string, t: NewTask): Promise<TaskState>;
  get(id: string): Promise<TaskState>;
  /** Open tasks carrying a tag (a series' agenda); [] when the adapter has no workspace to search. */
  listTagged(tag: string): Promise<AgendaTask[]>;
}

export type Action =
  | { action: "http"; label: string; url: string; method: "POST"; clear?: boolean }
  | { action: "view"; label: string; url: string };

export type Notice = { title: string; message: string; tags?: string[]; click?: string; actions?: Action[]; priority?: number };

export interface NotifyClaw extends Probe {
  push(n: Notice): Promise<void>;
}

export type Page = { url: string; title?: string; markdown: string };

export interface ReaderClaw extends Probe {
  scrape(url: string, cap?: number): Promise<Page>;
  crawl(url: string, opts?: { limit?: number }): Promise<Page[]>;
}

export interface LlmClaw extends Probe {
  chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

export type Port = "mail" | "tasks" | "notify" | "reader" | "llm";
