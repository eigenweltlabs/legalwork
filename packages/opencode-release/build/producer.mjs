import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeArchiveTarExecutable, opencodeReleaseTarget } from "../index.mjs";
import { applyReviewedPatch, assertBuildReady, buildCandidate, verifyCompiler, verifyInputs } from "./candidate.mjs";
import { assembleDerivativeDistribution } from "./distribution.mjs";
import { validateMacSigningConfiguration } from "./mac-signing.mjs";
import { sourceBuildPolicy } from "../build-policy.mjs";
import recipe from "./recipe.json" with { type: "json" };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Build intent is explicit; missing production keys never select development. */
export function validateSourceBuildRequest({ mode, targets = mode === "production" ? recipe.targets : [opencodeReleaseTarget()], macSigning, requireSigning = false }, host = `${process.platform}-${process.arch}`) {
  if (!["development", "production"].includes(mode)) throw new Error("An explicit development or production engine build mode is required.");
  if (!Array.isArray(targets) || targets.length === 0 || new Set(targets).size !== targets.length || targets.some(target => !recipe.targets.includes(target))) throw new Error("Engine targets must be a nonempty unique subset of the reviewed recipe.");
  const selected = [...targets].sort();
  if (!recipe.toolchain.executables[host]) throw new Error(`A reviewed Bun compiler is required for builder ${host}.`);
  if (mode === "production" && JSON.stringify(selected) !== JSON.stringify([...recipe.targets].sort())) throw new Error("Production engine preparation requires the complete shipped target matrix.");
  if (mode === "development" && macSigning !== undefined) throw new Error("A Developer ID policy requires explicit production mode.");
  if (macSigning !== undefined) {
    validateMacSigningConfiguration(macSigning);
    const { keychainPath, ...publicPolicy } = macSigning;
    assert.deepEqual(publicPolicy, sourceBuildPolicy.productionMacSigner, "Production signing must use the exact committed public certificate policy");
  }
  if (mode === "production" && requireSigning) {
    if (!macSigning) throw new Error("Production compilation requires the exact Developer ID policy; it cannot fall back to ad-hoc signing.");
    if (!host.startsWith("darwin-")) throw new Error("Production Mac engine signing requires a macOS source builder.");
  }
  return selected;
}

async function run(command, args, cwd, env, capture = false) {
  const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
  let output = "", errors = "";
  child.stdout?.on("data", bytes => { output += bytes.toString(); });
  child.stderr?.on("data", bytes => { errors += bytes.toString(); });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})${errors ? `: ${errors}` : ""}.`)));
    });
    return output.trim();
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

/** Native-only preparation needs only the host's optional packages. Cross-target
 * builds keep the original complete frozen installation flags. */
export function sourceInstallArguments(targets, hostTarget = opencodeReleaseTarget()) {
  return ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts",
    ...(targets.length === 1 && targets[0] === hostTarget ? [] : ["--os=*", "--cpu=*", "--libc=*"])];
}

/** The official frozen Bun graph is the reviewed, narrow package-manager exception. */
export async function buildOpencodeDistribution({ outputDirectory, targets, mode, macSigning, onProgress = console.log }) {
  const selected = validateSourceBuildRequest({ mode, targets, macSigning, requireSigning: true });
  await verifyInputs(recipe); assertBuildReady(recipe);
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) throw new Error("A new absolute engine build directory is required.");
  const root = path.resolve(outputDirectory);
  await mkdir(path.dirname(root), { recursive: true }); await mkdir(root, { mode: 0o700 });
  const compiler = recipe.toolchain.executables[`${process.platform}-${process.arch}`];
  const response = await fetch(compiler.tarball);
  if (!response.ok) throw new Error(`Pinned compiler download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== compiler.integrity) throw new Error("Compiler registry archive integrity differs.");
  const archive = path.join(root, "compiler.tgz"), extracted = path.join(root, "compiler");
  await writeFile(archive, bytes, { flag: "wx", mode: 0o600 }); await mkdir(extracted, { mode: 0o700 });
  await run(opencodeArchiveTarExecutable(), ["-xzf", archive, "-C", extracted]);
  const bun = path.join(extracted, "package/bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (!(await lstat(bun)).isFile()) throw new Error("The pinned compiler must be an ordinary executable.");
  verifyCompiler(recipe, await readFile(bun)); await chmod(bun, 0o755);
  const prepared = path.join(root, "upstream");
  await run("git", ["clone", "--config", "core.autocrlf=false", "--config", "core.eol=lf", "--depth=1", "--branch", recipe.upstream.tag, recipe.upstream.repository, prepared]);
  if (await run("git", ["rev-parse", "HEAD"], prepared, undefined, true) !== recipe.upstream.commit) throw new Error("Cloned upstream tag does not match the exact reviewed commit.");
  await applyReviewedPatch(prepared, path.join(repository, recipe.inputs.patch.path));
  for (const [name, filename] of [["rootPackage", "package.json"], ["lockfile", "bun.lock"]]) {
    if (createHash("sha256").update(await readFile(path.join(prepared, filename))).digest("hex") !== recipe.inputs[name].sha256) throw new Error(`Frozen upstream dependency input changed: ${filename}`);
  }
  // Child build commands resolve exactly this already-hashed compiler.
  const env = { ...process.env, PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}` };
  await run(bun, sourceInstallArguments(selected), prepared, env);
  const builds = [];
  let first;
  for (const target of selected) {
    const output = path.join(root, `build-${target}`);
    const built = await buildCandidate({ output, bun, target, preparedSource: prepared, macSigning,
      ...(first ? { reuseArtifact: first.artifact, reuseProvenanceSha256: first.provenanceSha256 } : {}) });
    first ??= built;
    builds.push({ target, directory: built.artifact, provenanceSha256: built.provenanceSha256 });
    await writeFile(path.join(output, "result.json"), `${JSON.stringify(built, null, 2)}\n`, { flag: "wx" });
    // Retain the complete verified artifacts, source and receipts, as before.
    await rm(path.join(output, "compiled"), { recursive: true });
    if (built !== first) await rm(path.join(output, "source-review"), { recursive: true });
  }
  const distribution = path.join(root, "distribution"); await mkdir(distribution, { mode: 0o700 });
  const partial = selected.length !== recipe.targets.length;
  const result = await assembleDerivativeDistribution({ builds, outputDirectory: path.join(distribution, "archives"), manifestPath: path.join(distribution, "derivative-release.json"), onProgress,
    ...(partial ? { developmentTargets: selected } : {}) });
  await writeFile(path.join(root, "builds.json"), `${JSON.stringify(builds, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(distribution, "distribution-receipt.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}
