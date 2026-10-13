// Which adapter a tenant's claw uses (Python HTR's adapters/__init__.py *_for(tenant)). The
// tenant's `adapters` block chooses and names the env vars holding secrets; without it, each
// claw reads the deployment-wide env vars it always has, so an install of one is configured by
// env alone. A claw that isn't configured is null; the caller decides whether that is an error.

import type { Doc } from "../_generated/dataModel";
import { normalizeBaseUrl } from "../lib/llm/baseUrl";
import { EMBED_DEFAULT_MODEL } from "../lib/llm/embed";
import type { LlmClaw, MailClaw, MeetingsClaw, NotifyClaw, Port, ReaderClaw, TaskClaw } from "./ports";
import { agentMail, clickUp, firecrawl, fireflies, gmail, ntfy, openAiCompat } from "./vendors";

type Tenant = Doc<"tenants">;
type Fetch = typeof fetch;

const env = (name: string | undefined) => (name ? process.env[name] || undefined : undefined);

/** The tenant has a mailbox to send from: an AgentMail inbox, or the owner's Gmail. */
export function hasMail(tenant: Tenant): boolean {
  return Boolean(tenant.channels.inboxId) || tenant.adapters?.mail?.kind === "gmail";
}

export function mailClaw(tenant: Tenant, f: Fetch = fetch): MailClaw {
  const a = tenant.adapters?.mail;
  if (a?.kind === "gmail") {
    const idEnv = a.clientIdEnv ?? "GOOGLE_OAUTH_CLIENT_ID";
    const secretEnv = a.clientSecretEnv ?? "GOOGLE_OAUTH_CLIENT_SECRET";
    const clientId = env(idEnv);
    const clientSecret = env(secretEnv);
    if (!clientId || !clientSecret) throw new Error(`${idEnv} and ${secretEnv} must be set on the deployment`);
    const grant = tenant.channels.gmail;
    const refreshToken = grant?.refreshToken ?? env("GOOGLE_REFRESH_TOKEN");
    if (!refreshToken) throw new Error(`tenant ${tenant.slug} has not connected Gmail; run gmail:connectUrl and open the link`);
    return gmail({ clientId, clientSecret, refreshToken }, grant?.address ?? env("GMAIL_ADDRESS"), f);
  }
  const key = env(a?.keyEnv ?? "AGENTMAIL_API_KEY");
  if (!key) throw new Error(`${a?.keyEnv ?? "AGENTMAIL_API_KEY"} is not set on the deployment`);
  if (!tenant.channels.inboxId) throw new Error(`tenant ${tenant.slug} has no AgentMail inbox; run mail:provision`);
  return agentMail(key, tenant.channels.inboxId, f);
}

export function taskClaw(tenant: Tenant, f: Fetch = fetch): TaskClaw | null {
  const token = env(tenant.adapters?.tasks?.tokenEnv ?? "CLICKUP_API_TOKEN");
  return token ? clickUp(token, tenant.tasks?.teamId, f) : null;
}

export function notifyClaw(tenant: Tenant, f: Fetch = fetch): NotifyClaw | null {
  const a = tenant.adapters?.notify;
  const topic = a?.topic ?? env("HTR_NTFY_TOPIC");
  if (!topic) return null;
  const url = (a?.url ?? env("HTR_NTFY_URL") ?? "https://ntfy.sh").replace(/\/+$/, "");
  return ntfy({ url, topic, token: env(a?.tokenEnv ?? "HTR_NTFY_TOKEN") }, f);
}

export function readerClaw(tenant: Tenant | null, f: Fetch = fetch): ReaderClaw | null {
  const key = env(tenant?.adapters?.reader?.keyEnv ?? "FIRECRAWL_API_KEY");
  return key ? firecrawl(key, f) : null;
}

export function llmClaw(tenant: Tenant | null, f: Fetch = fetch): LlmClaw | null {
  const a = tenant?.adapters?.llm;
  const apiKey = env(a?.keyEnv ?? "OPENAI_API_KEY");
  if (!apiKey) return null;
  return openAiCompat({
    baseUrl: normalizeBaseUrl(a?.baseUrl ?? env("OPENAI_BASE_URL")),
    apiKey,
    model: a?.model ?? env("OPENAI_MODEL") ?? "gpt-5-mini",
    embedModel: a?.embedModel ?? env("OPENAI_EMBED_MODEL") ?? EMBED_DEFAULT_MODEL,
  }, f);
}

export function meetingsClaw(tenant: Tenant | null, f: Fetch = fetch): MeetingsClaw | null {
  const key = env(tenant?.adapters?.meetings?.keyEnv ?? "FIREFLIES_API_KEY");
  return key ? fireflies(key, f) : null;
}

/** The secret Fireflies signs its webhook with (X-Hub-Signature); unset means only the intake key gets in. */
export function meetingsWebhookSecret(tenant: Tenant): string | undefined {
  return env(tenant.adapters?.meetings?.secretEnv ?? "FIREFLIES_WEBHOOK_SECRET");
}

/** Every claw this tenant has, for the heartbeat. A claw that throws on resolve is reported as down. */
export function clawsOf(tenant: Tenant, f: Fetch = fetch): Array<{ port: Port; claw: { name: string; probe?: () => Promise<void> } | null; error?: string }> {
  const out: Array<{ port: Port; claw: { name: string; probe?: () => Promise<void> } | null; error?: string }> = [];
  const tryResolve = (port: Port, get: () => { name: string; probe?: () => Promise<void> } | null) => {
    try {
      out.push({ port, claw: get() });
    } catch (e) {
      out.push({ port, claw: null, error: String(e instanceof Error ? e.message : e) });
    }
  };
  if (hasMail(tenant)) tryResolve("mail", () => mailClaw(tenant, f));
  tryResolve("tasks", () => taskClaw(tenant, f));
  tryResolve("notify", () => notifyClaw(tenant, f));
  tryResolve("reader", () => readerClaw(tenant, f));
  tryResolve("llm", () => llmClaw(tenant, f));
  tryResolve("meetings", () => meetingsClaw(tenant, f));
  return out;
}
