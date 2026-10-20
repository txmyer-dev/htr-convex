// The owner's phone: one ntfy notification per waiting item, ruled from the notification itself.
// Send and Skip are http actions that POST the item's signed ruling link (the same links the
// digest email carries), so a tap rules without opening anything; Edit opens the edit page.
// Tapping the notification body opens the live surface.
//
// HTR_NTFY_TOPIC on the deployment turns it on (HTR_NTFY_URL, default https://ntfy.sh;
// HTR_NTFY_TOKEN for a protected server). Use its own topic, not the call listener's: the
// listener reads its topic for phone questions.

import type { Notice } from "../../adapters/ports";
import { eventWhen, eventWho, signLabel, type CardEvent } from "../proposals/lifecycle";

export type NtfyConfig ={ url: string; topic: string; token?: string };

export function ntfyConfig(): NtfyConfig | null {
  const topic = process.env.HTR_NTFY_TOPIC;
  if (!topic) return null;
  return { url: (process.env.HTR_NTFY_URL ?? "https://ntfy.sh").replace(/\/+$/, ""), topic, token: process.env.HTR_NTFY_TOKEN };
}

export type PushItem = {
  kind?: string; toName?: string | null; toAddress: string; body: string; basis: string[]; priority?: string | null;
  event?: CardEvent | null; // an event card: Add + send rules the calendar write and the reply at once
};
export type PushLinks = { sign: string; reject: string; edit: string };

/** The notice for one waiting item, in any notify claw's shape (adapters/ports.ts Notice). */
export function noticeFor(item: PushItem, links: PushLinks, surface: string): Notice {
  const task = item.kind === "task";
  // The phone approves without opening anything, so an event card leads with what approval does.
  const ev = item.kind === "event" ? item.event : null;
  const quote = item.basis[0] ? `\n\n“${item.basis[0]}”` : "";
  const head = ev ? `${eventWhen(ev)}\n${eventWho(ev)}\n\n` : "";
  const title = ev
    ? `${ev.op === "move" ? "Move on calendar" : "Add to calendar"}: ${ev.title}`
    : task ? `Task → ${item.toName}` : `Draft to ${item.toName || item.toAddress}`;
  return {
    title,
    message: (head + item.body + quote).slice(0, 1500),
    tags: [ev ? "calendar" : task ? "pushpin" : "envelope"],
    ...(item.priority === "high" ? { priority: 4 } : {}),
    click: surface,
    actions: [
      { action: "http", label: signLabel(item.kind ?? "email", ev), url: links.sign, method: "POST", clear: true },
      { action: "http", label: "Skip", url: links.reject, method: "POST", clear: true },
      { action: "view", label: "Edit", url: links.edit },
    ],
  };
}

export function notification(cfg: NtfyConfig, item: PushItem, links: PushLinks, surface: string) {
  return { topic: cfg.topic, ...noticeFor(item, links, surface) };
}

export async function push(cfg: NtfyConfig, message: { topic: string } & object, f: typeof fetch = fetch): Promise<void> {
  const res = await f(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}
