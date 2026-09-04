// AgentMail over fetch. Four calls, no SDK: the official client pulls in an optional payment
// dependency the Convex bundler cannot resolve, and the REST surface is small.
//   https://docs.agentmail.to/api-reference

export type SendResult = { messageId: string; threadId: string };

export class AgentMail {
  constructor(
    private readonly apiKey: string,
    private readonly base = "https://api.agentmail.to/v0",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AgentMail ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** A new message out of an inbox. */
  async send(inboxId: string, m: { to: string[]; subject: string; text: string; html?: string; cc?: string[] }): Promise<SendResult> {
    const r = await this.call<{ message_id: string; thread_id: string }>("POST", `/inboxes/${enc(inboxId)}/messages/send`, {
      to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html,
    });
    return { messageId: r.message_id, threadId: r.thread_id };
  }

  /** A reply in the thread of `messageId` (an AgentMail message id); headers and subject follow. */
  async reply(inboxId: string, messageId: string, m: { text: string; html?: string; to?: string[]; replyAll?: boolean }): Promise<SendResult> {
    const r = await this.call<{ message_id: string; thread_id: string }>(
      "POST",
      `/inboxes/${enc(inboxId)}/messages/${enc(messageId)}/reply`,
      { text: m.text, html: m.html, to: m.to, reply_all: m.replyAll },
    );
    return { messageId: r.message_id, threadId: r.thread_id };
  }

  async createInbox(m: { username: string; displayName?: string; domain?: string }): Promise<{ inboxId: string; displayName?: string }> {
    const r = await this.call<{ inbox_id: string; display_name?: string }>("POST", "/inboxes", {
      username: m.username, display_name: m.displayName, domain: m.domain,
    });
    return { inboxId: r.inbox_id, displayName: r.display_name };
  }

  async createWebhook(m: { url: string; eventTypes: string[]; inboxIds?: string[] }): Promise<{ webhookId: string; secret: string; url: string }> {
    const r = await this.call<{ webhook_id: string; secret: string; url: string }>("POST", "/webhooks", {
      url: m.url, event_types: m.eventTypes, inbox_ids: m.inboxIds,
    });
    return { webhookId: r.webhook_id, secret: r.secret, url: r.url };
  }
}

const enc = encodeURIComponent;
