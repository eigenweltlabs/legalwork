import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };
import { opencodeArchiveTarExecutable, opencodeReleaseTarget } from "./index.mjs";
import { verifyOpencodeCandidate } from "./candidate.mjs";

const distributions = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const binaryName = target => target.startsWith("windows-") ? "opencode.exe" : "opencode";

export async function derivativeFileSha256(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

function validateManifest(value) {
  if (![1, 2].includes(value.schemaVersion) || value.kind !== "legalwork-patched-engine-distribution" || value.status !== "local-candidate-not-adopted"
    || value.version !== recipe.version || value.baseVersion !== release.version || value.channel !== recipe.channel
    || value.upstream?.commit !== recipe.upstream.commit || value.upstream?.repository !== recipe.upstream.repository
    || value.source?.patchSha256 !== recipe.inputs.patch.sha256 || value.source?.lockfileSha256 !== recipe.inputs.lockfile.sha256
    || value.source?.testReceiptSha256 !== recipe.inputs.testReceipt.sha256) throw new Error("The derivative distribution does not identify the reviewed local source candidate and base ABI.");
  let targets = Object.keys(release.packages).sort();
  if (value.schemaVersion === 2) {
    const declared = value.scope?.targets;
    if (value.scope?.kind !== "development" || !Array.isArray(declared) || !declared.length
      || declared.some(target => typeof target !== "string" || !Object.hasOwn(release.packages, target))
      || new Set(declared).size !== declared.length) throw new Error("A scoped development distribution requires unique reviewed targets.");
    targets = [...declared].sort();
  } else if (value.scope !== undefined) throw new Error("A complete distribution cannot declare a development scope.");
  if (!value.artifacts || JSON.stringify(Object.keys(value.artifacts).sort()) !== JSON.stringify(targets)) throw new Error(value.schemaVersion === 1
    ? "The derivative distribution must preserve all twelve declared targets."
    : "The development distribution must contain exactly its declared targets.");
  for (const [target, artifact] of Object.entries(value.artifacts)) {
    if (artifact.archive?.filename !== `opencode-${value.version}-${target}.tar.gz` || !validHash(artifact.archive?.sha256)) throw new Error(`Invalid pinned derivative archive: ${target}`);
    const filenames = [binaryName(target), "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"];
    if (JSON.stringify(Object.keys(artifact.files ?? {}).sort()) !== JSON.stringify(filenames.sort())
      || filenames.some(name => !validHash(artifact.files[name]?.sha256) || !Number.isSafeInteger(artifact.files[name]?.size) || artifact.files[name].size < 0)) throw new Error(`Missing pinned derivative file identity: ${target}`);
    if (!Number.isSafeInteger(artifact.archive.size) || artifact.archive.size <= 0) throw new Error(`Invalid derivative archive size: ${target}`);
  }
}

/** The expected digest comes from the reviewed build handoff, never an
 * adjacent manifest's own checksum or a runtime environment override. */
export async function verifyDerivativeDistribution({ manifestPath, manifestSha256 }) {
  if (!validHash(manifestSha256)) throw new Error("An independently reviewed derivative manifest SHA256 is required.");
  const canonical = await realpath(manifestPath), bytes = await readFile(canonical);
  if (sha(bytes) !== manifestSha256) throw new Error("The derivative distribution manifest changed or does not match its reviewed digest.");
  return registerDistribution(JSON.parse(bytes), manifestSha256, canonical);
}

/** Compiled hosts retain the exact manifest text and an independent build pin.
 * No runtime path, environment variable or sibling checksum supplies authority. */
export async function verifyDerivativeDistributionContent({ manifestContent, manifestSha256 }) {
  if (typeof manifestContent !== "string" || !validHash(manifestSha256) || sha(manifestContent) !== manifestSha256) throw new Error("Embedded derivative manifest does not match its independent build pin.");
  return registerDistribution(JSON.parse(manifestContent), manifestSha256);
}

function registerDistribution(value, manifestSha256, manifestPath) {
  validateManifest(value);
  const descriptor = Object.freeze({ ...(manifestPath === undefined ? {} : { manifestPath }), manifestSha256, version: value.version, baseVersion: value.baseVersion,
    channel: value.channel, scope: value.schemaVersion === 1 ? "complete" : "development", targets: Object.freeze(Object.keys(value.artifacts)) });
  distributions.set(descriptor, { value, manifestPath });
  return descriptor;
}

async function selectedManifest(descriptor) {
  const registered = distributions.get(descriptor);
  if (!registered || !Object.isFrozen(descriptor)) throw new Error("An unknown derivative distribution capability cannot authorize installation.");
  if (registered.manifestPath !== undefined && sha(await readFile(registered.manifestPath)) !== descriptor.manifestSha256) throw new Error("The reviewed derivative distribution manifest changed before installation.");
  return registered.value;
}

async function regularFile(filename, allowHardLinks = false) {
  const stat = await lstat(filename);
  if (!stat.isFile() || !allowHardLinks && stat.nlink !== 1) throw new Error("Derivative artifacts must contain ordinary files, without symbolic or hard links.");
}

async function checkArchive(filename, pin) {
  await regularFile(filename, true);
  if ((await lstat(filename)).size !== pin.size || await derivativeFileSha256(filename) !== pin.sha256) throw new Error("Derivative archive integrity verification failed; preserve the mismatching input for inspection.");
}

async function tar(args) {
  const child = spawn(opencodeArchiveTarExecutable(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "", errors = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { errors += bytes.toString(); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Cannot read derivative archive: ${errors}`)));
  });
  return output;
}

async function validateInstallation(directory, target, artifact, value) {
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(Object.keys(artifact.files).sort())) throw new Error("The derivative destination contains missing or unexpected files; it will not be overwritten.");
  for (const [name, pin] of Object.entries(artifact.files)) {
    const file = path.join(directory, name); await regularFile(file);
    // Candidate inspection below hashes the executable and verifies its source
    // provenance. Avoid reading that large file twice within this one check.
    if ((await lstat(file)).size !== pin.size || name !== binaryName(target) && await derivativeFileSha256(file) !== pin.sha256) throw new Error(`Installed derivative file changed: ${name}`);
  }
  const provenance = JSON.parse(await readFile(path.join(directory, "provenance.json"), "utf8"));
  if (provenance.target !== target || provenance.version !== value.version || provenance.baseVersion !== value.baseVersion || provenance.channel !== value.channel) throw new Error("The derivative artifact target/version/channel does not match its distribution pin.");
  const candidate = await verifyOpencodeCandidate({ directory, provenanceSha256: artifact.files["provenance.json"].sha256 });
  if (candidate.sha256 !== artifact.files[binaryName(target)].sha256) throw new Error("Installed executable does not match its independent distribution pin.");
  return candidate;
}

/** Reconstruct a process-local startup descriptor from the independent host pin
 * and installed bytes. Descriptors received from another process are not trusted. */
export async function verifyInstalledDerivativeEngine({ distribution, directory, target = opencodeReleaseTarget() }) {
  const value = await selectedManifest(distribution);
  if (!Object.hasOwn(value.artifacts, target)) throw new Error(`Unsupported derivative target: ${target}`);
  const installed = path.resolve(directory);
  if (!(await lstat(installed)).isDirectory()) throw new Error("The derivative destination must be an ordinary directory; redirected paths are not accepted.");
  return validateInstallation(installed, target, value.artifacts[target], value);
}

/** Retrieve only the exact archive selected by the host's compiled pin. The
 * source URL supplies bytes, never authority. Existing corrupt cache entries
 * fail explicitly, and unpublished local candidates need no network fallback. */
export async function downloadDerivativeArchive({ distribution, cacheDirectory, downloadBaseUrl, target = opencodeReleaseTarget(), fetcher = fetch }) {
  const value = await selectedManifest(distribution);
  const artifact = value.artifacts[target];
  if (!artifact) throw new Error(`Unsupported derivative target: ${target}`);
  const generationCache = path.join(cacheDirectory, distribution.manifestSha256);
  await mkdir(generationCache, { recursive: true });
  const cached = path.join(generationCache, artifact.archive.filename);
  try { await checkArchive(cached, artifact.archive); return cached; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const base = new URL(downloadBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")) throw new Error("The compiled engine download base must be a plain HTTPS directory URL.");
  const response = await fetcher(new URL(artifact.archive.filename, base));
  if (!response.ok || !response.body) throw new Error(`Selected OpenCode archive download failed (${response.status}).`);
  const temporary = `${cached}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      for await (const bytes of response.body) await handle.writeFile(bytes);
    } finally { await handle.close(); }
    await checkArchive(temporary, artifact.archive);
    try { await link(temporary, cached); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await checkArchive(cached, artifact.archive);
    return cached;
  } finally { await rm(temporary, { force: true }); }
}

/** Local/offline assembly only. Cache entries are always reverified; a corrupt
 * cache fails explicitly. No download URL, package manager or network fallback. */
export async function installLocalDerivativeEngine({ distribution, archiveDirectory, cacheDirectory, destinationDirectory, target = opencodeReleaseTarget() }) {
  const value = await selectedManifest(distribution);
  if (!Object.hasOwn(value.artifacts, target)) throw new Error(`Unsupported derivative target: ${target}`);
  const artifact = value.artifacts[target], destination = path.resolve(destinationDirectory);
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error("The derivative destination must be an ordinary directory; redirected paths are not accepted.");
    return { candidateBuild: await validateInstallation(destination, target, artifact, value), target, reused: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const generationCache = path.join(cacheDirectory, distribution.manifestSha256);
  await mkdir(generationCache, { recursive: true });
  const cached = path.join(generationCache, artifact.archive.filename);
  try { await checkArchive(cached, artifact.archive); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!archiveDirectory) throw new Error("The pinned derivative archive is not cached; supply its reviewed local archive directory.");
    const source = path.join(await realpath(archiveDirectory), artifact.archive.filename);
    await checkArchive(source, artifact.archive);
    const temporary = `${cached}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary); await checkArchive(temporary, artifact.archive);
      try { await link(temporary, cached); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { await rm(temporary, { force: true }); }
    await checkArchive(cached, artifact.archive);
  }
  const names = (await tar(["-tzf", cached])).trimEnd().split(/\r?\n/);
  if (JSON.stringify(names.sort()) !== JSON.stringify(Object.keys(artifact.files).sort())) throw new Error("The pinned derivative archive contains unexpected, duplicate or unsafe paths.");
  await mkdir(path.dirname(destination), { recursive: true });
  const staged = await mkdtemp(path.join(path.dirname(destination), ".legalwork-engine-"));
  try {
    await tar(["-xzf", cached, "-C", staged, ...names]);
    await validateInstallation(staged, target, artifact, value);
    await chmod(path.join(staged, binaryName(target)), 0o755);
    try { await rename(staged, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    return { candidateBuild: await validateInstallation(destination, target, artifact, value), target, reused: false };
  } finally { await rm(staged, { recursive: true, force: true }); }
}
