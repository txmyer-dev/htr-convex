// The ClickUp executor's wire (API v2). The only code that holds the ClickUp token; the spine
// proposes, the owner rules, this writes one task and reads its status back. Plain fetch, so it
// runs in a Convex action and in tests with a stubbed fetch.

const API = "https://api.clickup.com/api/v2";

export type NewTask = { name: string; description: string; dueMs?: number };
export type TaskState = { id: string; url: string; status: string; done: boolean };

type Fetch = typeof fetch;

async function call(f: Fetch, token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await f(`${API}${path}`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** ClickUp status types: open, custom, done, closed. Done and closed both mean the loop is shut. */
export function stateOf(task: any): TaskState {
  const type = String(task?.status?.type ?? "");
  return { id: String(task.id), url: String(task.url ?? ""), status: String(task?.status?.status ?? ""), done: type === "done" || type === "closed" };
}

export async function createTask(token: string, listId: string, t: NewTask, f: Fetch = fetch): Promise<TaskState> {
  const body: Record<string, unknown> = { name: t.name, markdown_description: t.description };
  if (t.dueMs) Object.assign(body, { due_date: t.dueMs, due_date_time: true });
  return stateOf(await call(f, token, `/list/${encodeURIComponent(listId)}/task`, { method: "POST", body: JSON.stringify(body) }));
}

export async function getTask(token: string, id: string, f: Fetch = fetch): Promise<TaskState> {
  return stateOf(await call(f, token, `/task/${encodeURIComponent(id)}`));
}
