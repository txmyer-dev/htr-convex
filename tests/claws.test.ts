// The claw layer: per-tenant resolution with env fallback, a second tenant on config alone,
// dispatch by kind, and the heartbeat's change detection.
// STEALS: HTR tests "second tenant on config alone", "heartbeat pages the operator".

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { calendarClaw, llmClaw, mailClaw, notifyClaw, readerClaw, taskClaw } from "../convex/adapters/resolve";
import { changes } from "../convex/health";
import { TENANTS } from "../convex/install";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const ENV = ["HTR_NTFY_TOPIC", "HTR_NTFY_URL", "CLICKUP_API_TOKEN", "FIRECRAWL_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "AGENTMAIL_API_KEY", "BEN_NTFY_TOKEN", "BEN_OPENAI_KEY"];

function tenant(over: Partial<Doc<"tenants">> = {}): Doc<"tenants"> {
  return { _id: "t1" as Doc<"tenants">["_id"], _creationTime: 0, ...TENANTS[0], channels: { inboxId: "tony@agentmail.to" }, ...over } as Doc<"tenants">;
}

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("resolve", () => {
  test("nothing configured: optional claws are null, mail says what is missing", () => {
    const t = tenant();
    expect(taskClaw(t)).toBeNull();
    expect(notifyClaw(t)).toBeNull();
    expect(readerClaw(t)).toBeNull();
    expect(llmClaw(t)).toBeNull();
    expect(calendarClaw(t)).toBeNull(); // rides a Gmail grant; this tenant mails through AgentMail
    expect(() => mailClaw(t)).toThrow("AGENTMAIL_API_KEY");
  });

  test("deployment env alone configures every claw (one install, one tenant)", () => {
    Object.assign(process.env, { HTR_NTFY_TOPIC: "t", CLICKUP_API_TOKEN: "pk", FIRECRAWL_API_KEY: "fc", OPENAI_API_KEY: "sk", AGENTMAIL_API_KEY: "am" });
    const t = tenant();
    expect([mailClaw(t), taskClaw(t), notifyClaw(t), readerClaw(t), llmClaw(t)].map((c) => c?.name)).toEqual(["agentmail", "clickup", "ntfy", "firecrawl", "openai-compat"]);
  });

  test("the tenant's adapters block wins, and its secrets come from the env vars it names", async () => {
    process.env.HTR_NTFY_TOPIC = "tony-topic";
    process.env.BEN_NTFY_TOKEN = "ben-token";
    process.env.BEN_OPENAI_KEY = "ben-sk";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ben = tenant({
      adapters: {
        notify: { kind: "ntfy", topic: "ben-topic", url: "https://ntfy.ben.dev/", tokenEnv: "BEN_NTFY_TOKEN" },
        llm: { kind: "openai-compat", baseUrl: "llm.ben.dev", model: "grok-4", keyEnv: "BEN_OPENAI_KEY" },
      },
    });
    await notifyClaw(ben, f)!.push({ title: "x", message: "y" });
    expect(calls[0].url).toBe("https://ntfy.ben.dev");
    expect(JSON.parse(String(calls[0].init.body)).topic).toBe("ben-topic");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ben-token");
    expect(await llmClaw(ben, f)!.chat([{ role: "user", content: "hello" }])).toBe("hi");
    expect(calls[1].url).toBe("https://llm.ben.dev/v1/chat/completions");
    expect(JSON.parse(String(calls[1].init.body)).model).toBe("grok-4");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer ben-sk");
  });
});

describe("a second tenant on config alone", () => {
  test("each tenant's waiting items go to its own phone", async () => {
    process.env.HTR_RULING_SECRET = "test-secret";
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    process.env.HTR_NTFY_TOPIC = "tony-topic";
    const topics: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      topics.push(JSON.parse(String(init.body)).topic);
      return new Response("{}", { status: 200 });
    }));
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const tony = (await t.run((ctx) => ctx.db.query("tenants").first()))!;
    const { _id, _creationTime, ...fields } = tony;
    const benId = await t.run((ctx) => ctx.db.insert("tenants", {
      ...fields, slug: "ben", displayName: "Ben", owner: { ...fields.owner, email: "ben@example.com" },
      adapters: { notify: { kind: "ntfy", topic: "ben-topic" } },
    }));
    const item = { id: "i1", type: "my_commitment", what: "Send the deck", quote: "I'll send it.", lane: "wotai", privacy: "shareable", destination: "clickup.task" };
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tony._id, session: "s", items: [item] });
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: benId, session: "s", items: [item] });
    await t.action(internal.digest.run, { tenantId: tony._id });
    await t.action(internal.digest.run, { tenantId: benId });
    expect(topics).toEqual(["tony-topic", "ben-topic"]);
  });
});

describe("dispatch by kind", () => {
  test("an sms proposal fails loudly: no messaging claw can text yet", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const tenantId = (await t.run((ctx) => ctx.db.query("tenants").first()))!._id;
    const pid = await t.run((ctx) => ctx.db.insert("proposals", {
      tenantId, kind: "sms", toAddress: "+15550100", body: "On my way", basis: [], summary: "sms", status: "signed", edited: false, meta: {}, createdAt: Date.now(),
    }));
    await expect(t.action(internal.mail.dispatch, { proposalId: pid })).rejects.toThrow("no messaging claw");
    expect((await t.run((ctx) => ctx.db.get(pid)))!).toMatchObject({ status: "failed" });
  });
});

describe("the heartbeat", () => {
  test("only a change is news: first sight of a healthy claw is quiet, down and back up are pushed once", () => {
    const up = { port: "tasks", adapter: "clickup", ok: true };
    const down = { port: "tasks", adapter: "clickup", ok: false, error: "401" };
    expect(changes(new Map(), [up])).toEqual([]);
    expect(changes(new Map(), [down])).toEqual([{ ...down, was: null }]);
    expect(changes(new Map([["tasks", true]]), [down])).toEqual([{ ...down, was: true }]);
    expect(changes(new Map([["tasks", false]]), [down])).toEqual([]);
    expect(changes(new Map([["tasks", false]]), [up])).toEqual([{ ...up, was: false }]);
  });

  test("record keeps one row per claw and logs the change", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const tenantId = (await t.run((ctx) => ctx.db.query("tenants").first()))!._id;
    expect(await t.mutation(internal.health.record, { tenantId, results: [{ port: "llm", adapter: "openai-compat", ok: true }] })).toEqual([]);
    const c = await t.mutation(internal.health.record, { tenantId, results: [{ port: "llm", adapter: "openai-compat", ok: false, error: "model gateway 401" }] });
    expect(c.map((x) => [x.port, x.ok, x.was])).toEqual([["llm", false, true]]);
    expect(await t.run((ctx) => ctx.db.query("clawHealth").collect())).toHaveLength(1);
    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events.filter((e) => e.kind === "claw.down")).toHaveLength(1);
  });
});
