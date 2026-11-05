// Explicit private benchmark entry only. Copy beside packaged-entry.mjs, then
// await registerPackagedCandidate({ resourcesPath: process.resourcesPath })
// BEFORE importing unchanged main.mjs. Ordinary production never imports it.
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeReleaseTarget } from "@legalwork/opencode-release";
import { derivativeFileSha256, verifyDerivativeDistribution } from "@legalwork/opencode-release/derivative";
import { registerOpencodeCandidateForValidation, verifyOpencodeCandidate } from "@legalwork/opencode-release/candidate";

// Independently inspected local distribution receipt. Not supplied by renderer,
// environment, HTTP, an arbitrary sibling manifest or the native version string.
export const packagedCandidateManifestSha256 = "f2f7eac3ac183b533f87fd4c916b5bb8d01e60cb40e7c74cbe45ed4f80c60d4f";

export async function registerPackagedCandidate({ resourcesPath }) {
  const manifestPath = fileURLToPath(import.meta.resolve("@legalwork/opencode-release/derivative-release.json"));
  const distribution = await verifyDerivativeDistribution({ manifestPath, manifestSha256: packagedCandidateManifestSha256 });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const target = opencodeReleaseTarget(), artifact = manifest.artifacts[target];
  const directory = path.join(await realpath(resourcesPath), "sidecars");
  if (!(await lstat(directory)).isDirectory()) throw new Error("The packaged sidecar directory must be an ordinary directory.");
  // runtime.mjs prefers target-triple aliases. The private test package contains
  // one unambiguous basename; preserved original official packages stay outside
  // this disposable staging. Never accept an unverified alias before it.
  if ((await readdir(directory)).some(name => name.startsWith("opencode-"))) throw new Error("The private candidate package contains an ambiguous engine alias.");
  for (const [name, pin] of Object.entries(artifact.files)) {
    const filename = path.join(directory, name), stat = await lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== pin.size || await derivativeFileSha256(filename) !== pin.sha256) throw new Error(`The packaged derivative file does not match its reviewed distribution: ${name}`);
  }
  const candidate = await verifyOpencodeCandidate({ directory, provenanceSha256: artifact.files["provenance.json"].sha256 });
  if (candidate.version !== distribution.version || candidate.baseVersion !== distribution.baseVersion) throw new Error("The packaged candidate does not match its exact selected identity.");
  await registerOpencodeCandidateForValidation(candidate);
  return Object.freeze({ target, version: candidate.version, baseVersion: candidate.baseVersion,
    binary: candidate.path, binarySha256: candidate.sha256, provenanceSha256: candidate.provenanceSha256,
    manifestSha256: distribution.manifestSha256,
    candidateModule: import.meta.resolve("@legalwork/opencode-release/candidate"),
    distributionModule: import.meta.resolve("@legalwork/opencode-release/derivative") });
}
