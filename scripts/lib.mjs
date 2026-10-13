// Shared by setup.mjs and update.mjs. Node only, no dependencies: an install needs Node for
// Convex anyway, and nothing else (INSTALL.md).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export const STATE = ".htr-install.json"; // setup's answers, never a secret
export const C = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

export function step(title) {
  console.log(`\n${C.b(`── ${title} `.padEnd(72, "─"))}`);
}
export const ok = (s) => console.log(`  ${C.g("✓")} ${s}`);
export const warn = (s) => console.log(`  ${C.y("!")} ${s}`);
export const bad = (s) => console.log(`  ${C.r("✗")} ${s}`);
export const note = (s) => console.log(`  ${s}`);

export function die(s) {
  console.error(`\n${C.r("✗")} ${s}`);
  process.exit(1);
}

export function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}
export function saveState(s) {
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
}

/** KEY=value lines in, an object out (for .env and .env.local). */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
export function writeEnvFile(path, obj, header) {
  const body = Object.entries(obj).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(path, `${header ? `# ${header}\n` : ""}${body}\n`, { mode: 0o600 });
}

/** Run a command; inherit the terminal unless asked to capture. Throws on failure unless `allowFail`. */
export function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: o.capture || o.input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit", input: o.input, encoding: "utf8", env: { ...process.env, ...o.env } });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})${o.capture || o.input !== undefined ? `:\n${(r.stderr || r.stdout || "").trim().slice(-1500)}` : ""}`);
  }
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export const has = (cmd, args = ["--version"]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

// ---- Convex, against the self-hosted backend named in .env.local ----------------------------------

/** `npx convex run fn args`, the JSON result parsed. */
export function convexRun(fn, args = {}) {
  const { out } = run("npx", ["convex", "run", fn, JSON.stringify(args)], { capture: true });
  for (const candidate of [out, out.slice(Math.max(0, out.search(/^[[{"]/m)))]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // log lines ahead of the result; try from the first line that opens JSON
    }
  }
  return out;
}

export function convexEnvNames() {
  const { out } = run("npx", ["convex", "env", "list"], { capture: true });
  return new Set(out.split("\n").map((l) => l.split("=")[0].trim()).filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n)));
}

/** The value goes in on stdin, so it never lands in argv, the shell history, or `ps`. */
export function convexEnvSet(name, value) {
  run("npx", ["convex", "env", "set", name], { input: `${value}\n` });
}

export function deploy({ upload = true } = {}) {
  run("npx", ["convex", "deploy", "-y"]);
  if (!upload) return;
  run("npm", ["run", "build"]); // reads VITE_CONVEX_URL from .env.local: the public API origin, not 127.0.0.1
  run("npx", ["@convex-dev/static-hosting", "upload"]);
}

export function printStatus(slug) {
  const s = convexRun("install:status", { slug });
  if (!s || typeof s !== "object") return bad(`no tenant "${slug}"`);
  if (s.gmail) ok(`Gmail connected: ${s.gmail.address}`);
  else warn("Gmail not connected yet");
  let down = 0;
  for (const c of s.claws) {
    if (c.ok) ok(`${c.port.padEnd(9)} ${c.adapter ?? ""}`);
    else {
      down++;
      bad(`${c.port.padEnd(9)} ${c.adapter ?? ""} ${C.d(c.error ?? "")}`);
    }
  }
  return down;
}

// ---- prompts --------------------------------------------------------------------------------------

let rl;
function iface() {
  rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return rl;
}
export function closePrompts() {
  rl?.close();
}

function question(q, muted = false) {
  const r = iface();
  return new Promise((resolve) => {
    if (!muted) return r.question(q, resolve);
    const write = r._writeToOutput;
    r._writeToOutput = (s) => (s.startsWith(q) ? write.call(r, s) : write.call(r, s.replace(/[^\r\n]/g, "")));
    r.question(q, (a) => {
      r._writeToOutput = write;
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

export async function ask(q, def, check) {
  for (;;) {
    const a = (await question(`  ${q}${def ? C.d(` [${def}]`) : ""}: `)).trim() || def || "";
    const why = check?.(a);
    if (!why) return a;
    warn(why);
  }
}

/** A secret: typed blind. `keep` = it is already set on the deployment, Enter keeps it. */
export async function secret(q, { keep = false, optional = false } = {}) {
  for (;;) {
    const a = (await question(`  ${q}${keep ? C.d(" [set — Enter keeps it]") : optional ? C.d(" [Enter skips]") : ""}: `, true)).trim();
    if (a || keep || optional) return a;
    warn("needed");
  }
}

export async function yes(q, def = true) {
  const a = (await question(`  ${q} ${C.d(def ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
  return a ? a.startsWith("y") : def;
}
