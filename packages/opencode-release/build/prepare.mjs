import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeArchiveTarExecutable, opencodeReleaseTarget } from "../index.mjs";
import { derivativeFileSha256, verifyDerivativeDistribution } from "../derivative.mjs";
import { recipePolicySha256, sourceBuildPolicy, sourcePolicySha256, validateBuildSelection } from "../build-policy.mjs";
import { sha256, verifyInputs } from "./candidate.mjs";
import { developerIdRequirement, macEntitlementsSha256 } from "./mac-signing.mjs";
import { buildOpencodeDistribution, validateSourceBuildRequest } from "./producer.mjs";
import recipe from "./recipe.json" with { type: "json" };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(packageRoot, "../..");
const inputs = ["selection.json", "release.json", "build/recipe.json", "build/producer.mjs", "build/prepare.mjs", "build/candidate.mjs", "build/distribution.mjs", "build/mac-signing.mjs", "build/macos-entitlements.plist", "build-policy.mjs", "candidate.mjs", "derivative.mjs", "index.mjs"];
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function sourceBuildIdentity({ mode, targets = mode === "production" ? recipe.targets : [opencodeReleaseTarget()] }) {
  const selected = validateSourceBuildRequest({ mode, targets });
  await verifyInputs(recipe);
  const files = {};
  for (const name of inputs) files[name] = sha256(await readFile(path.join(packageRoot, name)));
  const identity = { schemaVersion: 1, mode, targets: selected, sourcePolicySha256, recipeSha256: recipePolicySha256, files,
    host: `${process.platform}-${process.arch}`, compiler: recipe.toolchain.executables[`${process.platform}-${process.arch}`],
    signer: mode === "production" ? sourceBuildPolicy.productionMacSigner : "development-ad-hoc" };
  return { ...identity, sourceKey: sha256(JSON.stringify(identity)) };
}

async function regularFile(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`An ordinary, unlinked build input is required: ${filename}`);
  return metadata;
}

