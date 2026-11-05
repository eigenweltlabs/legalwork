import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeRelease, opencodeReleaseTarget } from "../index.mjs";
import { verifyOpencodeCandidate } from "../candidate.mjs";
import { macSigningBuildInputs, signMacEngine, validateMacSigningConfiguration } from "./mac-signing.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../..");
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function validateRecipe(recipe) {
  if (recipe.schemaVersion !== 1 || recipe.kind !== "legalwork-patched-source-build"
    || recipe.baseVersion !== opencodeRelease.version || !recipe.version.startsWith(`${recipe.baseVersion}-legalwork.`)
    || recipe.version === opencodeRelease.version || recipe.channel !== "legalwork") throw new Error("A patched engine must have a distinct LegalWork identity and its official base version.");
  if (!/^[a-f0-9]{40}$/.test(recipe.upstream?.commit) || recipe.upstream.repository !== "https://github.com/anomalyco/opencode.git") throw new Error("The exact upstream source identity is required.");
  if (JSON.stringify([...recipe.targets].sort()) !== JSON.stringify(Object.keys(opencodeRelease.packages).sort())) throw new Error("The patched recipe must retain the complete official target matrix.");
  for (const name of ["patch", "lockfile", "rootPackage", "testReceipt"]) {
    if (!recipe.inputs?.[name]?.path || !/^[a-f0-9]{64}$/.test(recipe.inputs[name].sha256)) throw new Error(`Missing pinned build input: ${name}`);
  }
}

/** Preserve relative dependency links; absolute workspace links must resolve
 * inside the independent build copy rather than the tested source checkout. */
export async function localizeDependencyLinks(root, preparedSource, source) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) { await localizeDependencyLinks(filename, preparedSource, source); continue; }
    if (!entry.isSymbolicLink()) continue;
    const target = await readlink(filename);
    if (path.isAbsolute(target)) {
      const relative = path.relative(preparedSource, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A prepared dependency link escapes the reviewed source checkout.");
      await unlink(filename);
      await symlink(path.relative(path.dirname(filename), path.join(source, relative)), filename);
    } else {
      const relative = path.relative(source, path.resolve(path.dirname(filename), target));
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A prepared dependency link escapes the independent build checkout.");
    }
  }
}

