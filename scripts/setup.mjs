#!/usr/bin/env node
// `npm run setup`: one pass from a fresh clone to a running Hold the Room on this machine.
// It asks for every key and grant up front, starts self-hosted Convex (compose.yml), deploys,
// creates the one tenant, connects Gmail, and health-checks every claw. Safe to run again: the
// answers are remembered in .htr-install.json (no secrets), secrets already set can be kept.
//
// Secrets go to the Convex deployment (`convex env set`, on stdin), never to a file in the repo.

import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { existsSync } from "node:fs";
import {
  C, ask, bad, closePrompts, convexEnvNames, convexEnvSet, convexRun, deploy, die, has, loadState, note, ok, printStatus,
  readEnvFile, run, saveState, secret, step, warn, writeEnvFile, yes,
} from "./lib.mjs";

const hex = (n) => randomBytes(n).toString("hex");
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function main() {
  console.log(C.b("\nHold the Room — setup\n"));
  const st = loadState();

  // ---- 1. this machine ------------------------------------------------------------------------
  step("1/8  This machine");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) die(`Node 20 or newer is needed (this is ${process.versions.node})`);
  ok(`Node ${process.versions.node}`);
  if (!has("docker", ["compose", "version"])) die("Docker with the compose plugin is needed: https://docs.docker.com/engine/install/");
  ok("Docker compose");
  if (!existsSync("node_modules")) die("Run `npm ci` first");
  const local = readEnvFile(".env.local");
  if (local.CONVEX_DEPLOYMENT) die(".env.local points at a Convex cloud deployment; setup is for a self-hosted install (move .env.local aside first)");

  // ---- 2. who and where -----------------------------------------------------------------------
  step("2/8  Who and where");
  note(C.d("Two DNS A records must point at this server: the domain, and api.<the domain> (or another name you give)."));
  st.domain = await ask("Domain for this install (e.g. htr.example.com)", st.domain, (d) => (DOMAIN.test(d) ? "" : "a domain name, no https://"));
  st.apiDomain = await ask("Domain for its API", st.apiDomain ?? `api.${st.domain}`, (d) => (DOMAIN.test(d) && d !== st.domain ? "" : "a different domain name"));
  st.ownerName = await ask("Your name", st.ownerName);
  st.ownerEmail = (await ask("Your email (Gmail you'll connect; rulings by email come from it)", st.ownerEmail, (e) => (EMAIL.test(e) ? "" : "an email address"))).toLowerCase();
  st.slug = await ask("Short name for this install, used in URLs", st.slug ?? st.ownerName.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9-]/g, ""), (s) => (/^[a-z0-9][a-z0-9-]{1,30}$/.test(s) ? "" : "lowercase letters, digits, dashes"));
  st.displayName = await ask("Business or display name", st.displayName ?? st.ownerName);
  st.agentName = await ask("What the assistant signs as", st.agentName ?? "Assistant");
  st.timeZone = await ask("Time zone", st.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, (z) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: z });
      return "";
    } catch {
      return "an IANA zone, e.g. America/Chicago";
    }
  });
  st.digestAt = await ask('Digest email: "immediate", or a time like 07:30', st.digestAt ?? "07:30", (d) => (d === "immediate" || HHMM.test(d) ? "" : 'say "immediate" or HH:MM'));
  st.quiet = await ask("Quiet hours, no phone alerts (e.g. 21:00-08:00, or none)", st.quiet ?? "21:00-08:00", (q) => (q === "none" || /^\d\d:\d\d-\d\d:\d\d$/.test(q) ? "" : "HH:MM-HH:MM or none"));
  saveState(st);
  await checkDns(st);

  // ---- 3. self-hosted Convex --------------------------------------------------------------------
  step("3/8  Convex on this machine");
  const env = readEnvFile(".env");
  writeEnvFile(".env", { ...env, HTR_DOMAIN: st.domain, HTR_API_DOMAIN: st.apiDomain, INSTANCE_SECRET: env.INSTANCE_SECRET || hex(32) }, "docker compose (npm run setup). INSTANCE_SECRET signs the admin key: keep it, back it up.");
  run("docker", ["compose", "up", "-d"]);
  await waitFor("the backend", async () => (await fetch("http://127.0.0.1:3210/version")).ok);
  ok("backend up on 127.0.0.1:3210");
  let adminKey = local.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!adminKey) {
    adminKey = run("docker", ["compose", "exec", "-T", "backend", "./generate_admin_key.sh"], { capture: true }).out.split("\n").pop().trim();
    if (!adminKey.includes("|")) die(`couldn't read an admin key from the backend: ${adminKey}`);
  }
  writeEnvFile(".env.local", { ...local, CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210", CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, VITE_CONVEX_URL: `https://${st.apiDomain}` }, "this install's Convex (npm run setup). The admin key is full control: never commit it.");
  ok("admin key in .env.local");

  // ---- 4. deploy ----------------------------------------------------------------------------------
  step("4/8  Deploy");
  deploy();
  ok("functions and the owner's page deployed");
  const names = convexEnvNames();

  // ---- 5. keys --------------------------------------------------------------------------------------
  step("5/8  Keys (stored on the deployment, never in a file)");
  const set = async (name, label, o = {}) => {
    const v = await secret(label, { keep: names.has(name), optional: o.optional });
    if (v) {
      convexEnvSet(name, v);
      names.add(name);
    }
    return v || (names.has(name) ? "(kept)" : "");
  };
  for (const [name, n] of [["HTR_RULING_SECRET", 32], ["HTR_SITE_SECRET", 32]]) {
    if (!names.has(name)) convexEnvSet(name, hex(n));
  }
  ok("signing secrets");

  note(C.b("\n  The model (any OpenAI-compatible API)"));
  st.llmBaseUrl = await ask("Base URL", st.llmBaseUrl ?? "https://api.openai.com/v1");
  st.llmModel = await ask("Model", st.llmModel ?? "gpt-5-mini");
  convexEnvSet("OPENAI_BASE_URL", st.llmBaseUrl);
  convexEnvSet("OPENAI_MODEL", st.llmModel);
  await set("OPENAI_API_KEY", "API key");

  note(C.b("\n  Phone alerts (ntfy: install the ntfy app, subscribe to the topic below)"));
  st.ntfyTopic = await ask("ntfy topic (keep it unguessable)", st.ntfyTopic ?? `htr-${st.slug}-${hex(8)}`);
  convexEnvSet("HTR_NTFY_TOPIC", st.ntfyTopic);
  st.ntfyUrl = await ask("ntfy server", st.ntfyUrl ?? "https://ntfy.sh");
  if (st.ntfyUrl !== "https://ntfy.sh") convexEnvSet("HTR_NTFY_URL", st.ntfyUrl);

  note(C.b("\n  Fireflies (meeting notes and action items)"));
  if (await yes("Use Fireflies?", st.fireflies ?? true)) {
    st.fireflies = true;
    note(C.d("  Fireflies → Settings → Developer settings: copy the API key. Webhook URL and secret come at the end."));
    await set("FIREFLIES_API_KEY", "Fireflies API key");
    if (!names.has("FIREFLIES_WEBHOOK_SECRET")) convexEnvSet("FIREFLIES_WEBHOOK_SECRET", hex(24));
    names.add("FIREFLIES_WEBHOOK_SECRET");
  } else st.fireflies = false;

  note(C.b("\n  ClickUp (optional: approved action items become tasks)"));
  let tasks;
  if (await yes("Use ClickUp?", st.clickupListId ? true : false)) {
    const token = await set("CLICKUP_API_TOKEN", "ClickUp personal API token (pk_…)");
    st.clickupListId = await ask("List ID for new tasks (open the list; the number after /li/ in its URL)", st.clickupListId, (s) => (/^\d+$/.test(s) ? "" : "digits"));
    const list = token && token !== "(kept)" ? await clickupList(token, st.clickupListId) : null;
    st.clickupListName = list?.name ?? st.clickupListName ?? "Tasks";
    st.clickupTeamId = list?.teamId ?? st.clickupTeamId;
    if (list) ok(`list "${list.name}"`);
    tasks = { clickupListId: st.clickupListId, listName: st.clickupListName, teamId: st.clickupTeamId };
  }

  note(C.b("\n  Optional accounts (Enter skips any)"));
  await set("FIRECRAWL_API_KEY", "Firecrawl API key (drafts read your website)", { optional: true });
  await set("COMPOSIO_API_KEY", "Composio API key", { optional: true });
  await set("TREG_API_KEY", "treg API key", { optional: true });
  await set("JEV_API_KEY", "jev API key", { optional: true });
  saveState(st);

  // ---- 6. Gmail ------------------------------------------------------------------------------------
  step("6/8  Gmail (your own Google OAuth client)");
  const redirect = `https://${st.domain}/oauth/google/callback`;
  if (!names.has("GOOGLE_OAUTH_CLIENT_ID") || !names.has("GOOGLE_OAUTH_CLIENT_SECRET") || (await yes("Enter a new OAuth client?", false))) {
    note(`In ${C.b("https://console.cloud.google.com")}, signed in as ${st.ownerEmail}:`);
    note("  1. Create a project (any name), then APIs & Services → Library → Gmail API → Enable.");
    note("  2. Google Auth Platform → Get started: app name \"Hold the Room\", your email, Audience External.");
    note("  3. Data access → Add scopes: gmail.readonly and gmail.send.");
    note(`  4. Audience → ${C.b("Publish app")} (In production). In Testing, Google expires the grant every 7 days.`);
    note("  5. Clients → Create client → Web application. Authorized redirect URI, exactly:");
    note(`       ${C.b(redirect)}`);
    await set("GOOGLE_OAUTH_CLIENT_ID", "Client ID");
    await set("GOOGLE_OAUTH_CLIENT_SECRET", "Client secret");
  } else ok("OAuth client already set");

  // ---- 7. the tenant -----------------------------------------------------------------------------
  step("7/8  Your install");
  const [qFrom, qTo] = st.quiet === "none" ? [] : st.quiet.split("-");
  convexRun("install:create", {
    slug: st.slug, displayName: st.displayName, timeZone: st.timeZone,
    owner: { name: st.ownerName, email: st.ownerEmail, digestAt: st.digestAt, ...(qFrom ? { quietHours: [qFrom, qTo] } : {}) },
    business: { agentName: st.agentName }, ...(tasks ? { tasks } : {}), mail: "gmail",
  });
  ok(`tenant "${st.slug}"`);
  saveState(st);

  if (!(convexRun("install:status", { slug: st.slug })?.gmail) || (await yes("Connect Gmail again?", false))) {
    await waitFor("HTTPS on your domain (Caddy gets the certificate on first use)", async () => (await fetch(`https://${st.domain}/healthz`)).ok, 180);
    const { open } = convexRun("gmail:connectUrl", { slug: st.slug });
    note(`\n  Open this, sign in as ${st.ownerEmail}, allow read and send:\n\n    ${C.b(open)}\n`);
    note(C.d('  "Google hasn\'t verified this app" → Advanced → Go to Hold the Room. The link works for 15 minutes.'));
    for (;;) {
      await ask("Press Enter once the page says \"Gmail connected\"");
      const s = convexRun("install:status", { slug: st.slug });
      if (s?.gmail) {
        ok(`connected: ${s.gmail.address}`);
        break;
      }
      warn("not connected yet");
      if (!(await yes("Try again?"))) break;
    }
  }

  // ---- 8. health ----------------------------------------------------------------------------------
  step("8/8  Health check");
  convexRun("health:beat");
  const down = printStatus(st.slug);

  console.log(C.b("\nDone.\n"));
  note(`Your page:        ${convexRun("install:ownerLink", { slug: st.slug })}`);
  note(`Phone alerts:     subscribe to "${st.ntfyTopic}" in the ntfy app${st.ntfyUrl !== "https://ntfy.sh" ? ` (server ${st.ntfyUrl})` : ""}`);
  if (st.fireflies) {
    const ff = run("npx", ["convex", "env", "get", "FIREFLIES_WEBHOOK_SECRET"], { capture: true }).out;
    note(`Fireflies:        Settings → Developer settings → Webhook URL ${C.b(`https://${st.domain}/intake/${st.slug}/meetings`)}`);
    note(`                  and signing secret ${C.b(ff)}`);
  }
  note(`Dashboard:        ssh -L 6791:127.0.0.1:6791 <this server>, then http://localhost:6791 (admin key in .env.local)`);
  note(`Updates:          npm run update`);
  if (down) warn(`${down} check(s) failed above; fix the key and run npm run setup again (answers are remembered).`);
  closePrompts();
}

async function waitFor(what, test, seconds = 90) {
  const until = Date.now() + seconds * 1000;
  let said = false;
  while (Date.now() < until) {
    try {
      if (await test()) return true;
    } catch {
      // not yet
    }
    if (!said) {
      note(C.d(`waiting for ${what}…`));
      said = true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  warn(`${what}: not ready after ${seconds}s`);
  return false;
}

async function checkDns(st) {
  let me = "";
  try {
    me = (await (await fetch("https://api.ipify.org")).text()).trim();
  } catch {
    return warn("couldn't learn this server's public IP; skipping the DNS check");
  }
  for (const d of [st.domain, st.apiDomain]) {
    const ips = await resolve4(d).catch(() => []);
    if (ips.includes(me)) ok(`${d} → ${me}`);
    else bad(`${d} → ${ips.join(", ") || "nothing"}; it must point at ${me} before HTTPS and Gmail will work`);
  }
}

async function clickupList(token, id) {
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${id}`, { headers: { Authorization: token } });
    if (!res.ok) {
      warn(`ClickUp list ${id}: ${res.status}`);
      return null;
    }
    const j = await res.json();
    return { name: j.name, teamId: await teamOf(token) };
  } catch (e) {
    warn(`ClickUp: ${e}`);
    return null;
  }
}

/** The workspace (agenda reads search it); only when the token sees exactly one. */
async function teamOf(token) {
  const res = await fetch("https://api.clickup.com/api/v2/team", { headers: { Authorization: token } });
  const teams = res.ok ? (await res.json()).teams ?? [] : [];
  return teams.length === 1 ? String(teams[0].id) : undefined;
}

main().catch((e) => {
  closePrompts();
  die(e instanceof Error ? e.message : String(e));
});
