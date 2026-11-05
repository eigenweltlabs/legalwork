import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import recipe from "../../packages/opencode-release/build/recipe.json" with { type: "json" };
import { derivativeReuseInputs, verifyReusedDerivative } from "./reuse-opencode-derivative.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
test("producer reuse is opt-in and requires a run ID plus an independent digest", () => {
  assert.equal(derivativeReuseInputs(), false);
  assert.equal(derivativeReuseInputs("40359354246", "a".repeat(64)), true);
  for (const args of [["40359354246", ""], ["", "a".repeat(64)], ["0", "a".repeat(64)], ["../40359354246", "a".repeat(64)], ["40359354246\n", "a".repeat(64)], ["40359354246", "A".repeat(64)]]) {
    assert.throws(() => derivativeReuseInputs(...args), /together/);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-ci-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "archives"));
  const manifest = { schemaVersion: 1, kind: "legalwork-patched-engine-distribution", status: "local-candidate-not-adopted",
    version: recipe.version, baseVersion: recipe.baseVersion, channel: recipe.channel, upstream: recipe.upstream,
    source: { patchSha256: recipe.inputs.patch.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, testReceiptSha256: recipe.inputs.testReceipt.sha256 }, artifacts: {} };
  // This verifier checks complete pinned archive bytes. The unchanged installer
  // separately checks tar members, per-file provenance and native architecture.
  for (const target of recipe.targets) {
    const bytes = Buffer.from(`synthetic archive integrity fixture: ${target}`), filename = `opencode-${recipe.version}-${target}.tar.gz`;
    await writeFile(path.join(root, "archives", filename), bytes);
    const names = [target.startsWith("windows-") ? "opencode.exe" : "opencode", "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"];
    manifest.artifacts[target] = { archive: { filename, size: bytes.length, sha256: sha(bytes) }, files: Object.fromEntries(names.map(name => [name, { size: 1, sha256: "b".repeat(64) }])) };
  }
  const save = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(path.join(root, "derivative-release.json"), bytes);
    return sha(bytes);
  };
  return { root, manifest, save, pin: await save() };
}

test("all twelve archives and the current reviewed source manifest are required", async t => {
  const f = await fixture(t), result = await verifyReusedDerivative(f.root, f.pin);
  assert.equal(result.targets, 12);
  assert.equal(result.manifestSha256, f.pin);
  assert.deepEqual(result.archives.map(x => x.target).sort(), [...recipe.targets].sort());
  await assert.rejects(verifyReusedDerivative(f.root, "a".repeat(64)), /digest/);
  f.manifest.upstream = { ...recipe.upstream, tag: "unreviewed-tag" };
  await assert.rejects(verifyReusedDerivative(f.root, await f.save()), /upstream identity/);
  f.manifest.upstream = recipe.upstream;
  f.manifest.source.patchSha256 = "c".repeat(64);
  await assert.rejects(verifyReusedDerivative(f.root, await f.save()), /reviewed local source/);
});

test("a complete manifest cannot authorize a missing or additional target archive", async t => {
  const f = await fixture(t), name = f.manifest.artifacts[recipe.targets[0]].archive.filename;
  await writeFile(path.join(f.root, "archives", "unreviewed.tar.gz"), "extra");
  await assert.rejects(verifyReusedDerivative(f.root, f.pin), /exactly the twelve/);
  await rm(path.join(f.root, "archives", "unreviewed.tar.gz"));
  await rm(path.join(f.root, "archives", name));
  await assert.rejects(verifyReusedDerivative(f.root, f.pin), /exactly the twelve/);
  delete f.manifest.artifacts[recipe.targets[0]];
  await assert.rejects(verifyReusedDerivative(f.root, await f.save()), /all twelve/);
});

test("archive size, full hash and ordinary-file checks are all enforced", async t => {
  const f = await fixture(t), name = f.manifest.artifacts[recipe.targets[0]].archive.filename, file = path.join(f.root, "archives", name), original = await readFile(file);
  await writeFile(file, original.subarray(1));
  await assert.rejects(verifyReusedDerivative(f.root, f.pin), /integrity differs/);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  await writeFile(file, changed);
  await assert.rejects(verifyReusedDerivative(f.root, f.pin), /integrity differs/);
  await rm(file); await mkdir(file);
  await assert.rejects(verifyReusedDerivative(f.root, f.pin), /integrity differs/);
});