async function readJson(filename) { await regularFile(filename); return JSON.parse(await readFile(filename, "utf8")); }
async function exists(filename) { try { await lstat(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function ordinaryDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || await realpath(directory) !== path.resolve(directory)) throw new Error(`Build preparation directory cannot be redirected: ${directory}`);
}

/** A stale preparation lock is retained for inspection, never stolen by PID. */
export async function withPreparationLock(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await ordinaryDirectory(directory);
  const lock = path.join(directory, ".preparing.lock"), token = `${process.pid}:${randomUUID()}\n`;
  await writeFile(lock, token, { flag: "wx", mode: 0o600 });
  try { return await action(); }
  finally {
    if (await readFile(lock, "utf8") !== token) throw new Error("Engine preparation lock ownership changed; refusing to remove another owner's lock.");
    await unlink(lock);
  }
}

async function command(executable, args) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes.toString(); });
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} failed (${signal ?? code}): ${stderr}`)));
  });
  return stdout;
}

/** Independent archive/provenance pins are checked against current source policy. */
export function validatePreparedProvenance(value, target, mode, files) {
  if (value.target !== target || value.version !== recipe.version || value.baseVersion !== recipe.baseVersion || value.channel !== recipe.channel
    || value.kind !== recipe.kind || value.upstream?.commit !== recipe.upstream.commit || value.upstream?.repository !== recipe.upstream.repository
    || value.compiler?.version !== recipe.toolchain.bun || !Object.values(recipe.toolchain.executables).some(pin => pin.sha256 === value.compiler?.sha256)
    || value.build?.wrapperSha256 !== files["build/candidate.mjs"] || value.build?.signingHelperSha256 !== files["build/mac-signing.mjs"]
    || value.build?.signingEntitlementsSha256 !== macEntitlementsSha256 || value.build?.recipeSha256 !== files["build/recipe.json"]) {
    throw new Error(`Prepared engine provenance does not match current source/compiler/build helpers: ${target}`);
  }
  for (const [name, pin] of Object.entries(recipe.inputs)) if (value.inputs?.[name]?.sha256 !== pin.sha256) throw new Error(`Prepared engine source input differs: ${name}`);
  if (value.buildStatus !== recipe.buildStatus || value.testEvidence?.receiptSha256 !== recipe.inputs.testReceipt.sha256
    || value.testEvidence?.patchSha256 !== recipe.inputs.patch.sha256 || value.testEvidence?.lockfileSha256 !== recipe.inputs.lockfile.sha256) throw new Error("Prepared engine does not retain the reviewed source-test evidence.");
  if (mode === "production" && target.startsWith("darwin-")) {
    const evidence = value.binary?.signingEvidence, signer = sourceBuildPolicy.productionMacSigner;
    if (evidence?.mode !== "developer-id" || evidence.identitySha1 !== signer.identitySha1 || evidence.certificateSha256 !== signer.certificateSha256
      || evidence.teamId !== signer.teamId || evidence.entitlementsSha256 !== macEntitlementsSha256 || evidence.hardenedRuntime !== true
      || evidence.verifiedRequirement !== developerIdRequirement(signer.teamId) || !evidence.timestamp || /^(none|not set)$/i.test(evidence.timestamp)
      || evidence.afterSha256 !== value.binary.sha256 || evidence.beforeSha256 !== value.build.buildSha256) throw new Error(`Production engine lacks exact pre-pin signing evidence: ${target}`);
  }
}

async function verifyArchives({ manifestPath, manifestSha256, archiveDirectory, mode, identity }) {
  await regularFile(manifestPath); await ordinaryDirectory(archiveDirectory);
  const distribution = await verifyDerivativeDistribution({ manifestPath, manifestSha256 });
  const content = await readFile(manifestPath, "utf8"), manifest = JSON.parse(content);
  if (identity.targets.some(target => !distribution.targets.includes(target)) || mode === "production" && distribution.scope !== "complete") throw new Error("Prepared distribution does not cover the required targets and signing mode.");
  // Verify every supplied artifact, not only the current host target.
  for (const [target, artifact] of Object.entries(manifest.artifacts)) {
    const archive = path.join(archiveDirectory, artifact.archive.filename), metadata = await regularFile(archive);
    if (metadata.size !== artifact.archive.size || await derivativeFileSha256(archive) !== artifact.archive.sha256) throw new Error(`Prepared engine archive is corrupt: ${target}`);
    const names = (await command(opencodeArchiveTarExecutable(), ["-tzf", archive])).trim().split(/\r?\n/).sort();
    assert.deepEqual(names, Object.keys(artifact.files).sort(), "Prepared archive must retain exactly its five pinned regular members");
    const provenanceText = await command(opencodeArchiveTarExecutable(), ["-xOzf", archive, "provenance.json"]);
    if (sha256(provenanceText) !== artifact.files["provenance.json"].sha256) throw new Error("Prepared engine provenance bytes differ from the independent manifest pin.");
    const provenance = JSON.parse(provenanceText);
    const binary = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    if (provenance.binary?.sha256 !== artifact.files[binary].sha256) throw new Error("Prepared archive and binary provenance disagree.");
    validatePreparedProvenance(provenance, target, mode, identity.files);
    if (mode === "production" && process.platform === "darwin" && target.startsWith("darwin-")) {
      const directory = await mkdtemp(path.join(tmpdir(), "legalwork-engine-signature-"));
      // Only our fresh temporary extraction is removed; corrupt archives remain.
      try {
        await command(opencodeArchiveTarExecutable(), ["-xzf", archive, "-C", directory]);
        const executable = path.join(directory, binary);
        await regularFile(executable);
        if (await derivativeFileSha256(executable) !== artifact.files[binary].sha256) throw new Error("Production signature input changed during extraction.");
        const signer = sourceBuildPolicy.productionMacSigner;
        await command("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", `=${developerIdRequirement(signer.teamId)}`, executable]);
        await command("/usr/bin/codesign", ["--display", `--extract-certificates=${path.join(directory, "leaf-")}`, executable]);
        const certificate = await readFile(path.join(directory, "leaf-0"));
        if (sha256(certificate) !== signer.certificateSha256 || createHash("sha1").update(certificate).digest("hex") !== signer.identitySha1) throw new Error("Actual cached production certificate differs from the exact committed leaf pins.");
      } finally { await rm(directory, { recursive: true }); }
    }
  }
  if (sha256(await readFile(manifestPath)) !== manifestSha256) throw new Error("Prepared manifest changed during verification.");
  return content;
}

function locations(options) {
  const outputDirectory = path.resolve(options.outputDirectory ?? packageRoot);
  return { outputDirectory, generated: path.join(outputDirectory, "generated"), selectionPath: path.join(outputDirectory, "generated/selection.json"), receiptPath: path.join(outputDirectory, "generated/receipt.json"), cacheDirectory: path.resolve(options.cacheDirectory ?? path.join(repository, ".legalwork/opencode-build")) };
}

async function readPrepared(options, identity, locations, held = false) {
  if (!held && await exists(path.join(locations.generated, ".preparing.lock"))) throw new Error("Engine preparation is currently owned by another build.");
  const receipt = await readJson(locations.receiptPath), selection = await readJson(locations.selectionPath);
  if (receipt.sourceKey !== identity.sourceKey) throw new Error("Prepared engine source is stale; run engine preparation for this source/mode/target set.");
  validateBuildSelection(selection);
  if (receipt.schemaVersion !== 1 || receipt.kind !== "legalwork-source-preparation" || receipt.selectionSha256 !== sha256(await readFile(locations.selectionPath))
    || receipt.manifestSha256 !== selection.manifestSha256 || selection.build.sourceKey !== identity.sourceKey || selection.build.mode !== options.mode
    || !validHash(receipt.manifestSha256)) throw new Error("Prepared selector and its independently retained receipt disagree.");
  const manifestContent = await verifyArchives({ ...receipt, mode: options.mode, identity });
  if (selection.manifestContent !== manifestContent) throw new Error("Prepared selector does not retain the verified manifest.");
  if ((await sourceBuildIdentity({ mode: options.mode, targets: identity.targets })).sourceKey !== identity.sourceKey) throw new Error("Source inputs changed during prepared-engine verification.");
  if (!held && await exists(path.join(locations.generated, ".preparing.lock"))) throw new Error("Engine preparation changed while checking its prior receipt.");
  return { ...locations, sourceKey: identity.sourceKey, manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256, archiveDirectory: receipt.archiveDirectory, targets: identity.targets, mode: options.mode };
}

/** Direct starts and skip-prep paths only validate; they never rebuild or mutate. */
async function priorIdentity(options, paths) {
  const requested = validateSourceBuildRequest(options);
  const prior = await readJson(paths.receiptPath);
  if (prior.mode !== options.mode || !Array.isArray(prior.targets) || requested.some(target => !prior.targets.includes(target))) return undefined;
  const identity = await sourceBuildIdentity({ ...options, targets: prior.targets });
  return prior.sourceKey === identity.sourceKey ? identity : undefined;
}

export async function checkPreparedOpencodeEngine(options) {
  const paths = locations(options);
  if (await exists(path.join(paths.generated, ".preparing.lock"))) throw new Error("Engine preparation is currently owned by another build.");
  const identity = await priorIdentity(options, paths);
  if (!identity) throw new Error("Prepared engine source/mode/target coverage is stale; run engine preparation.");
  return readPrepared(options, identity, paths);
}

/** Publish only a fully verified source build, under one owned preparation lock. */
export async function prepareOpencodeEngine(options) {
  let identity = await sourceBuildIdentity(options);
  const paths = locations(options);
  validateSourceBuildRequest(options);
  if ((options.distributionDirectory === undefined) !== (options.manifestSha256 === undefined)) throw new Error("Distribution reuse requires its directory and independent manifest SHA256 together.");
  return withPreparationLock(paths.generated, async () => {
    const hasSelector = await exists(paths.selectionPath), hasReceipt = await exists(paths.receiptPath);
    if (hasSelector !== hasReceipt) throw new Error("Incomplete prior engine publication; preserve it for inspection before preparing again.");
    if (hasReceipt && options.distributionDirectory === undefined) {
      const prior = await priorIdentity(options, paths);
      if (prior) return readPrepared(options, prior, paths, true);
    }
    let built;
    if (options.distributionDirectory !== undefined) {
      const directory = await realpath(options.distributionDirectory);
      built = { manifestPath: path.join(directory, "derivative-release.json"), archiveDirectory: path.join(directory, "archives"), manifestSha256: options.manifestSha256 };
      const supplied = await verifyDerivativeDistribution(built);
      if (identity.targets.some(target => !supplied.targets.includes(target))) throw new Error("Supplied distribution does not cover the requested targets.");
      identity = await sourceBuildIdentity({ ...options, targets: [...supplied.targets] });
    } else {
      await mkdir(paths.cacheDirectory, { recursive: true, mode: 0o700 }); await ordinaryDirectory(paths.cacheDirectory);
      // Orphaned cache entries cannot nominate their own manifest digest.
      const attempt = path.join(paths.cacheDirectory, `${identity.sourceKey}-${randomUUID()}`);
      built = await buildOpencodeDistribution({ outputDirectory: attempt, mode: options.mode, targets: identity.targets, macSigning: options.macSigning });
    }
    const manifestContent = await verifyArchives({ ...built, mode: options.mode, identity });
    const selection = { schemaVersion: 1, kind: "derivative", version: recipe.version, baseVersion: recipe.baseVersion, manifestContent, manifestSha256: built.manifestSha256,
      build: { schemaVersion: 1, mode: options.mode, sourcePolicySha256, recipeSha256: recipePolicySha256, sourceKey: identity.sourceKey } };
    validateBuildSelection(selection);
    if ((await sourceBuildIdentity({ mode: options.mode, targets: identity.targets })).sourceKey !== identity.sourceKey) throw new Error("Source inputs changed before prepared-engine publication.");
    const selectionBytes = JSON.stringify(selection, null, 2) + "\n";
    const receipt = { schemaVersion: 1, kind: "legalwork-source-preparation", sourceKey: identity.sourceKey, mode: options.mode, targets: identity.targets,
      sourcePolicySha256, recipeSha256: recipePolicySha256, sourceInputs: identity.files, manifestPath: built.manifestPath, archiveDirectory: built.archiveDirectory,
      manifestSha256: built.manifestSha256, selectionSha256: sha256(selectionBytes) };
    const suffix = randomUUID(), temporarySelection = path.join(paths.generated, `.selection-${suffix}.json`), temporaryReceipt = path.join(paths.generated, `.receipt-${suffix}.json`);
    await writeFile(temporarySelection, selectionBytes, { flag: "wx", mode: 0o644 });
    await writeFile(temporaryReceipt, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporaryReceipt, paths.receiptPath); await rename(temporarySelection, paths.selectionPath);
    return { ...paths, ...built, sourceKey: identity.sourceKey, targets: identity.targets, mode: options.mode };
  });
}
