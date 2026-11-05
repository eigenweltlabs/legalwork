import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeReleaseTarget } from "../index.mjs";
import { sourceBuildPolicy } from "../build-policy.mjs";
import { sha256 } from "./candidate.mjs";
import { writeCandidateArchive } from "./distribution.mjs";
import { checkPreparedOpencodeEngine, prepareOpencodeEngine, sourceBuildIdentity, validatePreparedProvenance, withPreparationLock } from "./prepare.mjs";
import { developerIdRequirement, macEntitlementsSha256 } from "./mac-signing.mjs";
import recipe from "./recipe.json" with { type: "json" };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(targets = [opencodeReleaseTarget()]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-source-prepare-")));
  const outputDirectory = path.join(root, "package"), cacheDirectory = path.join(root, "cache"), distributionDirectory = path.join(root, "distribution");
  await mkdir(path.join(distributionDirectory, "archives"), { recursive: true });
  const identity = await sourceBuildIdentity({ mode: "development", targets });
  const manifest = { schemaVersion: targets.length === recipe.targets.length ? 1 : 2, kind: "legalwork-patched-engine-distribution", status: "local-candidate-not-adopted",
    ...(targets.length === recipe.targets.length ? {} : { scope: { kind: "development", targets: [...targets].sort() } }),
    version: recipe.version, baseVersion: recipe.baseVersion, channel: recipe.channel, upstream: recipe.upstream,
    source: { patchSha256: recipe.inputs.patch.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, testReceiptSha256: recipe.inputs.testReceipt.sha256 }, artifacts: {} };
  let provenance;
  for (const target of targets) {
    const directory = path.join(root, target); await mkdir(directory);
    const binary = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    const bytes = Buffer.from(`metadata-only source preparation fixture: ${target}`);
    provenance = { ...recipe, target, compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables[`${process.platform}-${process.arch}`].sha256 },
      build: { wrapperSha256: identity.files["build/candidate.mjs"], signingHelperSha256: identity.files["build/mac-signing.mjs"], signingEntitlementsSha256: macEntitlementsSha256, recipeSha256: identity.files["build/recipe.json"], buildSha256: sha256(bytes) },
      binary: { filename: binary, sha256: sha256(bytes), signing: "not-signed-by-this-build" } };
    const contents = { [binary]: bytes, "LICENSE": Buffer.from("fixture license"), "NOTICE": Buffer.from("fixture notice"), "provenance.json": Buffer.from(JSON.stringify(provenance) + "\n"), "SHA256SUMS": Buffer.from("fixture checksums") };
    const files = {};
    for (const [name, content] of Object.entries(contents)) { await writeFile(path.join(directory, name), content); files[name] = { size: content.length, sha256: sha256(content) }; }
    const filename = `opencode-${recipe.version}-${target}.tar.gz`, archive = path.join(distributionDirectory, "archives", filename);
    await writeCandidateArchive({ directory, filenames: Object.keys(files), destination: archive, epoch: 1 });
    const archiveBytes = await readFile(archive);
    manifest.artifacts[target] = { archive: { filename, size: archiveBytes.length, sha256: sha256(archiveBytes) }, files, signing: provenance.binary.signing };
  }
  const manifestPath = path.join(distributionDirectory, "derivative-release.json");
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
  return { root, outputDirectory, cacheDirectory, distributionDirectory, manifestSha256: sha256(await readFile(manifestPath)), mode: "development", targets, identity, provenance, manifest };
}
const options = value => ({ mode: value.mode, targets: value.targets, outputDirectory: value.outputDirectory, cacheDirectory: value.cacheDirectory });

