// tenants:setTasks repoints one tenant's task lists and leaves the rest of the tenant alone.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

describe("setTasks", () => {
  test("replaces the task lists and nothing else", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const before = (await t.run(async (ctx) => ctx.db.query("tenants").first()))!;
    const tasks = { clickupListId: "1", listName: "00 Inbox", teamId: "9", byLane: [{ lane: "wotai", clickupListId: "2", listName: "WotAI – Actions" }] };
    await t.mutation(internal.tenants.setTasks, { slug: before.slug, tasks });
    const after = (await t.run(async (ctx) => ctx.db.get(before._id)))!;
    expect(after.tasks).toEqual(tasks);
    expect({ ...after, tasks: before.tasks }).toEqual(before);
  });

  test("an unknown slug is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.tenants.setTasks, { slug: "nobody", tasks: { clickupListId: "1", listName: "x", teamId: "9" } })).rejects.toThrow("unknown tenant nobody");
  });
});
