#!/usr/bin/env node
// Refuses a deploy unless the tree is clean and identical to origin/main.
//
// Production has been ahead of git three times on this project (recovered in
// 54ce388, 4267f39, 9f8bcdf). The 2026-08-25 deploy was the expensive one: it
// came from a checkout that was behind origin, so it silently reverted the
// desk_dropped alerting that was already committed. Nothing surfaced that —
// `git status` was clean on both machines, and the revert was only found by
// diffing the deployed bundle by hand.
//
// Wired into wrangler.toml as `[build] command`, so it runs on every build,
// including `wrangler dev` and `--dry-run`. Set PREDEPLOY_SKIP=1 to bypass
// (needed for dry-run verification against a dirty tree, and for emergencies).

import { execFileSync } from "node:child_process";

const BRANCH = process.env.PREDEPLOY_BRANCH || "main";
const REMOTE = process.env.PREDEPLOY_REMOTE || "origin";

if (process.env.PREDEPLOY_SKIP === "1") {
  console.log("predeploy: skipped (PREDEPLOY_SKIP=1)");
  process.exit(0);
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fail(headline, ...detail) {
  console.error(`\n  ✗ predeploy: ${headline}\n`);
  for (const d of detail) console.error(`    ${d}`);
  console.error(`\n    Deploy from a clean ${BRANCH} that matches ${REMOTE}/${BRANCH}.`);
  console.error(`    To override for a genuine emergency: PREDEPLOY_SKIP=1 npx wrangler deploy\n`);
  process.exit(1);
}

try {
  git("rev-parse", "--is-inside-work-tree");
} catch {
  fail("not inside a git repository", "Deploying from an untracked copy is how code goes missing.");
}

// Branch
let branch;
try {
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  fail("could not read the current branch");
}
if (branch === "HEAD") fail("detached HEAD", `Check out ${BRANCH} before deploying.`);
if (branch !== BRANCH) fail(`on branch '${branch}', not '${BRANCH}'`);

// Clean tree
const dirty = git("status", "--porcelain");
if (dirty) {
  const files = dirty.split("\n").filter(Boolean);
  fail(
    `working tree has ${files.length} uncommitted change${files.length === 1 ? "" : "s"}`,
    ...files.slice(0, 10),
    ...(files.length > 10 ? [`... and ${files.length - 10} more`] : []),
    "",
    "Whatever is uncommitted here would be deployed and exist nowhere else."
  );
}

// Up to date with the remote
try {
  git("fetch", REMOTE, BRANCH, "--quiet");
} catch (err) {
  fail(
    `could not fetch ${REMOTE}/${BRANCH}`,
    String(err?.stderr || err?.message || err).trim(),
    "",
    "Refusing to deploy without confirming you have the latest committed work."
  );
}

const behind = Number(git("rev-list", "--count", `HEAD..${REMOTE}/${BRANCH}`));
const ahead = Number(git("rev-list", "--count", `${REMOTE}/${BRANCH}..HEAD`));

if (behind > 0 && ahead > 0) {
  fail(
    `diverged from ${REMOTE}/${BRANCH} (${ahead} local, ${behind} remote)`,
    "Deploying would revert the remote commits you don't have.",
    ...git("log", "--oneline", `HEAD..${REMOTE}/${BRANCH}`).split("\n").slice(0, 5)
  );
}
if (behind > 0) {
  fail(
    `${behind} commit${behind === 1 ? "" : "s"} behind ${REMOTE}/${BRANCH}`,
    "Deploying would revert work that is already committed:",
    "",
    ...git("log", "--oneline", `HEAD..${REMOTE}/${BRANCH}`).split("\n").slice(0, 10),
    "",
    "Run: git pull --ff-only"
  );
}
if (ahead > 0) {
  fail(
    `${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${REMOTE}/${BRANCH}`,
    "These are not pushed, so production would be the only copy:",
    "",
    ...git("log", "--oneline", `${REMOTE}/${BRANCH}..HEAD`).split("\n").slice(0, 10),
    "",
    "Run: git push"
  );
}

console.log(`predeploy: ok — ${branch} @ ${git("rev-parse", "--short", "HEAD")}, clean, matches ${REMOTE}/${BRANCH}`);
