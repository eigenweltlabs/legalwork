import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sourceBuildPolicy } from "../../packages/opencode-release/build-policy.mjs";
import { writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "../../packages/opencode-release/test-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const run = script => {
  const child = spawnSync(process.execPath, [script, "--json", "--strict"], { encoding: "utf8" });
  return { child, report: child.stdout ? JSON.parse(child.stdout) : undefined };
};

test("the source release report separates source policy from its prepared artifact and base ABI", async () => {
  const { child, report } = run(path.join(sourceRoot, "scripts", "release", "review.mjs"));
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.versions.opencode, sourceBuildPolicy.version);
  assert.equal(report.versions.opencodeKind, "source-build");
  assert.equal(report.versions.opencodeBaseVersion, sourceBuildPolicy.baseVersion);
  const preparedPath = path.join(sourceRoot, "packages/opencode-release/generated/selection.json");
  const prepared = existsSync(preparedPath) ? JSON.parse(await readFile(preparedPath, "utf8")) : undefined;
  assert.equal(report.versions.opencodeManifestSha256, prepared?.manifestSha256 ?? null);
  assert.ok(report.checks.some(check => check.label === "OpenCode source policy matches the reviewed recipe" && check.ok));
  assert.ok(report.checks.some(check => check.label === "OpenCode version pin exists" && check.ok));
});

for (const mode of ["cold", "prepared", "tampered"]) test(mode === "cold" ? "release review accepts a clean source-policy checkout before engine preparation" : mode === "tampered" ? "release review rejects a changed prepared manifest against the independent pin" : "an isolated prepared build reports its source policy, base ABI, and verified manifest pin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-release-review-"));
  try {
    const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
    const { selection } = await writeFixtureDerivativeDistribution(distributionRoot);
    await writeFixtureReleaseLibrary(path.join(root, "packages", "opencode-release"), mode === "tampered" ? { ...selection, manifestContent: `${selection.manifestContent} ` } : selection);
    if (mode === "cold") await rm(path.join(root, "packages/opencode-release/generated/selection.json"));
    for (const file of ["constants.json", "scripts/release/review.mjs", ...["app", "desktop", "server", "orchestrator"].map(app => `apps/${app}/package.json`)]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await copyFile(path.join(sourceRoot, file), path.join(root, file));
    }
    const { child, report } = run(path.join(root, "scripts", "release", "review.mjs"));
    assert.equal(child.status, mode === "tampered" ? 1 : 0, child.stderr || child.stdout);
    assert.equal(report.ok, mode !== "tampered");
    assert.equal(report.versions.opencode, selection.version);
    assert.equal(report.versions.opencodeKind, "source-build");
    assert.equal(report.versions.opencodeBaseVersion, selection.baseVersion);
    assert.equal(report.versions.opencodeManifestSha256, mode === "cold" ? null : selection.manifestSha256);
    const pinCheck = report.checks.find(check => check.label === "OpenCode derivative manifest matches its independent pin and selection");
    if (mode === "cold") {
      assert.equal(pinCheck, undefined);
      assert.ok(report.warnings.some(warning => warning.includes("no generated engine build")));
      assert.equal(existsSync(path.join(root, "packages/opencode-release/generated/selection.json")), false, "Release review must not prepare an engine");
    } else {
      assert.equal(pinCheck.ok, mode === "prepared");
      if (mode === "tampered") assert.match(pinCheck.details, /manifest does not match its build pin/);
    }
    assert.ok(report.checks.some(check => check.label === "OpenCode source policy matches the reviewed recipe" && check.ok));
    for (const field of ["app", "desktop", "server", "orchestrator", "orchestratorLegalworkServerRange"]) assert.ok(Object.hasOwn(report.versions, field));
    for (const field of ["opencodeRouter", "opencodeRouterVersionPinned"]) assert.equal(Object.hasOwn(report.versions, field), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
