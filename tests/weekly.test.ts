// The weekly digest is the last call: what it lists and is still waiting a week later is dropped.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const item = (id: string, what: string) =>
  ({ id, type: "my_commitment", what, quote: "q", lane: "wotai", privacy: "shareable", destination: "clickup.task" });

describe("the weekly last call", () => {
  test("a weekly build marks its items; the next one drops those still waiting and lists the new", async () => {
    process.env.HTR_RULING_SECRET = "test-secret";
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "s", items: [item("a", "old one")] });

    const first = await t.mutation(internal.digest.build, { tenantId: tenant._id, weekly: true });
    expect(first!.items).toHaveLength(1);

    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "s", items: [item("b", "new one")] });
    const immediate = await t.mutation(internal.digest.build, { tenantId: tenant._id });
    expect(immediate!.items).toHaveLength(2); // a daily build drops nothing

    const second = await t.mutation(internal.digest.build, { tenantId: tenant._id, weekly: true });
    expect(second!.items.map((i) => i.item.body)).toEqual(["new one"]);
    const rows = await t.run((ctx) => ctx.db.query("proposals").collect());
    expect(Object.fromEntries(rows.map((p) => [p.body, p.status]))).toEqual({ "old one": "expired", "new one": "pending" });
  });
});
