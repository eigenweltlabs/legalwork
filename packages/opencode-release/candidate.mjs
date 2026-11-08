import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import path from "node:path";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };

const verified = new WeakSet(), testCandidates = new Map();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function binaryDigest(filename) {
  // Inline so packaged Electron and compiled Bun hosts need no extra worker
  // resource. Disk reads, hashing and the reusable buffer stay off the host loop.
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { openSync, readSync, closeSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(workerData, "r");
    try {
      let size;
      while ((size = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, size));
      parentPort.postMessage(hash.digest("hex"));
    } finally { closeSync(fd); }
  `, { eval: true, execArgv: [], workerData: filename });
  return new Promise((resolve, reject) => {
    let result;
    worker.once("message", value => { result = value; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code === 0 && typeof result === "string" && /^[a-f0-9]{64}$/.test(result)) resolve(result);
      else reject(new Error(`Engine integrity worker exited without a SHA256 digest (code ${code}).`));
    });
  });
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

async function registeredCandidate(binary, descriptor) {
  let selected = descriptor;
  if (!selected && testCandidates.size) selected = testCandidates.get(await realpath(binary).catch(() => ""));
  if (selected) {
    if (!verified.has(selected) || !Object.isFrozen(selected)) throw new Error("An unknown or mutable candidate build descriptor cannot authorize engine startup.");
    if (await realpath(binary) !== selected.path) throw new Error("The requested engine path does not match its verified candidate descriptor.");
  }
  return selected;
}

/** Metadata only, never permission to execute. Startup layers share the pinned
 * identity without rereading the executable; the spawn boundary verifies bytes. */
export async function opencodeEngineIdentity(binary, descriptor) {
  const candidate = await registeredCandidate(binary, descriptor);
  if (candidate) return { version: candidate.version, serviceFilename: "service-legalwork.json" };
  const { opencodeEngineSelection } = await import("./selection.mjs");
  return { version: opencodeEngineSelection.version, serviceFilename: opencodeEngineSelection.kind === "derivative" ? "service-legalwork.json" : "service.json" };
}

/** Fresh verification immediately before each execution, including retries.
 * No successful disk check is cached across launches or process boundaries. */
export async function verifyOpencodeForExecution(binary, descriptor) {
  const candidate = await registeredCandidate(binary, descriptor);
  if (candidate) {
    await assertFresh(candidate, binary);
    return candidate.version;
  }
  const { verifySelectedOpencodeEngine } = await import("./selection.mjs");
  return (await verifySelectedOpencodeEngine(binary))?.version ?? release.version;
}

/** Compatibility for existing execution guards. Use opencodeEngineIdentity for metadata. */
export const expectedOpencodeVersion = verifyOpencodeForExecution;

/** Upstream's custom channel scopes both its service config and registration. */
export async function expectedOpencodeServiceFilename(binary, descriptor) {
  return (await opencodeEngineIdentity(binary, descriptor)).serviceFilename;
}

export async function registerOpencodeCandidateForValidation(descriptor) {
  await assertFresh(descriptor, descriptor.path);
  testCandidates.set(descriptor.path, descriptor);
}
