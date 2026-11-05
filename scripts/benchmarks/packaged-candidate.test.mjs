import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { writeFixtureReleaseLibrary } from "../../packages/opencode-release/test-fixture.mjs";

const source = new URL("./packaged-candidate.mjs", import.meta.url);
const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/opencode-release");

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-packaged-candidate-"));
  try {
    const isolatedPackage = path.join(root, "node_modules", "@legalwork", "opencode-release");
    await writeFixtureReleaseLibrary(isolatedPackage);
    const recipeText = await readFile(path.join(packageDirectory, "build", "recipe.json"), "utf8"), recipe = JSON.parse(recipeText);
    await writeFile(path.join(isolatedPackage, "build", "recipe.json"), recipeText);
    const release = JSON.parse(await readFile(path.join(isolatedPackage, "release.json"), "utf8"));
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    // Synthetic non-executable bytes only. This does not re-identify any real
    // historical artifact or claim a new candidate has passed acceptance.
    const expected = Buffer.from("synthetic fixture file; never executable");
    const manifest = { schemaVersion: 1, kind: "legalwork-patched-engine-distribution", status: "local-candidate-not-adopted", version: recipe.version, baseVersion: release.version,
      channel: recipe.channel, upstream: recipe.upstream, source: { patchSha256: recipe.inputs.patch.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, testReceiptSha256: recipe.inputs.testReceipt.sha256 },
      artifacts: Object.fromEntries(Object.keys(release.packages).map(target => [target, {
        archive: { filename: `opencode-${recipe.version}-${target}.tar.gz`, sha256: digest(expected), size: expected.length },
        files: Object.fromEntries([target.startsWith("windows-") ? "opencode.exe" : "opencode", "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"].map(name => [name, { sha256: digest(expected), size: expected.length }])) }])) };
    const manifestText = JSON.stringify(manifest);
    await writeFile(path.join(isolatedPackage, "derivative-release.json"), manifestText);
    const helperText = await readFile(source, "utf8");
    await writeFile(path.join(root, "candidate.mjs"), helperText.replace(/packagedCandidateManifestSha256 = "[a-f0-9]{64}"/, `packagedCandidateManifestSha256 = "${digest(manifestText)}"`));
    const resourcesPath = path.join(root, "resources");
    await mkdir(path.join(resourcesPath, "sidecars"), { recursive: true });
    const helper = await import(pathToFileURL(path.join(root, "candidate.mjs")));
    await run({ root, resourcesPath, helper, recipe });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("packaged validation rejects higher-priority aliases before normal main", () => fixture(async ({ resourcesPath, helper }) => {
  await writeFile(path.join(resourcesPath, "sidecars", "opencode-unverified-triple"), "unverified");
  let mainLoaded = false;
  await assert.rejects(async () => {
    await helper.registerPackagedCandidate({ resourcesPath });
    mainLoaded = true;
  }, /ambiguous engine alias/);
  assert.equal(mainLoaded, false);
}));

test("packaged validation rejects changed binary bytes and cannot accept a forged descriptor", () => fixture(async ({ resourcesPath, helper, recipe }) => {
  await writeFile(path.join(resourcesPath, "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode"), "unverified engine bytes");
  let mainLoaded = false;
  await assert.rejects(async () => {
    await helper.registerPackagedCandidate({ resourcesPath, candidateBuild: Object.freeze({ version: recipe.version, sha256: "0".repeat(64) }) });
    mainLoaded = true;
  }, /packaged derivative file does not match/);
  assert.equal(mainLoaded, false);
}));

test("packaged validation rejects a redirected sidecar directory", () => fixture(async ({ root, resourcesPath, helper }) => {
  await rm(path.join(resourcesPath, "sidecars"), { recursive: true });
  const redirected = path.join(root, "redirected"); await mkdir(redirected);
  await symlink(redirected, path.join(resourcesPath, "sidecars"), "dir");
  await assert.rejects(helper.registerPackagedCandidate({ resourcesPath }), /ordinary directory/);
}));
