// What happened to one request, in order, in words: the events that name it and the rulings on
// it, merged by time. The surface shows it under every ruled item ("what did it actually do?").
// Pure: the query hands over the rows, this decides what each one says.

// `_creationTime` orders the two tables into one story: it is unique and increasing where `at` can tie.
export type TimelineEvent = { kind: string; payload: unknown; at: number; _creationTime: number };
export type TimelineRuling = { from: string; verdict: string; at: number; _creationTime: number };
export type Tone = "ok" | "wait" | "bad";
/** `at` is absent on the last line when it says where the request is now, not something that happened. */
export type Step = { at?: number; text: string; tone: Tone };

type P = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** How the owner's ruling arrived: a reply from their address, a signed link, the live page, or the clock. */
export function via(from: string): string {
  if (from === "link") return "by the link in the digest";
  if (from === "surface") return "on this page";
  if (from === "clock") return "by the clock";
  return "by email reply";
}

/** The first line of what the web agent wrote, cut short: its verdict is the contract (lib/site/publish.ts). */
function firstLine(text: string | undefined, max = 140): string {
  const line = (text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function describeEvent(kind: string, payload: unknown, site: boolean): Omit<Step, "at"> | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as P;
  switch (kind) {
    case "proposal.created":
      if (site) return { text: "Request drafted for your website's agent, from what you taught it", tone: "ok" };
      if (p.source === "relist") return { text: "Re-listed after it expired", tone: "ok" };
      return { text: "Drafted from their message", tone: "ok" };
    case "proposal.sent":
      if (site) return { text: "Sent to your website's agent, signed, with you copied", tone: "ok" };
      return { text: p.edited ? "Sent in their thread, in your words" : "Sent in their thread", tone: "ok" };
    case "proposal.send_failed":
      // The row above already shows the whole error; the story needs only its start.
      return { text: `Sending failed: ${firstLine(str(p.error), 120) || "no reason given"}`, tone: "bad" };
    case "fact.learned":
      return { text: "Learned from your words: later drafts use it", tone: "ok" };
    case "site.acknowledged": {
      const said = firstLine(str(p.text));
      const ok = p.verdict !== "failed";
      return { text: `The agent replied: “${said || (ok ? "Live." : "Not live.")}”`, tone: ok ? "ok" : "bad" };
    }
    case "site.failed":
      return { text: "Failed: the agent changed nothing", tone: "bad" };
    case "site.not_yet":
      return p.last
        ? { text: "Read the site: still not there", tone: "bad" }
        : { text: `Read the site${typeof p.pages === "number" ? ` (${p.pages} ${p.pages === 1 ? "page" : "pages"})` : ""}: not there yet`, tone: "wait" };
    case "site.unseen":
      return { text: "Failed: the agent said live, but the site never showed it", tone: "bad" };
    case "site.live":
      return { text: `Read the site: it's there${str(p.url) ? ` (${str(p.url)})` : ""}. Live.`, tone: "ok" };
    case "site.recheck":
      return { text: "You asked to read the site again", tone: "ok" };
    case "site.resent":
      return { text: "You asked again: sent afresh in a new thread", tone: "ok" };
    // Said already by another row: the proposal's creation, and the clock's ruling.
    case "site.proposed":
    case "proposal.expired":
      return null;
    default:
      return { text: kind, tone: "ok" };
  }
}

export function describeRuling(r: TimelineRuling): Omit<Step, "at"> | null {
  switch (r.verdict) {
    case "sign":
      return { text: `Signed by you, ${via(r.from)}`, tone: "ok" };
    case "edit":
      return { text: `Signed in your own words, ${via(r.from)}`, tone: "ok" };
    case "reject":
      return { text: `Skipped by you, ${via(r.from)}`, tone: "bad" };
    case "expired":
      return { text: "Expired with no ruling: they were told a reply is coming", tone: "bad" };
    default:
      return null; // ignored replies and commands are not steps of this request
  }
}

/** Where a request that is still on its way is now: the line after the last step. */
function pending(status: string, site: boolean, last: TimelineEvent | undefined): Omit<Step, "at"> | null {
  if (status === "pending") return { text: "Waiting on your ruling", tone: "wait" };
  if (status === "signed" || status === "sending") return { text: "Going out", tone: "wait" };
  if (status !== "sent" || !site) return null;
  const reading = last && (last.kind === "site.recheck" || (last.kind === "site.acknowledged" && (last.payload as P)?.verdict !== "failed") || last.kind === "site.not_yet");
  return reading ? { text: "Reading the site again shortly", tone: "wait" } : { text: "Waiting for the agent's reply", tone: "wait" };
}

export function buildTimeline(
  proposal: { kind: string; status: string },
  events: TimelineEvent[],
  rulings: TimelineRuling[],
): Step[] {
  const site = proposal.kind === "site";
  const rows = [
    ...events.map((e) => ({ at: e.at, seq: e._creationTime, step: describeEvent(e.kind, e.payload, site) })),
    ...rulings.map((r) => ({ at: r.at, seq: r._creationTime, step: describeRuling(r) })),
  ];
  const steps: Step[] = rows
    .filter((r) => r.step)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ at: r.at, ...r.step! }));
  const last = events.reduce<TimelineEvent | undefined>((a, e) => (!a || e._creationTime > a._creationTime ? e : a), undefined);
  const tail = pending(proposal.status, site, last);
  if (tail) steps.push(tail);
  return steps;
}