test("explicit handoff publishes a selector only after archive/provenance verification; check is read-only", async () => {
  const f = await fixture();
  try {
    const result = await prepareOpencodeEngine(f), before = await readFile(result.selectionPath), receipt = await readFile(result.receiptPath), metadata = await stat(result.selectionPath);
    const checked = await checkPreparedOpencodeEngine(options(f));
    assert.equal(checked.manifestSha256, f.manifestSha256);
    assert.deepEqual(await readFile(result.selectionPath), before);
    assert.deepEqual(await readFile(result.receiptPath), receipt);
    assert.equal((await stat(result.selectionPath)).mtimeMs, metadata.mtimeMs);
    assert.equal(JSON.parse(before).build.sourceKey, result.sourceKey);
    await assert.rejects(prepareOpencodeEngine({ ...f, manifestSha256: "0".repeat(64) }), /changed|digest/);
    assert.deepEqual(await readFile(result.selectionPath), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("verified complete CI selector survives a host-subset preparation byte-identically", async () => {
  const f = await fixture(recipe.targets);
  try {
    const first = await prepareOpencodeEngine(f), before = await readFile(first.selectionPath);
    const subset = { ...options(f), targets: [opencodeReleaseTarget()] };
    const reused = await prepareOpencodeEngine(subset), checked = await checkPreparedOpencodeEngine(subset);
    assert.equal(reused.sourceKey, first.sourceKey); assert.equal(checked.sourceKey, first.sourceKey);
    assert.deepEqual(reused.targets, [...recipe.targets].sort());
    assert.deepEqual(await readFile(first.selectionPath), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a corrupt cached archive fails explicitly and is neither rebuilt nor overwritten", async () => {
  const f = await fixture();
  try {
    const first = await prepareOpencodeEngine(f), before = await readFile(first.selectionPath);
    const target = f.targets[0], archive = path.join(first.archiveDirectory, f.manifest.artifacts[target].archive.filename);
    const corrupt = Buffer.concat([await readFile(archive), Buffer.from("corrupt")]); await writeFile(archive, corrupt);
    await assert.rejects(checkPreparedOpencodeEngine(options(f)), /archive is corrupt/);
    await assert.rejects(prepareOpencodeEngine(options(f)), /archive is corrupt/);
    assert.deepEqual(await readFile(archive), corrupt); assert.deepEqual(await readFile(first.selectionPath), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing independent receipt, stale source key and mode mismatch cannot self-pin cache", async () => {
  const f = await fixture();
  try {
    await mkdir(f.cacheDirectory);
    await writeFile(path.join(f.cacheDirectory, "self-pinned-manifest.json"), JSON.stringify(f.manifest));
    await assert.rejects(checkPreparedOpencodeEngine(options(f)), { code: "ENOENT" });
    const first = await prepareOpencodeEngine(f), before = await readFile(first.selectionPath);
    const receipt = JSON.parse(await readFile(first.receiptPath, "utf8"));
    await writeFile(first.receiptPath, JSON.stringify({ ...receipt, sourceKey: "0".repeat(64) }));
    await assert.rejects(checkPreparedOpencodeEngine(options(f)), /stale/);
    await writeFile(first.receiptPath, JSON.stringify(receipt));
    await assert.rejects(checkPreparedOpencodeEngine({ ...options(f), mode: "production" }), /complete shipped target matrix|stale/);
    await rm(first.receiptPath);
    await assert.rejects(prepareOpencodeEngine(options(f)), /Incomplete prior engine publication/);
    assert.deepEqual(await readFile(first.selectionPath), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("owned preparation lock excludes overlap, releases on failure, and never steals a replacement lock", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-prepare-lock-")));
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try {
    const first = withPreparationLock(root, async () => { entered(); await held; }); await ready;
    await assert.rejects(withPreparationLock(root, async () => assert.fail("overlap entered")), { code: "EEXIST" });
    release(); await first;
    await assert.rejects(withPreparationLock(root, async () => { throw new Error("producer failed"); }), /producer failed/);
    await assert.rejects(withPreparationLock(root, async () => { await writeFile(path.join(root, ".preparing.lock"), "new owner\n"); }), /lock ownership changed/);
    assert.equal(await readFile(path.join(root, ".preparing.lock"), "utf8"), "new owner\n");
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

test("source provenance cannot substitute another compiler/helper or ad-hoc production Mac signing", async () => {
  const f = await fixture();
  try {
    validatePreparedProvenance(f.provenance, f.targets[0], "development", f.identity.files);
    assert.throws(() => validatePreparedProvenance({ ...f.provenance, compiler: { version: recipe.toolchain.bun, sha256: "0".repeat(64) } }, f.targets[0], "development", f.identity.files), /source\/compiler/);
    assert.throws(() => validatePreparedProvenance({ ...f.provenance, build: { ...f.provenance.build, wrapperSha256: "0".repeat(64) } }, f.targets[0], "development", f.identity.files), /source\/compiler/);
    const mac = { ...f.provenance, target: "darwin-arm64" };
    assert.throws(() => validatePreparedProvenance(mac, "darwin-arm64", "production", f.identity.files), /pre-pin signing/);
    const signer = sourceBuildPolicy.productionMacSigner;
    const evidence = { ...signer, hardenedRuntime: true, timestamp: "fixture-only", entitlementsSha256: macEntitlementsSha256, verifiedRequirement: developerIdRequirement(signer.teamId), afterSha256: mac.binary.sha256, beforeSha256: mac.build.buildSha256 };
    validatePreparedProvenance({ ...mac, binary: { ...mac.binary, signingEvidence: evidence } }, "darwin-arm64", "production", f.identity.files);
    assert.throws(() => validatePreparedProvenance({ ...mac, binary: { ...mac.binary, signingEvidence: { ...evidence, certificateSha256: "0".repeat(64) } } }, "darwin-arm64", "production", f.identity.files), /pre-pin signing/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
