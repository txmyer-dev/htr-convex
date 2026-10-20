import { describe, expect, test } from "vitest";
import type { CalendarClaw } from "../convex/adapters/ports";
import { busyFor } from "../convex/lib/calendar/busy";

const W = { start: 1000, end: 9000 };

function claw(over: Partial<CalendarClaw> = {}): CalendarClaw {
  return {
    name: "fake",
    calendars: async () => [
      { id: "me@x.co", summary: "Me", primary: true },
      { id: "work@x.co", summary: "Work", primary: false },
    ],
    events: async () => [],
    freeBusy: async () => ({ busy: { "work@x.co": [{ start: 2000, end: 3000 }] }, errors: {} }),
    primaryBusy: async () => [{ start: 5000, end: 6000 }],
    get: async () => null,
    insert: async () => ({ exists: true }),
    move: async () => { throw new Error("not used"); },
    ...over,
  };
}

describe("busyFor", () => {
  test("leaves Google's generated calendars (holidays, birthdays) out of free/busy", async () => {
    let asked: string[] = [];
    const busy = await busyFor(claw({
      calendars: async () => [
        { id: "me@x.co", summary: "Me", primary: true },
        { id: "work@x.co", summary: "Work", primary: false },
        { id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays in United States", primary: false },
      ],
      freeBusy: async (_w, ids) => { asked = ids; return { busy: {}, errors: {} }; },
    }), W);
    expect(asked).toEqual(["work@x.co"]);
    expect(busy.unreadable).toBe(false);
  });

  test("joins the other calendars' free/busy with primary's events", async () => {
    expect(await busyFor(claw(), W)).toEqual({
      intervals: [{ start: 2000, end: 3000 }, { start: 5000, end: 6000 }],
      unreadable: false,
    });
  });

  test("asks primary to leave the card's own event out, and never sends primary to free/busy", async () => {
    let excluded: string | undefined;
    let asked: string[] = [];
    await busyFor(claw({
      primaryBusy: async (_w, id) => { excluded = id; return []; },
      freeBusy: async (_w, ids) => { asked = ids; return { busy: {}, errors: {} }; },
    }), W, "evt1");
    expect(excluded).toBe("evt1");
    expect(asked).toEqual(["work@x.co"]);
  });

  test("a calendar that errors makes the answer unreadable", async () => {
    const b = await busyFor(claw({ freeBusy: async () => ({ busy: {}, errors: { "work@x.co": "notFound" } }) }), W);
    expect(b.unreadable).toBe(true);
  });

  test("a failed read is unreadable, not free", async () => {
    const b = await busyFor(claw({ primaryBusy: async () => { throw new Error("500"); } }), W);
    expect(b).toEqual({ intervals: [], unreadable: true });
  });
});
