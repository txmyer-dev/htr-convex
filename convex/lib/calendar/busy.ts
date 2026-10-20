// The owner's busy time across every calendar they see, for the clean check and the slot finder
// (KTD5, KTD7). Free/busy carries no event ids, so `primary` is read as events instead: that lets a
// card leave out its own event (a retry) or the one it moves. A calendar that fails to read makes
// the whole answer unreadable, never free.

import type { CalendarClaw } from "../../adapters/ports";
import type { Busy, Interval } from "./availability";
import { isGoogleGenerated, type FreeBusy } from "./google";

export async function busyFor(claw: CalendarClaw, window: Interval, excludeEventId?: string): Promise<Busy> {
  try {
    const others = (await claw.calendars()).filter((c) => !c.primary && !isGoogleGenerated(c.id)).map((c) => c.id);
    const [fb, primary] = await Promise.all([
      others.length ? claw.freeBusy(window, others) : Promise.resolve<FreeBusy>({ busy: {}, errors: {} }),
      claw.primaryBusy(window, excludeEventId),
    ]);
    const intervals = [...Object.values(fb.busy).flat(), ...primary];
    return { intervals, unreadable: Object.keys(fb.errors).length > 0 };
  } catch {
    return { intervals: [], unreadable: true };
  }
}
