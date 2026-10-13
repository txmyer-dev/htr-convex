#!/usr/bin/env node
// `npm run update`: how an install gets fixes. Pull, install, bring the containers to what the
// repo pins, deploy, run data migrations, and health-check every claw.

import { C, closePrompts, convexRun, deploy, die, loadState, ok, printStatus, readEnvFile, run, step, warn } from "./lib.mjs";

function main() {
  const st = loadState();
  if (!st.slug) die("No .htr-install.json here: run npm run setup first");
  if (readEnvFile(".env.local").CONVEX_DEPLOYMENT) die(".env.local points at a Convex cloud deployment, not this install");

  step("1/5  Pull");
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true }).out) die("Local changes to tracked files; commit or stash them first");
  run("git", ["pull", "--ff-only"]);
  ok(run("git", ["log", "-1", "--format=%h %s"], { capture: true }).out);

  step("2/5  Dependencies and containers");
  run("npm", ["ci"]);
  run("docker", ["compose", "pull", "--quiet"]);
  run("docker", ["compose", "up", "-d"]);
  ok("containers as pinned");

  step("3/5  Deploy");
  deploy();
  ok("functions and page deployed");

  step("4/5  Migrations");
  const ran = convexRun("migrations:run");
  ok(Array.isArray(ran) && ran.length ? `ran ${ran.join(", ")}` : "nothing to migrate");

  step("5/5  Health check");
  convexRun("health:beat");
  const down = printStatus(st.slug);
  console.log(down ? `\n${C.y("!")} ${down} check(s) failed; npm run setup fixes keys.` : `\n${C.g("✓")} Up to date.`);
  closePrompts();
}

try {
  main();
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
