// The clock. Hourly: overdue drafts stop waiting. Every minute: any tenant whose digest hour
// is now gets one (immediate-mode tenants are served by the debounced scheduler instead).

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { hhmm } from "./lib/time";

export const digestClock = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const t of await ctx.db.query("tenants").collect()) {
      if (t.owner.digestAt === "immediate" || t.owner.digestAt !== hhmm(now, t.timeZone)) continue;
      const last = await ctx.db.query("digests").withIndex("by_tenant_sent", (q) => q.eq("tenantId", t._id)).order("desc").first();
      if (last && now - last.sentAt < 120_000) continue; // this minute already fired
      await ctx.scheduler.runAfter(0, internal.digest.run, { tenantId: t._id });
    }
  },
});

const crons = cronJobs();
crons.hourly("expire overdue drafts", { minuteUTC: 7 }, internal.rulings.expireAll, {});
crons.interval("digest clock", { minutes: 1 }, internal.crons.digestClock, {});
export default crons;
