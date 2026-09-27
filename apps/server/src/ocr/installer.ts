import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

// Pinned upstream release asset digests, from github.com/astral-sh/uv/releases/tag/0.12.19.
const VERSION = "0.12.19";
const assets: Record<string, { target: string; sha256: string }> = {
  "darwin-arm64": { target: "aarch64-apple-darwin", sha256: "a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba" },
  "darwin-x64": { target: "x86_64-apple-darwin", sha256: "cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273" },
  "linux-arm64": { target: "aarch64-unknown-linux-gnu", sha256: "0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436" },
  "linux-x64": { target: "x86_64-unknown-linux-gnu", sha256: "23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8" },
  "win32-arm64": { target: "aarch64-pc-windows-msvc", sha256: "115b54cb823bc48260670f5782001add6067ac8d98d18c8263a833704e287de9" },
  "win32-x64": { target: "x86_64-pc-windows-msvc", sha256: "6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0" },
};
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export function runInstallerCommand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, killSignal: "SIGKILL", timeout: args[0] === "--version" ? 5000 : 900_000, maxBuffer: 8 * 1024 * 1024 },
      error => error ? reject(new Error("OCR installation command failed.")) : resolve());
  });
}

/** Application-owned uv bootstrap. No shell installer, global install or administrator rights. */
export class OcrInstaller {
  private command?: string;
  private readonly asset = assets[`${process.platform}-${process.arch}`];
  private readonly executable = process.platform === "win32" ? "uv.exe" : "uv";
  private readonly directory: string;
  constructor(root: string, private readonly override = process.env.LEGALWORK_OCR_UV_BIN, private readonly run = runInstallerCommand) {
    this.directory = join(root, "installer", VERSION);
  }
  async available() {
    if (this.override) return this.run(this.override, ["--version"]).then(() => true, () => false);
    // A supported host can provision its own installer without anything on PATH.
    if (this.asset) return true;
    return this.run("uv", ["--version"]).then(() => true, () => false);
  }
  async ensure(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.command) return this.command;
    if (this.override) { await this.run(this.override, ["--version"], signal); return this.command = this.override; }
    const destination = join(this.directory, this.executable);
    for (const candidate of [destination, "uv"]) {
      try { await this.run(candidate, ["--version"], signal); return this.command = candidate; }
      catch { signal.throwIfAborted(); }
    }
    const asset = this.asset;
    if (!asset) throw new Error("Automatic OCR setup is unavailable on this platform.");
    const format = process.platform === "win32" ? "zip" : "tar.gz";
    const name = `uv-${asset.target}.${format}`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(this.directory, "download-"));
    try {
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${VERSION}/${name}`, { signal: downloadSignal });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) throw new Error("Could not download OCR installer.");
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_ARCHIVE_BYTES) throw new Error("OCR installer exceeds the download limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("OCR installer checksum mismatch.");
      signal.throwIfAborted();
      const binary = join(temporary, this.executable);
      if (format === "zip") {
        const files = unzipSync(bytes, { filter: entry => entry.name === this.executable || entry.name === `uv-${asset.target}/${this.executable}` });
        const file = files[this.executable] ?? files[`uv-${asset.target}/${this.executable}`];
        if (!file) throw new Error("OCR installer archive has no executable.");
        await writeFile(binary, file, { mode: 0o700 });
      } else {
        const archive = join(temporary, name); await writeFile(archive, bytes, { mode: 0o600 });
        await this.run("tar", ["-xzf", archive, "-C", temporary, "--strip-components=1", `uv-${asset.target}/uv`], signal);
        await chmod(binary, 0o700);
      }
      await this.run(binary, ["--version"], signal);
      signal.throwIfAborted();
      await rename(binary, destination);
      return this.command = destination;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
