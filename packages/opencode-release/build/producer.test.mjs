import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceBuildPolicy } from "../build-policy.mjs";
import recipe from "./recipe.json" with { type: "json" };
import { buildOpencodeDistribution, sourceInstallArguments, validateSourceBuildRequest } from "./producer.mjs";

test("source builds require explicit mode, reviewed host compiler and unique reviewed targets", () => {
  assert.throws(() => validateSourceBuildRequest({}), /explicit development or production/);
  assert.throws(() => validateSourceBuildRequest({ mode: "development", targets: [] }), /nonempty unique subset/);
  assert.throws(() => validateSourceBuildRequest({ mode: "development", targets: ["darwin-arm64", "darwin-arm64"] }), /nonempty unique subset/);
  assert.throws(() => validateSourceBuildRequest({ mode: "development", targets: ["arbitrary"] }), /nonempty unique subset/);
  assert.throws(() => validateSourceBuildRequest({ mode: "development" }, "unknown-host"), /reviewed Bun compiler/);
  for (const host of Object.keys(recipe.toolchain.executables)) assert.deepEqual(validateSourceBuildRequest({ mode: "development", targets: [recipe.targets[0]] }, host), [recipe.targets[0]]);
});

test("production cannot become ad-hoc through missing/wrong signing policy or a partial target set", () => {
  assert.throws(() => validateSourceBuildRequest({ mode: "production", targets: ["darwin-arm64"] }), /complete shipped target matrix/);
  assert.throws(() => validateSourceBuildRequest({ mode: "production", requireSigning: true }, "darwin-arm64"), /cannot fall back to ad-hoc/);
  assert.throws(() => validateSourceBuildRequest({ mode: "production", requireSigning: true, macSigning: { ...sourceBuildPolicy.productionMacSigner, teamId: "XXXXXXXXXX" } }, "darwin-arm64"), /exact committed public certificate/);
  assert.throws(() => validateSourceBuildRequest({ mode: "production", requireSigning: true, macSigning: sourceBuildPolicy.productionMacSigner }, "linux-x64"), /macOS source builder/);
  assert.deepEqual(validateSourceBuildRequest({ mode: "production", requireSigning: true, macSigning: sourceBuildPolicy.productionMacSigner }, "darwin-arm64"), [...recipe.targets].sort());
  assert.throws(() => validateSourceBuildRequest({ mode: "development", macSigning: sourceBuildPolicy.productionMacSigner }), /explicit production mode/);
});


test("actual production producer refuses missing signing policy before creating build state or fetching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-production-failclosed-"));
  const outputDirectory = path.join(root, "must-not-be-created");
  try {
    await assert.rejects(buildOpencodeDistribution({ outputDirectory, mode: "production" }), /cannot fall back to ad-hoc/);
    await assert.rejects(lstat(outputDirectory), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("native-only frozen installation omits foreign optional packages; cross/all-target builds retain them", () => {
  const base = ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"];
  assert.deepEqual(sourceInstallArguments(["darwin-arm64"], "darwin-arm64"), base);
  assert.deepEqual(sourceInstallArguments(["windows-x64-baseline"], "windows-arm64"), [...base, "--os=*", "--cpu=*", "--libc=*"]);
  assert.deepEqual(sourceInstallArguments(recipe.targets, "darwin-arm64"), [...base, "--os=*", "--cpu=*", "--libc=*"]);
});
