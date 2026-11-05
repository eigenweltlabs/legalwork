import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import releaseMetadata from "./release.json" with { type: "json" };
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const opencodeRelease = releaseMetadata;

/** Git's GNU tar interprets a Windows drive letter as a remote archive host.
 * Use the OS archive tool for both official and derivative installations. */
export function opencodeArchiveTarExecutable() {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot || "C:\\Windows";
  if (!path.isAbsolute(root)) throw new Error("Windows SystemRoot must be an absolute directory for archive extraction.");
  const executable = path.join(root, "System32", "tar.exe");
  try {
    if (!statSync(executable).isFile()) throw new Error("Not a regular file");
  } catch (cause) {
    throw new Error(`Windows system tar is required for OpenCode archive extraction: ${executable}`, { cause });
  }
  return executable;
}

/** Prefer the baseline x64 build, which also works on CPUs without AVX2.
 * @param {string} [platform]
 * @param {string} [arch]
 * @param {string} [libc]
 */
export function opencodeReleaseTarget(platform = process.platform, arch = process.arch, libc = "glibc") {
  if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported OpenCode architecture: ${arch}`);
  const os = platform === "win32" ? "windows" : platform;
  const target = [os, arch, arch === "x64" ? "baseline" : null, os === "linux" && libc === "musl" ? "musl" : null].filter(Boolean).join("-");
  if (!opencodeRelease.packages[target]) throw new Error(`Unsupported OpenCode target: ${target}`);
  return target;
}

export function verifyOpencodeArchive(bytes, integrity) {
  const expected = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (expected !== integrity) throw new Error("OpenCode archive integrity verification failed");
}

/** Install only a digest-pinned official binary. No package manager or lifecycle scripts run. */
export async function downloadOpencodeBinary({ destination, cacheDirectory, target = opencodeReleaseTarget(), version = opencodeRelease.version, fetcher = fetch }) {
  if (version !== opencodeRelease.version) throw new Error(`OpenCode ${version} has no reviewed release digests; expected ${opencodeRelease.version}`);
  const artifact = opencodeRelease.packages[target];
  if (!artifact) throw new Error(`Unsupported OpenCode target: ${target}`);
  await mkdir(cacheDirectory, { recursive: true });
  const archive = path.join(cacheDirectory, `${target}-${version}.tgz`);
  let bytes = await readFile(archive).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (bytes) verifyOpencodeArchive(bytes, artifact.integrity);
  else {
    const response = await fetcher(artifact.tarball);
    if (!response.ok) throw new Error(`OpenCode download failed (${response.status}): ${artifact.name}@${version}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verifyOpencodeArchive(bytes, artifact.integrity);
    const temporary = `${archive}.${process.pid}.tmp`;
    try { await writeFile(temporary, bytes); await rename(temporary, archive); }
    finally { await rm(temporary, { force: true }); }
  }
  const extracted = await mkdtemp(path.join(tmpdir(), "legalwork-opencode-release-"));
  try {
    const binary = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    const result = spawnSync(opencodeArchiveTarExecutable(), ["-xzf", archive, "-C", extracted, "package/package.json", `package/bin/${binary}`], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Cannot extract OpenCode: ${result.error?.message || result.stderr}`);
    const manifest = JSON.parse(await readFile(path.join(extracted, "package", "package.json"), "utf8"));
    if (manifest.name !== artifact.name || manifest.version !== version) throw new Error("OpenCode archive package identity does not match its pinned release");
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(extracted, "package", "bin", binary), destination);
    await chmod(destination, 0o755);
    return { version, target, package: artifact.name, integrity: artifact.integrity, destination };
  } finally { await rm(extracted, { recursive: true, force: true }); }
}
