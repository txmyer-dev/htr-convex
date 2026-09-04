// STEALS: waggle waiting.test.ts via HTR tests/test_reader.py; deadline and time cases are new.
import { describe, expect, test } from "vitest";
import { findDeadline } from "../convex/lib/reader/deadline";
import { latestUnanswered, waitingOnMe, type Msg } from "../convex/lib/reader/waiting";
import { atLocalHour, hhmm, localDaysBetween, localParts, sameLocalDay } from "../convex/lib/time";

const msg = (id: string, sender: string, content: string, createdAt: number, extra: Partial<Msg> = {}): Msg => ({
  id, sender, content, createdAt, ...extra,
});

describe("waitingOnMe", () => {
  const me = { senderIds: new Set(["tony"]), names: ["Tony", "Tony Myers"] };

  test("mentions, replies to me, and questions wait until I answer", () => {
    const threads = [
      {
        channelId: "c1",
        channelName: "general",
        messages: [
          msg("a", "priya", "tony can you look at this?", 1),
          msg("b", "tony", "on it", 2, { replyTo: "a" }),
          msg("c", "sam", "does anyone have the deck?", 3),
          msg("d", "lee", "thanks all", 4),
          msg("e", "kim", "re your note", 5, { replyTo: "b" }),
        ],
      },
    ];
    const items = waitingOnMe(threads, me);
    expect(items.map((i) => [i.msg.id, i.reason])).toEqual([
      ["e", "reply-to-you"],
      ["c", "question"],
    ]);
    expect(items[0].channelName).toBe("general");
  });

  test("since and limit", () => {
    const threads = [{ channelId: "c", messages: [msg("1", "a", "why?", 1), msg("2", "b", "how?", 2), msg("3", "c", "when?", 3)] }];
    expect(waitingOnMe(threads, me, { since: 2 }).map((i) => i.msg.id)).toEqual(["3", "2"]);
    expect(waitingOnMe(threads, me, { limit: 1 }).map((i) => i.msg.id)).toEqual(["3"]);
  });

  test("short names never match", () => {
    const threads = [{ channelId: "c", messages: [msg("1", "a", "to do list", 1)] }];
    expect(waitingOnMe(threads, { senderIds: new Set(["me"]), names: ["To"] })).toEqual([]);
  });
});

describe("latestUnanswered", () => {
  test("the newest inbound waits unless something went out after it", () => {
    const inbound = [msg("1", "x", "hi", 1), msg("2", "x", "hello?", 3)];
    expect(latestUnanswered(inbound, [msg("o", "us", "hey", 2)])?.id).toBe("2");
    expect(latestUnanswered(inbound, [msg("o", "us", "hey", 4)])).toBeNull();
    expect(latestUnanswered([], [])).toBeNull();
  });
});

describe("findDeadline", () => {
  const thu = Date.UTC(2026, 8, 3, 15, 0); // Thu 2026-09-03 11:00 New York

  test("a named day means five o'clock local that day", () => {
    const d = findDeadline("I need it by Friday", thu, "America/New_York")!;
    expect(d.hint).toBe("Friday");
    expect(localParts(d.deadline, "America/New_York")).toMatchObject({ month: 9, day: 4, hour: 17, minute: 0 });
  });

  test("the same weekday means next week", () => {
    const d = findDeadline("Thursday works", thu, "America/New_York")!;
    expect(localParts(d.deadline, "America/New_York")).toMatchObject({ month: 9, day: 10 });
  });

  test("tomorrow and today", () => {
    expect(localParts(findDeadline("by tomorrow please", thu, "America/New_York")!.deadline, "America/New_York")).toMatchObject({ day: 4, hour: 17 });
    expect(localParts(findDeadline("need this today", thu, "America/New_York")!.deadline, "America/New_York")).toMatchObject({ day: 3, hour: 17 });
    expect(findDeadline("today", thu, "America/New_York")!.hint).toBe("today");
  });

  test("abbreviations", () => {
    expect(findDeadline("thurs at the latest", thu, "UTC")!.hint).toBe("Thursday");
    expect(findDeadline("no rush", thu, "UTC")).toBeNull();
  });
});

describe("time", () => {
  test("local parts respect the zone", () => {
    const t = Date.UTC(2026, 8, 3, 3, 30); // 03:30Z = Wed 23:30 New York
    expect(localParts(t, "America/New_York")).toMatchObject({ day: 2, hour: 23, minute: 30, weekday: 2, weekdayShort: "Wed" });
    expect(hhmm(t, "America/New_York")).toBe("23:30");
    expect(hhmm(t, "UTC")).toBe("03:30");
  });

  test("atLocalHour lands on the wall clock across a DST change", () => {
    const beforeFallBack = Date.UTC(2026, 9, 30, 12, 0); // Fri Oct 30 2026; clocks fall back Nov 1
    const target = atLocalHour(beforeFallBack, "America/New_York", 3, 17); // Mon Nov 2
    expect(localParts(target, "America/New_York")).toMatchObject({ month: 11, day: 2, hour: 17, minute: 0 });
  });

  test("day arithmetic", () => {
    const a = Date.UTC(2026, 8, 3, 23, 0); // 19:00 New York Sep 3
    const b = Date.UTC(2026, 8, 4, 3, 0); // 23:00 New York Sep 3
    expect(sameLocalDay(a, b, "America/New_York")).toBe(true);
    expect(sameLocalDay(a, b, "UTC")).toBe(false);
    expect(localDaysBetween(a, Date.UTC(2026, 8, 10, 12, 0), "America/New_York")).toBe(7);
  });
});
