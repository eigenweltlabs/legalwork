#!/usr/bin/env node
/**
 * release:ship
 *
 * Pushes the release tag to origin (dev itself is never pushed — the tag
 * points at a commit already on origin/dev, and CI stamps the version from
 * the tag), then prints the GitHub Actions workflow URL. Optionally tails
 * the workflow run.
 *
 * Flags:
 *   --dry-run   Print what would happen without pushing.
 *   --watch     Tail the GHA workflow run after push.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const dryRun = args.includes("--dry-run");
const watch = args.includes("--watch");

const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n▸ ${msg}`);
const success = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

const run = (cmd, opts = {}) => {
  if (dryRun && !opts.readOnly) {
    log(`[dry-run] ${cmd}`);
    return "";
  }
  try {
    return execSync(cmd, {
      cwd: root,
      encoding: "utf8",
      stdio: opts.inherit ? "inherit" : "pipe",
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    fail(`Command failed: ${cmd}\n${err.stderr || err.message}`);
  }
};

// ── Step 1: Resolve tag from HEAD ───────────────────────────────────
heading("Resolving tag");

const tag = run("git describe --tags --exact-match HEAD", {
  readOnly: true,
  allowFail: true,
});

if (!tag) {
  fail(
    "HEAD is not tagged. Run 'pnpm release:prepare' first.\n" +
    "  (Expected a vX.Y.Z tag on HEAD)"
  );
}

if (!/^v\d+\.\d+\.\d+/.test(tag)) {
  fail(`Tag '${tag}' does not look like a release tag (expected vX.Y.Z)`);
}

success(`Found tag: ${tag}`);

// ── Step 2: Verify the tag is on origin/dev ────────────────────────
heading("Verifying tag against origin/dev");
run("git fetch origin dev", { readOnly: true });
const onDev = run(`git merge-base --is-ancestor ${tag} origin/dev && echo yes`, {
  readOnly: true,
  allowFail: true,
});
if (onDev !== "yes") {
  fail(
    `Tag ${tag} does not point at a commit on origin/dev.\n` +
    "  Releases build from dev history — merge your work via a PR, then re-run\n" +
    "  'pnpm release:prepare' on the updated dev."
  );
}
success(`${tag} is on origin/dev`);

// ── Step 3: Push tag ────────────────────────────────────────────────
heading("Pushing tag to origin");
run(`git push origin ${tag}`);
success(`Pushed ${tag}`);

// ── Step 4: Print workflow URL ──────────────────────────────────────
heading("GitHub Actions");

const repo = "eigenweltlabs/legalwork";
const url = `https://github.com/${repo}/actions/workflows/release-macos-aarch64.yml`;
log(`Pushing ${tag} auto-starts the build, which creates a DRAFT release.`);
log(`Build:    ${url}`);
log(`Publish:  https://github.com/${repo}/releases  ("Publish release" rolls it out to all users)`);

// ── Step 5: Optionally watch ────────────────────────────────────────
if (watch && !dryRun) {
  heading("Watching workflow run");
  log("Waiting for workflow to appear…");

  // Give GitHub a moment to register the run
  execSync("sleep 10", { cwd: root });

  try {
    const runs = run(
      `gh run list --repo ${repo} --workflow "Release App" --limit 1 --json databaseId,headBranch,event -q ".[0].databaseId"`,
      { readOnly: true }
    );
    if (runs) {
      log(`Run ID: ${runs}`);
      run(`gh run watch ${runs} --repo ${repo} --exit-status`, { inherit: true });
    } else {
      log("Could not find the workflow run. Check the Actions tab manually.");
    }
  } catch {
    log("Workflow watch exited (check status on GitHub).");
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
console.log(`  Shipped: ${tag}`);
if (dryRun) {
  console.log("  Mode:    DRY RUN (nothing was pushed)");
}
console.log("─".repeat(50) + "\n");
