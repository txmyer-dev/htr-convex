import { describe, expect, test } from "vitest";
import { buildTimeline, describeEvent, via } from "../convex/lib/proposals/timeline";

let seq = 0;
const ev = (kind: string, payload: unknown = {}, at = 1000 + seq) => ({ kind, payload, at, _creationTime: ++seq });
const ru = (verdict: string, from: string, at = 1000 + seq) => ({ verdict, from, at, _creationTime: ++seq });
const texts = (steps: { text: string }[]) => steps.map((s) => s.text);

describe("a request's timeline", () => {
  test("a site request that went live, in order, the ruling between the draft and the send", () => {
    const events = [ev("proposal.created", { source: "fact" }), ev("site.proposed")];
    const rulings = [ru("sign", "owner@example.com")];
    events.push(
      ev("proposal.sent", { kind: "site" }),
      ev("site.acknowledged", { verdict: "live", text: "Live. Added under Practical.\n\nhttps://felaniam.cloud" }),
      ev("site.not_yet", { pages: 4, last: false }),
      ev("site.live", { url: "https://felaniam.cloud/visit" }),
    );
    const steps = buildTimeline({ kind: "site", status: "live" }, events, rulings);
    expect(texts(steps)).toEqual([
      "Request drafted for your website's agent, from what you taught it",
      "Signed by you, by email reply",
      "Sent to your website's agent, signed, with you copied",
      "The agent replied: “Live. Added under Practical.”",
      "Read the site (4 pages): not there yet",
      "Read the site: it's there (https://felaniam.cloud/visit). Live.",
    ]);
    expect(steps.map((s) => s.tone)).toEqual(["ok", "ok", "ok", "ok", "wait", "ok"]);
    expect(steps.every((s) => typeof s.at === "number")).toBe(true); // nothing still on its way
  });

  test("the agent's Not live is the reason, and it is bad news", () => {
    const steps = buildTimeline(
      { kind: "site", status: "failed" },
      [ev("site.acknowledged", { verdict: "failed", text: "Not live. find is not unique. Nothing was changed." }), ev("site.failed", { reason: "find is not unique" })],
      [],
    );
    expect(steps).toMatchObject([
      { text: "The agent replied: “Not live. find is not unique. Nothing was changed.”", tone: "bad" },
      { text: "Failed: the agent changed nothing", tone: "bad" },
    ]);
  });

  test("a request on its way ends with where it is now, and that line has no time", () => {
    const sent = [ev("proposal.sent")];
    expect(buildTimeline({ kind: "site", status: "sent" }, sent, []).at(-1)).toEqual({ text: "Waiting for the agent's reply", tone: "wait" });
    const acked = [...sent, ev("site.acknowledged", { verdict: "live", text: "Live." })];
    expect(buildTimeline({ kind: "site", status: "sent" }, acked, []).at(-1)).toEqual({ text: "Reading the site again shortly", tone: "wait" });
    expect(buildTimeline({ kind: "email", status: "pending" }, [ev("proposal.created")], []).at(-1)).toEqual({ text: "Waiting on your ruling", tone: "wait" });
    expect(buildTimeline({ kind: "email", status: "sent" }, sent, []).at(-1)?.at).toBeDefined(); // a sent email is done
  });

  test("an email: drafted, edited by link, learned from, sent in their words", () => {
    const steps = buildTimeline(
      { kind: "email", status: "sent" },
      [ev("proposal.created", { source: "email" })],
      [ru("edit", "link")],
    );
    const more = buildTimeline(
      { kind: "email", status: "sent" },
      [ev("proposal.created", { source: "email" }), ev("fact.learned"), ev("proposal.sent", { edited: true })],
      [],
    );
    expect(texts(steps)).toEqual(["Drafted from their message", "Signed in your own words, by the link in the digest"]);
    expect(texts(more).slice(1)).toEqual(["Learned from your words: later drafts use it", "Sent in their thread, in your words"]);
  });

  test("ignored replies, commands, and rows another row already says are not steps", () => {
    const steps = buildTimeline(
      { kind: "email", status: "expired" },
      [ev("proposal.created"), ev("proposal.expired")],
      [ru("ignored", "owner@example.com"), ru("expired", "clock")],
    );
    expect(texts(steps)).toEqual(["Drafted from their message", "Expired with no ruling: they were told a reply is coming"]);
  });

  test("how a ruling arrived, and a kind nobody named yet is still shown", () => {
    expect(via("surface")).toBe("on this page");
    expect(via("link")).toBe("by the link in the digest");
    expect(via("owner@example.com")).toBe("by email reply");
    expect(describeEvent("proposal.send_failed", { error: "AgentMail POST -> 404: " + "y".repeat(400) }, false)!.text.length).toBe("Sending failed: ".length + 120);
    expect(describeEvent("site.not_yet", { pages: 1 }, true)!.text).toBe("Read the site (1 page): not there yet");
    expect(describeEvent("site.brand_new", {}, true)).toEqual({ text: "site.brand_new", tone: "ok" });
    expect(describeEvent("site.acknowledged", { verdict: "live", text: "x".repeat(300) }, true)!.text).toMatch(/^The agent replied: “x{139}…”$/); // the first line, cut at 140
  });
});
