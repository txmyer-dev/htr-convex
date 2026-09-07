// Reading a ruling off a reply (STEALS: waggle src/rulings/parse.ts; the numbered form,
// word marks and the four commands from HTR src/htr/rulings/parse.py).
//
// Deliberately narrow: a mark signs or rejects, anything else is the words to send instead.
// A digest numbers the drafts, so each line of a reply starts with the number it rules on.
//
//     1            sign draft 1
//     1 ✅ / yes   sign draft 1
//     2 no / ❌    reject draft 2
//     3 tell them Tuesday works      replace draft 3's body with those words, then sign
//     all          sign every draft in the digest
//     later        leave everything pending until the next digest
//     hold [until 9]   hold the room
//     ?            send the digest now
//     remember we open at 9 on Saturdays    teach the room a fact, outside any draft

export type Verdict = { kind: "sign" } | { kind: "reject" } | { kind: "edit"; body: string };

export type Command = "all" | "later" | "hold" | "digest" | "remember";

export type ParsedReply = {
  rulings: Array<{ n: number; verdict: Verdict }>;
  commands: Array<{ command: Command; arg: string | null }>;
  unparsed: string[];
};

export const SIGN_MARKS = new Set([
  "✅", "✔", "☑", "👍", "+", ":white_check_mark:", ":heavy_check_mark:", ":ballot_box_with_check:",
]);
export const REJECT_MARKS = new Set([
  "❌", "✖", "🚫", "⛔", "👎", "-", ":x:", ":heavy_multiplication_x:", ":no_entry_sign:", ":no_entry:",
]);
export const SIGN_WORDS = new Set([
  "yes", "y", "ok", "okay", "send", "send it", "go", "approve", "approved", "sign", "yep", "yup", "sure",
]);
export const REJECT_WORDS = new Set([
  "no", "n", "skip", "nope", "reject", "drop", "don't", "dont", "no thanks", "cancel",
]);

// U+FE0E / U+FE0F: the text and emoji variation selectors.
const VARIATION = /[︎️]/g;
const NUMBERED = /^#?(\d{1,3})\s*[.:)\-–]?\s*([\s\S]*)$/;
const HOLD = /^hold(?:\s+(?:until|till|til|to)\s+(.+))?$/i;
const ALL = new Set(["all", "yes all", "send all", "all yes", "✅ all", "all ✅"]);
const LATER = new Set(["later", "not now", "tomorrow"]);
const REMEMBER = /^(?:remember|learn|note)(?:\s*:\s*|\s+)(.+)$/i;
const DIGEST = new Set(["?", "digest", "status", "what's waiting", "whats waiting", "list"]);

/** Strip variation selectors and whitespace so "✔️" and "✔" agree. */
export function normalize(text: string): string {
  return text.replace(VARIATION, "").trim();
}

function trimPunct(s: string): string {
  return s.replace(/[.!]+$/, "");
}

export function verdictFromMark(text: string): Verdict | null {
  const c = normalize(text);
  const low = trimPunct(c.toLowerCase());
  if (SIGN_MARKS.has(c) || SIGN_WORDS.has(low)) return { kind: "sign" };
  if (REJECT_MARKS.has(c) || REJECT_WORDS.has(low)) return { kind: "reject" };
  return null;
}

/** A bare mark means what the mark means; any other text is "send this instead". */
export function verdictFromReply(text: string): Verdict | null {
  const asMark = verdictFromMark(text);
  if (asMark) return asMark;
  const t = text.trim();
  return t ? { kind: "edit", body: t } : null;
}

export function parseReply(text: string): ParsedReply {
  const out: ParsedReply = { rulings: [], commands: [], unparsed: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const low = trimPunct(normalize(line).toLowerCase());
    const m = NUMBERED.exec(line);
    if (m) {
      const n = parseInt(m[1], 10);
      const rest = m[2].trim();
      const verdict = rest ? verdictFromReply(rest) : ({ kind: "sign" } as Verdict);
      if (verdict) out.rulings.push({ n, verdict });
      continue;
    }
    if (ALL.has(low)) out.commands.push({ command: "all", arg: null });
    else if (LATER.has(low)) out.commands.push({ command: "later", arg: null });
    else if (HOLD.test(low)) {
      const arg = (HOLD.exec(low)?.[1] ?? "").trim();
      out.commands.push({ command: "hold", arg: arg || null });
    } else if (DIGEST.has(low)) out.commands.push({ command: "digest", arg: null });
    else if (REMEMBER.test(line)) out.commands.push({ command: "remember", arg: REMEMBER.exec(line)![1].trim() });
    else out.unparsed.push(line);
  }
  return out;
}

export function isEmpty(p: ParsedReply): boolean {
  return p.rulings.length === 0 && p.commands.length === 0;
}

/**
 * An email reply carries the quoted digest below the owner's words. Everything from the first
 * quote marker down is the machine's own text coming back, not a ruling. The markers are the
 * ones mail clients actually write: ">" lines and "On ... wrote:" (Gmail, Apple Mail; Gmail
 * wraps the attribution over two lines, "On ...\nwrote:", so a bare "wrote:" line counts too),
 * "-----Original Message-----", and the "____" rule with a "From:" header block (Outlook, which
 * quotes without ">" marks). Without the cut, the digest's own numbered lines read as rulings.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  let cut = lines.findIndex((l) => {
    const t = l.trim();
    return (
      t.startsWith(">") ||
      /^On .+ wrote:$/.test(t) ||
      /^wrote:$/.test(t) ||
      /^-{2,}\s*Original Message/i.test(t) ||
      /^_{4,}$/.test(t) ||
      /^From:\s.+@/.test(t)
    );
  });
  if (cut !== -1 && /^wrote:$/.test(lines[cut].trim())) {
    // The wrapped attribution: the "On ..." line is one or two lines up.
    for (let i = cut - 1; i >= Math.max(0, cut - 2); i--) {
      if (/^On .+/.test(lines[i].trim())) { cut = i; break; }
    }
  }
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}
