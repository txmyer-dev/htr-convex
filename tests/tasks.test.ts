// The call line's follow-ups through the funnel: items in, ruled, written to ClickUp, read back.
// Offline like the rest: ClickUp is a stubbed fetch, scheduled actions are inspected, not run.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { createTask, getTask } from "../convex/lib/tasks/clickup";
import { accept, dueMs, sameness, type CallItem } from "../convex/lib/tasks/intake";
import { surfaceKey } from "../convex/surface";
import { intakeKey } from "../convex/tasks";

const modules = import.meta.glob("../convex/**/*.ts");

function item(over: Partial<CallItem> = {}): CallItem {
  return {
    id: "i263", type: "my_commitment", what: "Message Alex Kim on Discord", quote: "I'll ping you on Discord after this.",
    who: "Alex Kim", due: "2026-10-10", lane: "wotai", privacy: "shareable", destination: "clickup.reminder", ...over,
  };
}

async function setup() {
  process.env.HTR_RULING_SECRET = "test-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  const t = convexTest(schema, modules);
  await t.mutation(internal.install.applyInternal, {});
  const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
  return { t, tenant };
}

const tasks = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.run(async (ctx) => (await ctx.db.query("proposals").collect()).filter((p) => p.kind === "task"));

describe("what the line may hand in", () => {
  test("only items routed to the task list, never anything private to someone else", () => {
    expect(accept(item())).toEqual({ take: true });
    expect(accept(item({ destination: "clickup.task" }))).toEqual({ take: true });
    expect(accept(item({ privacy: "other_private" }))).toEqual({ take: false, why: "private" });
    expect(accept(item({ destination: "local" }))).toMatchObject({ take: false });
    expect(accept(item({ destination: "proposal" }))).toMatchObject({ take: false });
    expect(accept(item({ what: "  " }))).toMatchObject({ take: false, why: "empty" });
  });

  test("the same promise in other words of punctuation and case is the same", () => {
    expect(sameness("Message Alex Kim on Discord!")).toBe(sameness("message alex kim   on discord"));
    expect(sameness("Post in WotAI")).not.toBe(sameness("Post in Skool"));
  });

  test("a bare due date keeps its calendar day", () => {
    expect(new Date(dueMs("2026-10-12")!).toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(dueMs(undefined)).toBeUndefined();
    expect(dueMs("someday")).toBeUndefined();
  });
});

describe("intake", () => {
  test("items become pending task proposals; a replay adds nothing; refusals are counted", async () => {
    const { t, tenant } = await setup();
    const args = {
      tenantId: tenant._id, session: "20261009-wotai-ff",
      items: [item(), item({ id: "i33", what: "Post the call-format change in the community", destination: "clickup.task", due: undefined }),
        item({ id: "i125", privacy: "other_private", what: "Alyx's situation" }), item({ id: "i9", destination: "none", what: "joke" })],
    };
    expect(await t.mutation(internal.tasks.receiveCallItems, args)).toEqual({ proposed: 2, already: 0, duplicate: 0, refused: { private: 1, "destination none": 1 } });
    expect(await t.mutation(internal.tasks.receiveCallItems, args)).toMatchObject({ proposed: 0, already: 2 });
    const rows = await tasks(t);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "pending", toName: "Tony – Tasks", body: "Message Alex Kim on Discord", sourceKind: "call_item", sourceId: "20261009-wotai-ff:i263" });
    expect(rows[0].summary).toBe("Task: “Message Alex Kim on Discord”");
    expect(rows[0].basis).toEqual(["I'll ping you on Discord after this."]);
    expect(rows.map((r) => r.body)).not.toContain("Alyx's situation");
  });

  test("the same promise from a later call, while the first is still open, is not proposed twice", async () => {
    const { t, tenant } = await setup();
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "a", items: [item()] });
    const out = await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "b", items: [item({ id: "i40", what: "message Alex Kim on Discord." })] });
    expect(out).toMatchObject({ proposed: 0, duplicate: 1 });
    expect(await tasks(t)).toHaveLength(1);
  });

  test("a promise whose earlier task is done is a new task", async () => {
    const { t, tenant } = await setup();
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "a", items: [item()] });
    const [first] = await tasks(t);
    await t.run((ctx) => ctx.db.patch(first._id, { status: "live" }));
    expect(await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "b", items: [item({ id: "i40" })] })).toMatchObject({ proposed: 1 });
  });
});

