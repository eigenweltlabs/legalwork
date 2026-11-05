import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };

const verified = new WeakSet(), testCandidates = new Map();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function binaryDigest(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

async function inspect(directory, provenanceSha256) {
  if (!/^[a-f0-9]{64}$/.test(provenanceSha256)) throw new Error("An independently reviewed candidate provenance SHA256 is required.");
  const root = await realpath(directory), bytes = await readFile(path.join(root, "provenance.json"));
  if (digest(bytes) !== provenanceSha256) throw new Error("Candidate provenance changed or does not match the independently reviewed receipt.");
  const value = JSON.parse(bytes);
  if (value.kind !== "legalwork-patched-source-build" || value.version !== recipe.version || value.baseVersion !== release.version || value.channel !== recipe.channel
    || value.upstream?.commit !== recipe.upstream.commit || value.buildStatus !== "tested-source-lock"
    || value.inputs?.patch?.sha256 !== recipe.inputs.patch.sha256 || value.inputs?.lockfile?.sha256 !== recipe.inputs.lockfile.sha256
    || value.inputs?.testReceipt?.sha256 !== recipe.inputs.testReceipt.sha256 || value.testEvidence?.receiptSha256 !== recipe.inputs.testReceipt.sha256
    || value.testEvidence?.patchSha256 !== recipe.inputs.patch.sha256 || value.testEvidence?.lockfileSha256 !== recipe.inputs.lockfile.sha256
    || value.testEvidence?.bun !== recipe.toolchain.bun || value.compiler?.version !== recipe.toolchain.bun
    || !Object.values(recipe.toolchain.executables).some(compiler => compiler.sha256 === value.compiler?.sha256)) throw new Error("Candidate identity, tested source, dependencies or compiler are not registered for this LegalWork build.");
  const official = typeof value.target === "string" && Object.hasOwn(release.packages, value.target) ? release.packages[value.target] : undefined;
  if (!official || ["name", "tarball", "integrity"].some(key => value.officialBase?.[key] !== official[key])) throw new Error("Candidate official base provenance does not match the pinned release.");
  const filename = value.target.startsWith("windows-") ? "opencode.exe" : "opencode";
  if (value.binary?.filename !== filename || !/^[a-f0-9]{64}$/.test(value.binary?.sha256)) throw new Error("Candidate binary identity is invalid.");
  const binary = await realpath(path.join(root, filename));
  if (path.dirname(binary) !== root || await binaryDigest(binary) !== value.binary.sha256) throw new Error("Candidate binary changed or escapes its reviewed artifact directory.");
  return { directory: root, path: binary, version: value.version, baseVersion: value.baseVersion, sha256: value.binary.sha256, provenanceSha256 };
}

/** Host-only capability. The expected receipt digest must come from a reviewed
 * build handoff, never by trusting an arbitrary sibling manifest's own hash. */
export async function verifyOpencodeCandidate({ directory, provenanceSha256 }) {
  const descriptor = Object.freeze(await inspect(directory, provenanceSha256));
  verified.add(descriptor);
  return descriptor;
}

async function assertFresh(descriptor, binary) {
  if (!verified.has(descriptor) || !Object.isFrozen(descriptor)) throw new Error("An unknown or mutable candidate build descriptor cannot authorize engine startup.");
  const current = await inspect(descriptor.directory, descriptor.provenanceSha256);
  if (await realpath(binary) !== descriptor.path || current.path !== descriptor.path || current.sha256 !== descriptor.sha256 || current.version !== descriptor.version) throw new Error("The requested engine path does not match its verified candidate descriptor.");
}

/** Explicit host descriptors and the validation preload retain exact checks.
 * Ordinary startup verifies the statically prepared engine selection. */
async function selectedCandidate(binary, descriptor) {
  let selected = descriptor;
  if (!selected && testCandidates.size) selected = testCandidates.get(await realpath(binary).catch(() => ""));
  if (!selected) {
    const { verifySelectedOpencodeEngine } = await import("./selection.mjs");
    // This call freshly verifies all installed bytes against the compiled pin.
    // Previously issued capabilities still require the recheck below.
    return verifySelectedOpencodeEngine(binary);
  }
  if (selected) await assertFresh(selected, binary);
  return selected;
}

export async function expectedOpencodeVersion(binary, descriptor) {
  return (await selectedCandidate(binary, descriptor))?.version ?? release.version;
}

/** Upstream's custom channel scopes both its service config and registration. */
export async function expectedOpencodeServiceFilename(binary, descriptor) {
  return await selectedCandidate(binary, descriptor) ? "service-legalwork.json" : "service.json";
}

export async function registerOpencodeCandidateForValidation(descriptor) {
  await assertFresh(descriptor, descriptor.path);
  testCandidates.set(descriptor.path, descriptor);
}
