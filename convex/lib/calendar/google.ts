// Google Calendar over REST, sharing the Gmail grant's token (../google/auth.ts). No SDK, like
// Gmail. Reads span every calendar the owner subscribes to; the two writes (insert, move) name
// `primary` and nothing else, because no scope limits writes to it (KTD1). Only the event
// dispatcher calls them (adapters/ports.ts).

import { accessToken, type GoogleCreds } from "../google/auth";
import { offsetAt } from "../time";
import type { Interval } from "./availability";

const API = "https://www.googleapis.com/calendar/v3";
const PRIMARY = "primary";

type Fetch = typeof fetch;

export type CalendarInfo = { id: string; summary: string; primary: boolean; timeZone?: string };

export type CalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  /** All-day events run local midnight to local midnight in their calendar's zone. */
  allDay: boolean;
  start: number;
  end: number;
  status: string; // confirmed | tentative | cancelled
  attendees: string[]; // lowercased
  organizerSelf: boolean;
  /** The owner's own answer, when the owner is on the attendee list. */
  responseStatus?: string;
  /** Marked "free": Google's free/busy doesn't count it. */
  transparent: boolean;
};

/** Busy per calendar, and the calendars Google couldn't answer for. An erroring calendar is unknown, never free. */
export type FreeBusy = { busy: Record<string, Interval[]>; errors: Record<string, string> };

export type NewEvent = { summary: string; description?: string; start: number; end: number; timeZone: string; attendees: string[] };

type Time = { dateTime?: string; date?: string; timeZone?: string };
type RawEvent = {
  id: string; status?: string; summary?: string; start?: Time; end?: Time; transparency?: string;
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Local midnight of a `YYYY-MM-DD` date in `timeZone`. */
function localMidnight(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

const instant = (t: Time | undefined, zone: string) => (t?.dateTime ? Date.parse(t.dateTime) : t?.date ? localMidnight(t.date, t.timeZone ?? zone) : NaN);

function toEvent(e: RawEvent, calendarId: string, zone: string): CalendarEvent {
  const self = e.attendees?.find((a) => a.self);
  return {
    id: e.id,
    calendarId,
    title: e.summary ?? "",
    allDay: !e.start?.dateTime && Boolean(e.start?.date),
    start: instant(e.start, zone),
    end: instant(e.end, zone),
    status: e.status ?? "confirmed",
    attendees: (e.attendees ?? []).flatMap((a) => (a.email ? [a.email.toLowerCase()] : [])),
    organizerSelf: Boolean(e.organizer?.self),
    responseStatus: self?.responseStatus,
    transparent: e.transparency === "transparent",
  };
}

const wireTime = (ms: number, timeZone: string) => ({ dateTime: new Date(ms).toISOString(), timeZone });

export class GoogleCalendar {
  constructor(
    private readonly creds: GoogleCreds,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken(this.creds, this.fetchImpl)}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `Calendar ${method} ${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Every calendar the owner subscribes to and hasn't hidden. */
  async calendars(): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let page: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: "250", ...(page ? { pageToken: page } : {}) });
      const r = await this.call<{ items?: Array<{ id: string; summary?: string; primary?: boolean; hidden?: boolean; deleted?: boolean; timeZone?: string }>; nextPageToken?: string }>("GET", `/users/me/calendarList?${params}`);
      for (const c of r.items ?? []) {
        if (c.hidden || c.deleted) continue;
        out.push({ id: c.id, summary: c.summary ?? c.id, primary: Boolean(c.primary), ...(c.timeZone ? { timeZone: c.timeZone } : {}) });
      }
      page = r.nextPageToken;
    } while (page);
    return out;
  }

  /** One calendar's events in the window, recurring ones expanded, in start order. */
  private async list(calendarId: string, w: Interval): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let page: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: new Date(w.start).toISOString(), timeMax: new Date(w.end).toISOString(),
        singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(page ? { pageToken: page } : {}),
      });
      const r = await this.call<{ items?: RawEvent[]; nextPageToken?: string; timeZone?: string }>("GET", `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
      for (const e of r.items ?? []) out.push(toEvent(e, calendarId, r.timeZone ?? "UTC"));
      page = r.nextPageToken;
    } while (page);
    return out;
  }

  /** Events in the window across `calendarIds` (default: every non-hidden calendar), for display and matching. */
  async events(w: Interval, calendarIds?: string[]): Promise<CalendarEvent[]> {
    const ids = calendarIds ?? (await this.calendars()).map((c) => c.id);
    const out: CalendarEvent[] = [];
    for (const id of ids) out.push(...(await this.list(id, w)));
    return out;
  }

  /** Busy time per calendar in one request. A calendar with errors, or missing from the answer, lands in `errors`. */
  async freeBusy(w: Interval, calendarIds: string[]): Promise<FreeBusy> {
    const r = await this.call<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }> }>("POST", "/freeBusy", {
      timeMin: new Date(w.start).toISOString(), timeMax: new Date(w.end).toISOString(),
      items: calendarIds.map((id) => ({ id })),
    });
    const out: FreeBusy = { busy: {}, errors: {} };
    for (const id of calendarIds) {
      const c = r.calendars?.[id];
      if (!c) out.errors[id] = "missing from the response";
      else if (c.errors?.length) out.errors[id] = c.errors.map((e) => e.reason ?? "error").join(", ");
      else out.busy[id] = (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
    }
    return out;
  }

  /**
   * Busy time on `primary` as free/busy would count it (not cancelled, not marked free, not
   * declined), minus `excludeEventId`: free/busy carries no ids, so it would count the card's own
   * event, or the one being moved, against itself (KTD5).
   */
  async primaryBusy(w: Interval, excludeEventId?: string): Promise<Interval[]> {
    return (await this.list(PRIMARY, w))
      .filter((e) => e.id !== excludeEventId && e.status !== "cancelled" && !e.transparent && e.responseStatus !== "declined")
      .map((e) => ({ start: e.start, end: e.end }));
  }

  /** An event on `primary`, cancelled ones included; null when Google has no such id. */
  async get(id: string): Promise<CalendarEvent | null> {
    try {
      return toEvent(await this.call<RawEvent>("GET", `/calendars/${PRIMARY}/events/${encodeURIComponent(id)}`), PRIMARY, "UTC");
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  }

  /** A new event on `primary` under the caller's id, inviting the attendees. A taken id is `exists`, for the caller to GET. */
  async insert(ev: NewEvent, id: string): Promise<{ exists: true } | { exists: false; event: CalendarEvent }> {
    const body = {
      id,
      summary: ev.summary,
      ...(ev.description ? { description: ev.description } : {}),
      start: wireTime(ev.start, ev.timeZone),
      end: wireTime(ev.end, ev.timeZone),
      attendees: ev.attendees.map((email) => ({ email })),
    };
    try {
      const r = await this.call<RawEvent>("POST", `/calendars/${PRIMARY}/events?sendUpdates=all`, body);
      return { exists: false, event: toEvent(r, PRIMARY, ev.timeZone) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return { exists: true };
      throw e;
    }
  }

  /** New times for an event on `primary`. Only start and end go: patch replaces arrays, so attendees stay untouched. */
  async move(id: string, start: number, end: number, timeZone: string): Promise<CalendarEvent> {
    const r = await this.call<RawEvent>("PATCH", `/calendars/${PRIMARY}/events/${encodeURIComponent(id)}?sendUpdates=all`, {
      start: wireTime(start, timeZone),
      end: wireTime(end, timeZone),
    });
    return toEvent(r, PRIMARY, timeZone);
  }
}