describe("ruled, written, read back", () => {
  test("Send on the surface signs the task and schedules the executor; done in ClickUp makes it live", async () => {
    const { t, tenant } = await setup();
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "s1", items: [item()] });
    const [p] = await tasks(t);
    const key = await surfaceKey(tenant.slug);
    await t.mutation(api.rulings.ruleFromSurface, { slug: tenant.slug, key, proposalId: p._id, verdict: "sign" });
    expect((await t.run((ctx) => ctx.db.get(p._id)))!.status).toBe("signed");
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((j) => j.name.includes("dispatch"))).toBe(true);

    // what dispatch does after ClickUp answers
    await t.mutation(internal.proposals.claimForSend, { proposalId: p._id });
    await t.mutation(internal.proposals.finishSend, { proposalId: p._id, ref: "86abc" });
    await t.mutation(internal.tasks.noteTask, { proposalId: p._id, url: "https://app.clickup.com/t/86abc", status: "to do", done: false });
    const sent = (await t.run((ctx) => ctx.db.get(p._id)))!;
    expect(sent).toMatchObject({ status: "sent", sentRef: "86abc" });
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0); // a task is not a message

    expect(await t.query(internal.tasks.openTasks, {})).toEqual([{ proposalId: p._id, ref: "86abc" }]);
    await t.mutation(internal.tasks.noteTask, { proposalId: p._id, url: "https://app.clickup.com/t/86abc", status: "complete", done: true });
    const states = await t.query(internal.tasks.callItemStates, { tenantId: tenant._id });
    expect(states).toEqual([expect.objectContaining({ session: "s1", itemId: "i263", status: "live", task: { url: "https://app.clickup.com/t/86abc", status: "complete", done: true } })]);
    expect(await t.query(internal.tasks.openTasks, {})).toEqual([]);
  });
});

describe("the ClickUp wire", () => {
  test("create posts to the list with the token and the due date; read maps done and closed to done", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const status = url.includes("/task/9") ? { status: "complete", type: "closed" } : { status: "to do", type: "open" };
      return new Response(JSON.stringify({ id: "9", url: "https://app.clickup.com/t/9", status }), { status: 200 });
    }) as typeof fetch;
    const made = await createTask("pk_x", "901421901184", { name: "Do it", description: "> quote", dueMs: 1_800_000_000_000 }, f);
    expect(made).toEqual({ id: "9", url: "https://app.clickup.com/t/9", status: "to do", done: false });
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/901421901184/task");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("pk_x");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ name: "Do it", due_date: 1_800_000_000_000 });
    expect((await getTask("pk_x", "9", f)).done).toBe(true);
  });

  test("a ClickUp error surfaces with its status", async () => {
    const f = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(getTask("bad", "9", f)).rejects.toThrow(/401/);
  });
});

describe("the intake endpoint", () => {
  test("needs the intake key, not the surface key; hands items in and reads them back", async () => {
    const { t, tenant } = await setup();
    const url = `/intake/${tenant.slug}/call-items`;
    const post = (key: string) => t.fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ session: "s1", items: [item()] }) });
    expect((await post("nope")).status).toBe(401);
    expect((await post(await surfaceKey(tenant.slug))).status).toBe(401);
    const ok = await post(await intakeKey(tenant.slug));
    expect(await ok.json()).toMatchObject({ proposed: 1 });
    const back = await t.fetch(`${url}?session=s1`, { headers: { authorization: `Bearer ${await intakeKey(tenant.slug)}` } });
    expect(await back.json()).toEqual([expect.objectContaining({ itemId: "i263", status: "pending" })]);
  });
});
