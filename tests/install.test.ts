// A self-hosted install's tenant (npm run setup -> install:create), what setup prints back
// (install:status), and the migrations runner npm run update calls.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const answers = {
  slug: "ben", displayName: "Hidalgo Co", timeZone: "America/Chicago",
  owner: { name: "Ben Hidalgo", email: "Ben@Gmail.com", digestAt: "07:30", quietHours: ["21:00", "08:00"] },
  business: { agentName: "Assistant" }, mail: "gmail" as const,
};

describe("install:create", () => {
  test("one tenant from setup's answers: Gmail as the mail claw, sane defaults", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.create, answers);
    const ten = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
    expect(ten).toMatchObject({
      slug: "ben", timeZone: "America/Chicago", adapters: { mail: { kind: "gmail" } }, channels: {},
      owner: { name: "Ben", names: ["Ben", "Ben Hidalgo"], email: "ben@gmail.com", digestAt: "07:30", defaultDeadlineDays: 2, discloseAssistant: true, autonomyTier: 0 },
    });
    expect(ten.tasks).toBeUndefined();
  });

  test("run again: the block updates, the Gmail grant stays; ClickUp can come and go", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.install.create, answers);
    await t.mutation(internal.gmail.saveGrant, { tenantId: id, address: "ben@gmail.com", refreshToken: "rt" });
    await t.mutation(internal.install.create, { ...answers, owner: { ...answers.owner, digestAt: "immediate" }, tasks: { clickupListId: "901", listName: "Tasks" } });
    let ten = (await t.run(async (ctx) => await ctx.db.get(id)))!;
    expect(ten.owner.digestAt).toBe("immediate");
    expect(ten.channels.gmail?.refreshToken).toBe("rt");
    expect(ten.tasks?.clickupListId).toBe("901");
    await t.mutation(internal.install.create, answers);
    ten = (await t.run(async (ctx) => await ctx.db.get(id)))!;
    expect(ten.tasks).toBeUndefined();
    expect(await t.run(async (ctx) => (await ctx.db.query("tenants").collect()).length)).toBe(1);
  });

  test("refuses a bad slug, digest time or zone", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.install.create, { ...answers, slug: "Ben Hidalgo" })).rejects.toThrow("slug");
    await expect(t.mutation(internal.install.create, { ...answers, owner: { ...answers.owner, digestAt: "7am" } })).rejects.toThrow("digestAt");
    await expect(t.mutation(internal.install.create, { ...answers, timeZone: "Mars/Olympus" })).rejects.toThrow();
  });
});

describe("install:status", () => {
  test("Gmail and the last beat, never the refresh token", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.install.create, answers);
    expect(await t.query(internal.install.status, { slug: "nobody" })).toBeNull();
    expect(await t.query(internal.install.status, { slug: "ben" })).toEqual({ gmail: null, claws: [] });
    await t.mutation(internal.gmail.saveGrant, { tenantId: id, address: "ben@gmail.com", refreshToken: "secret-rt" });
    await t.mutation(internal.health.record, { tenantId: id, results: [{ port: "mail", adapter: "gmail", ok: true }, { port: "llm", adapter: "openai-compat", ok: false, error: "401" }] });
    const s = await t.query(internal.install.status, { slug: "ben" });
    expect(s?.gmail?.address).toBe("ben@gmail.com");
    expect(s?.claws.map((c) => [c.port, c.ok, c.error])).toEqual([["llm", false, "401"], ["mail", true, null]]);
    expect(JSON.stringify(s)).not.toContain("secret-rt");
  });
});

describe("migrations:run", () => {
  test("nothing registered: runs nothing, twice", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.migrations.run, {})).toEqual([]);
    expect(await t.mutation(internal.migrations.run, {})).toEqual([]);
  });
});
