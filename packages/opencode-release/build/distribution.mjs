import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { verifyOpencodeCandidate } from "../candidate.mjs";
import { derivativeFileSha256 } from "../derivative.mjs";
import recipe from "./recipe.json" with { type: "json" };

function tarHeader(name, size, mode, epoch) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, epoch]]) {
    const encoded = value.toString(8);
    if (encoded.length >= length) throw new Error("A build artifact cannot be encoded in the USTAR header.");
    header.write(`${encoded.padStart(length - 1, "0")}\0`, offset, length);
  }
  header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/** Five fixed regular files, stable order/modes/owner/epoch, no extra build or
 * user files. Streaming keeps archive assembly independent of binary size. */
export async function writeCandidateArchive({ directory, filenames, destination, epoch }) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("The reviewed source epoch is required for deterministic archive assembly.");
  async function* entries() {
    for (const name of [...filenames].sort()) {
      if (path.basename(name) !== name || name === "." || name === "..") throw new Error("Unsafe candidate archive member.");
      const source = path.join(directory, name), metadata = await lstat(source), size = metadata.size;
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Candidate archive inputs must be ordinary files without links.");
      yield tarHeader(name, size, name.startsWith("opencode") ? 0o755 : 0o644, epoch);
      for await (const bytes of createReadStream(source)) yield bytes;
      if (size % 512) yield Buffer.alloc(512 - size % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(entries()), createGzip({ level: 9 }), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}

export async function assembleDerivativeDistribution({ builds, outputDirectory, manifestPath, onProgress = console.log, developmentTargets = undefined }) {
  if (developmentTargets !== undefined && (!Array.isArray(developmentTargets) || !developmentTargets.length
    || developmentTargets.some(target => !recipe.targets.includes(target)) || new Set(developmentTargets).size !== developmentTargets.length)) {
    throw new Error("A development distribution requires unique reviewed targets.");
  }
  const targets = developmentTargets ?? recipe.targets;
  if (JSON.stringify(builds.map(build => build.target).sort()) !== JSON.stringify([...targets].sort())) throw new Error("A distribution requires exactly one reviewed build for every declared target.");
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const manifest = { schemaVersion: developmentTargets === undefined ? 1 : 2, kind: "legalwork-patched-engine-distribution", status: "local-candidate-not-adopted",
    ...(developmentTargets === undefined ? {} : { scope: { kind: "development", targets: [...developmentTargets].sort() } }),
    version: recipe.version, baseVersion: recipe.baseVersion, channel: recipe.channel, upstream: recipe.upstream,
    source: { patchSha256: recipe.inputs.patch.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, testReceiptSha256: recipe.inputs.testReceipt.sha256 }, artifacts: {} };
  for (const build of [...builds].sort((a, b) => a.target.localeCompare(b.target))) {
    const candidate = await verifyOpencodeCandidate({ directory: build.directory, provenanceSha256: build.provenanceSha256 });
    const provenance = JSON.parse(await readFile(path.join(candidate.directory, "provenance.json"), "utf8"));
    if (provenance.target !== build.target) throw new Error("The supplied build receipt target does not match its artifact.");
    const filenames = [build.target.startsWith("windows-") ? "opencode.exe" : "opencode", "LICENSE", "NOTICE", "provenance.json", "SHA256SUMS"];
    const files = {};
    for (const name of filenames) { const source = path.join(candidate.directory, name); files[name] = { sha256: await derivativeFileSha256(source), size: (await stat(source)).size }; }
    const archiveName = `opencode-${candidate.version}-${build.target}.tar.gz`, archive = path.join(output, archiveName);
    await writeCandidateArchive({ directory: candidate.directory, filenames, destination: archive, epoch: Number(provenance.sourceDateEpoch) });
    for (const name of filenames) if (await derivativeFileSha256(path.join(candidate.directory, name)) !== files[name].sha256) throw new Error("A candidate artifact changed during archive assembly.");
    manifest.artifacts[build.target] = { archive: { filename: archiveName, sha256: await derivativeFileSha256(archive), size: (await stat(archive)).size }, files,
      signing: provenance.binary.signing, validation: { staticArchitectureVerified: true, nativeExecution: provenance.binary.reportedVersion ? "CLI-version-checked-on-builder-host" : "pending-native-execution" } };
    onProgress(JSON.stringify({ target: build.target, archive: archiveName, sha256: manifest.artifacts[build.target].archive.sha256 }));
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return { archiveDirectory: output, manifestPath: path.resolve(manifestPath), manifestSha256: await derivativeFileSha256(manifestPath), targets: Object.keys(manifest.artifacts).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  if (!["--builds", "--output", "--manifest"].every(name => args.includes(name))) throw new Error("Usage: distribution.mjs --builds <reviewed-build-receipts.json> --output <NEW-local-archive-directory> --manifest <NEW-manifest.json>");
  console.log(JSON.stringify(await assembleDerivativeDistribution({ builds: JSON.parse(await readFile(value("--builds"), "utf8")), outputDirectory: value("--output"), manifestPath: value("--manifest") }), null, 2));
}
