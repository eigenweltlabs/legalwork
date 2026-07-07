/**
 * release:verify-tag — validate a release tag before building.
 *
 * Versions are stamped from the tag at build time (see apply-version.mjs), so
 * the tag no longer needs to point at a version-bump commit. What still
 * matters is that releases build from reviewed history: the tagged commit must
 * be reachable from the release branch (origin/dev by default).
 *
 * Usage:
 *   node scripts/release/verify-tag.mjs --tag v1.2.3 [--branch origin/dev]
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const tag = (readArg("--tag") || process.env.RELEASE_TAG || "").trim();
const branch = (readArg("--branch") || "origin/dev").trim();

if (!tag) {
  console.error("Release tag missing. Provide --tag or set RELEASE_TAG.");
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`Invalid release tag: ${tag} (expected vX.Y.Z)`);
  process.exit(1);
}

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();

const tryGit = (...gitArgs) => {
  try {
    return git(...gitArgs);
  } catch {
    return null;
  }
};

const tagCommit = tryGit("rev-parse", "--verify", `${tag}^{commit}`);
if (!tagCommit) {
  console.error(`Tag ${tag} not found in this checkout.`);
  process.exit(1);
}

let branchCommit = tryGit("rev-parse", "--verify", `${branch}^{commit}`);
if (!branchCommit) {
  // Shallow or branchless checkouts (e.g. detached tag checkout) may not have
  // the release branch locally; fetch it before giving up.
  const remoteBranch = branch.replace(/^origin\//, "");
  tryGit("fetch", "origin", remoteBranch);
  branchCommit = tryGit("rev-parse", "--verify", `${branch}^{commit}`);
}
if (!branchCommit) {
  console.error(`Release branch ${branch} not found; cannot verify tag ancestry.`);
  process.exit(1);
}

try {
  execFileSync("git", ["merge-base", "--is-ancestor", tagCommit, branchCommit], {
    cwd: root,
  });
} catch {
  console.error(
    `Tag ${tag} (${tagCommit.slice(0, 9)}) is not reachable from ${branch}. ` +
      `Releases must tag commits that already landed on the release branch.`,
  );
  process.exit(1);
}

console.log(`Release tag ${tag} -> ${tagCommit.slice(0, 9)} is on ${branch}.`);
