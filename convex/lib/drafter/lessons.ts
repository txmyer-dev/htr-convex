// The owner's corrections, as lessons for the drafter.
//
// An edit ruling is the owner saying "not that, this": the draft the machine wrote and the words
// that actually went out. Nothing is asked of the owner after that. The next draft for this
// tenant sees the last few pairs and is told to match the owner's words, not the earlier drafts.
// Edits only: a skip says "not this" without saying what instead, and is not a lesson.
// Per tenant only: the caller reads rulings by tenant; nothing here crosses that line.

export type Lesson = {
  theirMessage: string; // what the counterparty said (the basis quotes the draft rested on)
  draft: string; // what the machine proposed
  sent: string; // what the owner sent instead
};

export const MAX_LESSONS = 5;
export const MAX_CHARS = 500;

const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);

/**
 * Rows newest first, already filtered to edit rulings by the caller. Drops pairs with nothing
 * to learn from (an empty side, or words that only differ by whitespace), clips each side, and
 * keeps at most `max`, newest first.
 */
export function toLessons(rows: Array<{ theirMessage?: string; draft?: string; sent?: string }>, max = MAX_LESSONS): Lesson[] {
  const out: Lesson[] = [];
  for (const r of rows) {
    const draft = squash(r.draft);
    const sent = squash(r.sent);
    if (!draft || !sent || draft === sent) continue;
    out.push({ theirMessage: clip(squash(r.theirMessage)), draft: clip(draft), sent: clip(sent) });
    if (out.length >= max) break;
  }
  return out;
}
