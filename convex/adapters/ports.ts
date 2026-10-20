// The claws: one port per capability the agent acts or reads through, typed after Python HTR's
// ports/ (2026-09). The core knows ports, never vendors; an adapter wraps one vendor's wire
// (lib/*) and is chosen per tenant by ./resolve.ts. A port that writes only ever runs on a
// ruled proposal (_decisions#integrations-are-the-claws).

import type { Interval } from "../lib/calendar/availability";
import type { CalendarEvent, CalendarInfo, FreeBusy, NewEvent } from "../lib/calendar/google";
import type { ChatMessage } from "../lib/llm/openaiCompat";
import type { InboundMail } from "../lib/mail/inbound";
import type { Meeting } from "../lib/meetings/fireflies";
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

/** A meeting recorder (Fireflies): reads back a finished meeting's notes. Read-only, so no ruling gates it. */
export interface MeetingsClaw extends Probe {
  get(meetingId: string): Promise<Meeting | null>;
}

/**
 * The owner's calendars (Google). Reads run unruled; insert and move write to `primary` only and
 * are called only from the event dispatcher, on a signed card.
 */
export interface CalendarClaw extends Probe {
  calendars(): Promise<CalendarInfo[]>;
  /** Events in the window across `calendarIds`, default every non-hidden calendar. */
  events(window: Interval, calendarIds?: string[]): Promise<CalendarEvent[]>;
  /** Busy per calendar; a calendar in `errors` is unknown, never free. */
  freeBusy(window: Interval, calendarIds: string[]): Promise<FreeBusy>;
  /** Busy on `primary` with one event left out (the card's own, or the one being moved). */
  primaryBusy(window: Interval, excludeEventId?: string): Promise<Interval[]>;
  get(id: string): Promise<CalendarEvent | null>;
  insert(event: NewEvent, id: string): Promise<{ exists: true } | { exists: false; event: CalendarEvent }>;
  move(id: string, start: number, end: number, timeZone: string): Promise<CalendarEvent>;
}

export type Port = "mail" | "tasks" | "notify" | "reader" | "llm" | "meetings" | "calendar";
