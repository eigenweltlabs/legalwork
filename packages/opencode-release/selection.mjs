import path from "node:path";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import selection from "./generated/selection.json" with { type: "json" };
import { validateBuildSelection } from "./build-policy.mjs";
import { downloadOpencodeBinary, opencodeRelease, opencodeReleaseTarget } from "./index.mjs";
import { downloadDerivativeArchive, installLocalDerivativeEngine, verifyDerivativeDistributionContent, verifyInstalledDerivativeEngine } from "./derivative.mjs";

await validateBuildSelection(selection);
if (selection.schemaVersion !== 1 || selection.baseVersion !== opencodeRelease.version
  || !["official", "derivative"].includes(selection.kind)
  || selection.kind === "official" && selection.version !== opencodeRelease.version) throw new Error("The compiled OpenCode selection does not match its reviewed base API.");

/** Prepared build input, never a user setting or an environment override.
 * Its source policy and exact artifact pins travel with every consumer. */
export const opencodeEngineSelection = Object.freeze({ kind: selection.kind, version: selection.version, baseVersion: selection.baseVersion,
  artifactId: selection.kind === "derivative" ? selection.manifestSha256 : selection.version });

let verifiedDistribution;
async function distribution() {
  if (selection.kind !== "derivative") throw new Error("No derivative engine is selected for this host build.");
  verifiedDistribution ??= verifyDerivativeDistributionContent({ manifestContent: selection.manifestContent, manifestSha256: selection.manifestSha256 }).then(value => {
    if (value.version !== selection.version || value.baseVersion !== selection.baseVersion) throw new Error("Selected engine identity does not match its compiled distribution pin.");
    return value;
  });
  return verifiedDistribution;
}

/** Every process reconstructs its own descriptor from the compiled pin and
 * actual installed bytes; a serialized descriptor cannot confer startup trust. */
export async function verifySelectedOpencodeEngine(binary, { target = opencodeReleaseTarget() } = {}) {
  if (selection.kind === "official") return undefined;
  const canonical = await realpath(binary);
  const candidate = await verifyInstalledDerivativeEngine({ distribution: await distribution(), directory: path.dirname(canonical), target });
  if (canonical !== candidate.path) throw new Error("Engine path does not identify the selected installed artifact.");
  return candidate;
}

/** Container mounts retain the complete independently pinned artifact. The
 * explicit target belongs to the guest, which can differ from the host OS. */
export async function stageSelectedOpencodeEngine({ binary, directory, target }) {
  const source = await verifySelectedOpencodeEngine(binary, { target });
  if (!source) throw new Error("Artifact staging requires a selected derivative engine.");
  const selected = await distribution();
  // Retain the mount's logical path (e.g. macOS /var vs /private/var) so a
  // caller can derive the correct path relative to its container volume.
  const stagedPath = path.resolve(directory, path.basename(source.path));
  const existing = await lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) {
    await verifyInstalledDerivativeEngine({ distribution: selected, directory, target });
    return stagedPath;
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const temporary = await mkdtemp(`${directory}.staging-`);
  try {
    for (const name of [path.basename(source.path), "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"]) {
      await copyFile(path.join(source.directory, name), path.join(temporary, name));
    }
    await verifyInstalledDerivativeEngine({ distribution: selected, directory: temporary, target });
    try { await rename(temporary, directory); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    await verifyInstalledDerivativeEngine({ distribution: selected, directory, target });
    return stagedPath;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Selected archives are installed in their own immutable directory, including
 * license, notices and provenance. No unverified official/PATH fallback exists. */
export async function installSelectedOpencodeEngine({ directory, cacheDirectory, archiveDirectory, target = opencodeReleaseTarget(), fetcher }) {
  if (selection.kind === "official") {
    const destination = path.join(directory, target.startsWith("windows-") ? "opencode.exe" : "opencode");
    const installed = await downloadOpencodeBinary({ destination, cacheDirectory, target, version: selection.version, fetcher });
    return { path: installed.destination, version: installed.version, baseVersion: selection.baseVersion, target };
  }
  const selected = await distribution();
  if (!archiveDirectory && selection.downloadBaseUrl) await downloadDerivativeArchive({ distribution: selected, cacheDirectory, downloadBaseUrl: selection.downloadBaseUrl, target, fetcher });
  const installed = await installLocalDerivativeEngine({ distribution: selected, archiveDirectory, cacheDirectory, destinationDirectory: directory, target });
  return { path: installed.candidateBuild.path, version: installed.candidateBuild.version, baseVersion: installed.candidateBuild.baseVersion, target, candidateBuild: installed.candidateBuild };
}