export async function verifyInputs(recipe, root = repository) {
  validateRecipe(recipe);
  const inputs = {};
  for (const [name, pin] of Object.entries(recipe.inputs)) {
    const source = path.resolve(root, pin.path), relative = path.relative(root, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Build input escapes the reviewed repository.");
    const bytes = await readFile(source);
    if (sha256(bytes) !== pin.sha256) throw new Error(`Pinned build input changed: ${name}`);
    inputs[name] = bytes;
  }
  return inputs;
}

export function verifyCompiler(recipe, bytes, host = `${process.platform}-${process.arch}`) {
  const pin = recipe.toolchain.executables?.[host];
  if (!pin) throw new Error(`A reviewed Bun compiler package/hash is required for builder ${host}.`);
  if (sha256(bytes) !== pin.sha256) throw new Error("The compiler executable does not match its reviewed official Bun package.");
}

export function assertBuildReady(recipe) {
  if (recipe.buildStatus !== "tested-source-lock" || recipe.testEvidence?.lockfileSha256 !== recipe.inputs.lockfile.sha256
    || recipe.testEvidence?.patchSha256 !== recipe.inputs.patch.sha256 || recipe.testEvidence?.receiptSha256 !== recipe.inputs.testReceipt.sha256
    || recipe.testEvidence?.bun !== recipe.toolchain.bun) throw new Error("Candidate compilation is held until the exact source patch and frozen upstream dependency graph pass their pinned-runtime tests.");
}

/** One build owns a prepared staging tree at a time; a stale lock is retained
 * for explicit inspection instead of risking concurrent native asset writes. */
export async function withBuildStagingLock(source, action) {
  const lock = path.join(source, ".legalwork-candidate-build.lock");
  await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try { return await action(); }
  finally { await unlink(lock); }
}

/** Index new files as well as edits so the source comparison covers the complete patch. */
export async function applyReviewedPatch(source, patch) {
  await run("git", ["apply", "--check", "--index", patch], { cwd: source });
  await run("git", ["apply", "--index", patch], { cwd: source });
}

/** Git's transport preserves shallow boundaries when the prepared source is a linked worktree. */
export async function cloneReviewedSource(prepared, destination) {
  await run("git", ["clone", "--config", "core.autocrlf=false", "--config", "core.eol=lf", "--no-local", "--no-checkout", prepared, destination]);
}

function environment() {
  const keys = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "COMSPEC", "PNPM_HOME", "COREPACK_HOME", "CI", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  return Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function run(command, args, { cwd, env, capture = false } = {}) {
  const child = spawn(command, args, { cwd, env: env ?? environment(), stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
  let output = "", errors = "";
  child.stdout?.on("data", bytes => { output += bytes.toString(); });
  child.stderr?.on("data", bytes => { errors += bytes.toString(); });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})${errors ? `: ${errors}` : ""}`)));
    });
    return output.trim();
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

export async function buildCandidate({ output, bun, target = opencodeReleaseTarget(), preparedSource, reuseArtifact, reuseProvenanceSha256, macSigning }) {
  validateMacSigningConfiguration(macSigning);
  macSigning = macSigning === undefined ? undefined : Object.freeze({ ...macSigning });
  if (macSigning && target.startsWith("darwin-") && process.platform !== "darwin") throw new Error("Production Mac engine signing requires the reviewed macOS builder.");
  const wrapperBytes = await readFile(fileURLToPath(import.meta.url));
  const signingInputs = await macSigningBuildInputs();
  const recipeBytes = await readFile(path.join(directory, "recipe.json"));
  const recipe = JSON.parse(recipeBytes);
  const inputs = await verifyInputs(recipe);
  assertBuildReady(recipe);
  if (!recipe.targets.includes(target)) throw new Error(`Unreviewed build target: ${target}`);
  const runtime = path.resolve(bun);
  if (!/^bun(?:\.exe)?$/.test(path.basename(runtime))) throw new Error("--bun must name the pinned Bun executable (bun or bun.exe), so nested upstream build commands use that same runtime.");
  verifyCompiler(recipe, await readFile(runtime));
  const bunVersion = await run(runtime, ["--version"], { capture: true });
  if (bunVersion !== recipe.toolchain.bun) throw new Error(`Pinned build requires Bun ${recipe.toolchain.bun}; received ${bunVersion}.`);
  const prepared = path.resolve(preparedSource);
  if (await run("git", ["rev-parse", "HEAD"], { cwd: prepared, capture: true }) !== recipe.upstream.commit) throw new Error("The prepared source checkout is not the reviewed upstream commit.");
  for (const [name, filename] of [["rootPackage", "package.json"], ["lockfile", "bun.lock"]]) {
    if (sha256(await readFile(path.join(prepared, filename))) !== recipe.inputs[name].sha256) throw new Error(`The tested official build input changed: ${filename}`);
  }
  if (Boolean(reuseArtifact) !== Boolean(reuseProvenanceSha256)) throw new Error("Staging reuse requires its independently reviewed candidate artifact and provenance SHA256 together.");
  const previous = reuseArtifact ? await verifyOpencodeCandidate({ directory: reuseArtifact, provenanceSha256: reuseProvenanceSha256 }) : undefined;
  const reused = previous ? await realpath(path.resolve(previous.directory, "..", "source")) : undefined;
  if (previous && reused !== path.resolve(previous.directory, "..", "source")) throw new Error("The reviewed candidate staging source cannot be redirected through a symlink.");
  // An existing directory is never recursively removed by this wrapper.
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  const evidence = path.join(destination, "build-evidence");
  await mkdir(evidence);
  await writeFile(path.join(evidence, "candidate.mjs"), wrapperBytes, { mode: 0o444 });
  await writeFile(path.join(evidence, "mac-signing.mjs"), signingInputs.helper, { mode: 0o444 });
  await writeFile(path.join(evidence, "macos-entitlements.plist"), signingInputs.entitlements, { mode: 0o444 });
  await writeFile(path.join(evidence, "recipe.json"), recipeBytes, { mode: 0o444 });
  const reference = path.join(destination, reused ? "source-review" : "source");
  await cloneReviewedSource(prepared, reference);
  await run("git", ["checkout", "--detach", recipe.upstream.commit], { cwd: reference });
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: reference, capture: true });
  if (commit !== recipe.upstream.commit) throw new Error("The source checkout does not match the reviewed upstream commit.");
  const epoch = await run("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: reference, capture: true });
  const patch = path.join(destination, "reviewed.patch");
  await writeFile(patch, inputs.patch);
  await applyReviewedPatch(reference, patch);
  const changed = (await run("git", ["diff", "--name-only", "HEAD"], { cwd: reference, capture: true })).split("\n").filter(Boolean).sort();
  for (const input of reused ? [prepared, reused] : [prepared]) {
    if (await run("git", ["rev-parse", "HEAD"], { cwd: input, capture: true }) !== commit) throw new Error("The prepared staging source commit changed.");
    const inputChanged = (await run("git", ["diff", "--name-only", "HEAD"], { cwd: input, capture: true })).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(inputChanged)) throw new Error("The prepared checkout contains unreviewed source changes.");
    for (const filename of changed) {
      if (sha256(await readFile(path.join(input, filename))) !== sha256(await readFile(path.join(reference, filename)))) throw new Error(`The tested patch does not match the reviewed source: ${filename}`);
    }
    for (const [name, filename] of [["rootPackage", "package.json"], ["lockfile", "bun.lock"]]) {
      if (sha256(await readFile(path.join(input, filename))) !== recipe.inputs[name].sha256) throw new Error(`The prepared staging input changed: ${filename}`);
    }
  }
  const source = reused ?? reference;
  // The source agent owns the sole official frozen installation. Copy its
  // tested dependencies without reinstalling, following source links, or sharing
  // writable inodes with its checkout. No package-manager conversion is used.
  if (!(await lstat(path.join(prepared, "node_modules"))).isDirectory()) throw new Error("The prepared official dependency installation is unavailable.");
  const manifests = new Set(["package.json", ...(await run("git", ["ls-files", "**/package.json"], { cwd: source, capture: true })).split("\n").filter(Boolean)]);
  for (const manifest of reused ? [] : manifests) {
    const relative = path.join(path.dirname(manifest), "node_modules"), installed = path.join(prepared, relative);
    try { if (!(await lstat(installed)).isDirectory()) continue; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const copied = path.join(source, relative);
    // Node's forced reflink copy is unsupported on macOS; use its native clone
    // operation so the large tested tree is not silently duplicated there.
    if (process.platform === "darwin") await run("/bin/cp", ["-cR", installed, copied]);
    else await cp(installed, copied, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await localizeDependencyLinks(copied, prepared, source);
  }
  const env = { ...environment(), PATH: `${path.dirname(runtime)}${path.delimiter}${process.env.PATH ?? ""}`, TZ: "UTC", SOURCE_DATE_EPOCH: epoch,
    OPENCODE_VERSION: recipe.version, OPENCODE_CHANNEL: recipe.channel, OPENCODE_BUMP: "", OPENCODE_RELEASE: "", OPENCODE_RELEASE_NOTES: "", BUN_COMPILE_RELEASE: "" };
  if (sha256(await readFile(path.join(source, "bun.lock"))) !== recipe.inputs.lockfile.sha256) throw new Error("The official frozen dependency lock changed during preparation.");
  return withBuildStagingLock(source, async () => {
  // This exact upstream postinstall only restores native spawn-helper mode bits.
  await run(runtime, ["--no-env-file", "run", "--cwd", "packages/core", "fix-node-pty"], { cwd: source, env });
  const compiled = path.join(destination, "compiled");
  await run(runtime, ["--no-env-file", "run", "packages/cli/script/build.ts", "--skip-install", `--target=opencode-${target}`, `--outdir=${compiled}`], { cwd: source, env });
  const name = target.startsWith("windows-") ? "opencode.exe" : "opencode";
  const original = path.join(compiled, `cli-${target}`, "bin", name), artifact = path.join(destination, "artifact");
  await mkdir(artifact);
  const binary = path.join(artifact, name);
  await copyFile(original, binary); await chmod(binary, 0o755);
  const buildSha256 = sha256(await readFile(binary));
  let signing = "not-signed-by-this-build";
  let signingEvidence;
  if (process.platform === "darwin" && target.startsWith("darwin-")) {
    signingEvidence = await signMacEngine({ binary, evidenceDirectory: evidence, configuration: macSigning, inputs: signingInputs });
    signing = signingEvidence.signing;
  }
  let reportedVersion;
  if (target === opencodeReleaseTarget()) {
    const probe = path.join(destination, "version-probe");
    await Promise.all(["home", "config", "data", "state", "cache"].map(name => mkdir(path.join(probe, name), { recursive: true })));
    const probeEnv = { ...env, HOME: path.join(probe, "home"), USERPROFILE: path.join(probe, "home"),
      XDG_CONFIG_HOME: path.join(probe, "config"), XDG_DATA_HOME: path.join(probe, "data"), XDG_STATE_HOME: path.join(probe, "state"), XDG_CACHE_HOME: path.join(probe, "cache"),
      OPENCODE_CONFIG_DIR: path.join(probe, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }) };
    reportedVersion = await run(binary, ["--version"], { cwd: probe, capture: true, env: probeEnv });
    if (reportedVersion.replace(/^opencode v?/, "") !== recipe.version) throw new Error(`The candidate did not report its distinct patched identity: ${reportedVersion}`);
  }
  const license = await readFile(path.join(source, "LICENSE"));
  await writeFile(path.join(artifact, "LICENSE"), license);
  const notice = `LegalWork patched OpenCode build ${recipe.version}\n\nThis is not an official OpenCode binary.\nUpstream: ${recipe.upstream.repository}\nCommit: ${recipe.upstream.commit}\nPatch SHA256: ${recipe.inputs.patch.sha256}\n\nThe original OpenCode MIT license is included in LICENSE. Existing application third-party notices remain required for distribution.\n`;
  await writeFile(path.join(artifact, "NOTICE"), notice);
  const provenance = { ...recipe, officialBase: opencodeRelease.packages[target], target,
    compiler: { version: bunVersion, sha256: sha256(await readFile(runtime)) }, packageManager: `Bun ${bunVersion}; original frozen upstream lock; copied tested installation`,
    sourceDateEpoch: epoch, build: { script: "packages/cli/script/build.ts", wrapperSha256: sha256(wrapperBytes), signingHelperSha256: sha256(signingInputs.helper), signingEntitlementsSha256: sha256(signingInputs.entitlements), recipeSha256: sha256(recipeBytes), fullNativeWebUI: true, skipInstall: true, buildSha256,
      staging: previous ? { kind: "serial-reuse-of-verified-candidate-staging", provenanceSha256: previous.provenanceSha256, binarySha256: previous.sha256 } : { kind: "independent-copy-of-tested-official-install" } },
    binary: { filename: name, sha256: sha256(await readFile(binary)), ...(reportedVersion ? { reportedVersion } : {}), signing, ...(signingEvidence ? { signingEvidence } : {}) }, licenseSha256: sha256(license) };
  if (signingEvidence && (signingEvidence.beforeSha256 !== buildSha256 || signingEvidence.afterSha256 !== provenance.binary.sha256)) throw new Error("The executable changed between compilation, signing and final provenance pins.");
  const document = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(path.join(artifact, "provenance.json"), document);
  await writeFile(path.join(artifact, "SHA256SUMS"), `${provenance.binary.sha256}  ${name}\n${sha256(document)}  provenance.json\n${provenance.licenseSha256}  LICENSE\n${sha256(notice)}  NOTICE\n`);
  return { artifact, version: recipe.version, baseVersion: recipe.baseVersion, target, sha256: provenance.binary.sha256, provenanceSha256: sha256(document) };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const output = value("--output"), bun = value("--bun"), preparedSource = value("--prepared-source");
  if (!output || !bun || !preparedSource) throw new Error("Usage: node candidate.mjs --output <NEW-directory> --bun <pinned-bun> --prepared-source <tested-official-checkout> [--target <release-target>] [--mac-signing-config <public-certificate-policy.json>]");
  const signingConfigPath = value("--mac-signing-config");
  if (args.includes("--mac-signing-config") && (!signingConfigPath || signingConfigPath.startsWith("--"))) throw new Error("--mac-signing-config requires an explicit public certificate policy file; it cannot fall back to ad-hoc signing.");
  const macSigning = signingConfigPath ? JSON.parse(await readFile(signingConfigPath, "utf8")) : undefined;
  console.log(JSON.stringify(await buildCandidate({ output, bun, target: value("--target"), preparedSource,
    reuseArtifact: value("--reuse-artifact"), reuseProvenanceSha256: value("--reuse-provenance-sha256"), macSigning }), null, 2));
}
