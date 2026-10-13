// Data changes that ship with code. `npm run update` runs `migrations:run` after every deploy:
// each entry runs once per deployment, in order, and is recorded. Add to the end; never reorder
// or remove an entry that has shipped. An entry must be safe to run on an empty install.

import { internalMutation, type MutationCtx } from "./_generated/server";

type Migration = { name: string; up: (ctx: MutationCtx) => Promise<void> };

export const MIGRATIONS: Migration[] = [];

export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const ran: string[] = [];
    for (const m of MIGRATIONS) {
      if (await ctx.db.query("migrations").withIndex("by_name", (q) => q.eq("name", m.name)).unique()) continue;
      await m.up(ctx);
      await ctx.db.insert("migrations", { name: m.name, at: Date.now() });
      ran.push(m.name);
    }
    return ran;
  },
});
