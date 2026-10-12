// The owner's phone: one ntfy notification per waiting item, with the ruling links as buttons.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { notification, push } from "../convex/lib/notify/ntfy";

const modules = import.meta.glob("../convex/**/*.ts");
const cfg = { url: "https://ntfy.sh", topic: "htr-test" };
const links = { sign: "https://x/rulings/tony/p1/sign?t=a", reject: "https://x/rulings/tony/p1/reject?t=b", edit: "https://x/rulings/tony/p1/edit?t=c" };

describe("the notification", () => {
  test("a task: its list in the title, Add task and Skip rule in place, Edit opens", () => {
    const n = notification(cfg, { kind: "task", toName: "WotAI — tasks", toAddress: "clickup", body: "Post the call change", basis: ["I'll post it."] }, links, "https://x/r/tony?k=s");
    expect(n.title).toBe("Task → WotAI — tasks");
    expect(n.message).toBe("Post the call change\n\n“I'll post it.”");
    expect(n.click).toBe("https://x/r/tony?k=s");
    expect(n.actions).toEqual([
      { action: "http", label: "Add task", url: links.sign, method: "POST", clear: true },
      { action: "http", label: "Skip", url: links.reject, method: "POST", clear: true },
      { action: "view", label: "Edit", url: links.edit },
    ]);
  });

  test("a draft says Send and who it goes to", () => {
    const n = notification(cfg, { kind: "reply", toName: "", toAddress: "ann@x.com", body: "Yes, Tuesday works.", basis: [] }, links, "s");
    expect(n.title).toBe("Draft to ann@x.com");
    expect(n.actions[0].label).toBe("Send");
  });

  test("push posts JSON to the server root, with the token when there is one", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await push({ ...cfg, token: "tk" }, notification(cfg, { toAddress: "a", body: "b", basis: [] }, links, "s"), f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(JSON.parse(String(init.body)).topic).toBe("htr-test");
  });
});

describe("the digest run", () => {
  afterEach(() => {
    delete process.env.HTR_NTFY_TOPIC;
    vi.unstubAllGlobals();
  });

  test("pushes each waiting item once, and skips the email when there is no inbox", async () => {
    process.env.HTR_RULING_SECRET = "test-secret";
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    process.env.HTR_NTFY_TOPIC = "htr-test";
    const sent: Array<{ title: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const t = convexTest(schema, modules);
    await t.mutation(internal.install.applyInternal, {});
    const tenant = (await t.run(async (ctx) => await ctx.db.query("tenants").first()))!;
    const item = { id: "i1", type: "my_commitment", what: "Post the call change", quote: "I'll post it.", lane: "wotai", privacy: "shareable", destination: "clickup.task" };
    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "s", items: [item] });

    await t.action(internal.digest.run, { tenantId: tenant._id });
    expect(sent.map((s) => s.title)).toEqual(["Task → WotAI — tasks"]);

    await t.mutation(internal.tasks.receiveCallItems, { tenantId: tenant._id, session: "s", items: [{ ...item, id: "i2", what: "Message Alex" }] });
    await t.action(internal.digest.run, { tenantId: tenant._id });
    expect(sent.map((s) => s.title)).toEqual(["Task → WotAI — tasks", "Task → WotAI — tasks"]);
    expect(sent).toHaveLength(2); // the first item was not pushed again
  });
});
