import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { recipePolicySha256, sourceBuildPolicy, sourcePolicySha256, validateBuildSelection } from "./build-policy.mjs";

function selection(mode = "development", manifest = { schemaVersion: 1 }) {
  const manifestContent = JSON.stringify(manifest);
  return { schemaVersion: 1, kind: "derivative", version: sourceBuildPolicy.version, baseVersion: sourceBuildPolicy.baseVersion,
    manifestContent, manifestSha256: createHash("sha256").update(manifestContent).digest("hex"),
    build: { schemaVersion: 1, mode, sourcePolicySha256, recipeSha256: recipePolicySha256, sourceKey: "1".repeat(64) } };
}

test("a prepared selector binds the committed reviewed engine policy and recipe", () => {
  const value = selection();
  assert.equal(validateBuildSelection(value), value);
  assert.throws(() => validateBuildSelection({ ...value, version: "2.1.4" }), /missing or stale/);
  assert.throws(() => validateBuildSelection({ ...value, kind: "official" }), /missing or stale/);
  assert.throws(() => validateBuildSelection({ ...value, build: undefined }), /missing or stale/);
  for (const key of ["sourcePolicySha256", "recipeSha256", "sourceKey", "mode"]) {
    assert.throws(() => validateBuildSelection({ ...value, build: { ...value.build, [key]: "invalid" } }), /missing or stale/);
  }
  assert.throws(() => validateBuildSelection({ ...value, manifestContent: value.manifestContent + " " }), /build pin/);
  assert.throws(() => validateBuildSelection({ ...value, downloadBaseUrl: "https://unreviewed.invalid/" }), /runtime download/);
});

test("development target subsets never authorize a production selector", () => {
  const manifest = { schemaVersion: 2, scope: { kind: "development", targets: ["darwin-arm64"] } };
  assert.equal(validateBuildSelection(selection("development", manifest)).build.mode, "development");
  assert.throws(() => validateBuildSelection(selection("production", manifest)), /complete reviewed target/);
  assert.throws(() => validateBuildSelection(selection("production", { schemaVersion: 1, scope: manifest.scope })), /complete reviewed target/);
  assert.equal(validateBuildSelection(selection("production")).build.mode, "production");
});
