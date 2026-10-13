// What the call line may hand the spine (call-listener: line/README.md, stages 03-04). The line
// has already classified and routed each item; the spine takes only the ones routed to the task
// list, and refuses anything private to someone else even if the line got it wrong (the same
// hard rule the line enforces in code, enforced again on this side of the wire).

export type CallItem = {
  id: string; // stable within a session: i<window>
  type: string; // my_commitment | owed_to_me | ...
  what: string;
  quote: string;
  who?: string;
  due?: string; // YYYY-MM-DD or ISO
  lane?: string;
  privacy?: string; // shareable | other_private | ...
  destination: string; // from line/routing.md
  series?: string; // the meeting series the call belongs to (call-listener brief/meetings.md); agenda items need it
};

export const TASK_DESTINATIONS = new Set(["clickup.task", "clickup.reminder", "clickup.agenda"]);

/** "Raise next time" items are ClickUp tasks carrying the series tag; the brief for that series reads them. */
export function agendaTag(series: string): string {
  return `raise-${series.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export type Verdict = { take: true } | { take: false; why: string };

export function accept(i: CallItem): Verdict {
  if (i.privacy === "other_private") return { take: false, why: "private" };
  if (!TASK_DESTINATIONS.has(i.destination)) return { take: false, why: `destination ${i.destination}` };
  if (!i.what?.trim()) return { take: false, why: "empty" };
  if (i.destination === "clickup.agenda" && !i.series?.trim()) return { take: false, why: "agenda without series" };
  return { take: true };
}

/** The same promise said on two calls is one task: compare the words, not the session. */
export function sameness(what: string): string {
  return what.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A bare date is taken at noon UTC, so it lands on the same calendar day in any US zone. */
export function dueMs(due?: string): number | undefined {
  if (!due) return undefined;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(due) ? Date.parse(`${due}T12:00:00Z`) : Date.parse(due);
  return Number.isFinite(ms) ? ms : undefined;
}

export type TaskLists = { clickupListId: string; listName: string; byLane?: Array<{ lane: string; clickupListId: string; listName: string }> };

/** The list an item lands in: its lane's entity list, else the owner's default list. */
export function listFor(lists: TaskLists, lane?: string): { listId: string; listName: string } {
  const hit = lists.byLane?.find((l) => l.lane === lane);
  return hit ? { listId: hit.clickupListId, listName: hit.listName } : { listId: lists.clickupListId, listName: lists.listName };
}

export function description(i: CallItem, session: string): string {
  return [
    `> ${i.quote}`,
    "",
    `From ${session.startsWith("fireflies:") ? "meeting" : "call"} \`${session}\` (item ${i.id}${i.lane ? `, lane ${i.lane}` : ""}${i.who ? `, with ${i.who}` : ""}).`,
    `Proposed by ${session.startsWith("fireflies:") ? "the meeting recorder" : "the call line"}, approved in Hold the Room.`,
  ].join("\n");
}
