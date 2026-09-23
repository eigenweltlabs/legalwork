// Bundle a checksum-pinned Node LTS for workspace tools. Node 22 preserves the
// macOS 12 support of Electron 43; Node 24 requires macOS 13.5 or later.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(desktopRoot, "build/node-runtime.json"), "utf8"));
const triples = {
  "aarch64-apple-darwin": "darwin-arm64", "x86_64-apple-darwin": "darwin-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64", "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-pc-windows-msvc": "win-arm64", "x86_64-pc-windows-msvc": "win-x64",
};
const requestedTarget = process.env.CARGO_CFG_TARGET_TRIPLE ?? process.env.TARGET;
const target = requestedTarget ? triples[requestedTarget] : `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
if (!target || !config.sha256[target]) throw new Error(`Unsupported Node runtime target: ${requestedTarget ?? target}`);
const isWindows = target.startsWith("win-");
const name = `node-v${config.version}-${target}`;
const archive = `${name}.${isWindows ? "zip" : "tar.gz"}`;
const output = path.join(desktopRoot, "resources/node");
const executable = isWindows ? "node.exe" : "node";
const expectedMetadata = JSON.stringify({ version: config.version, target, archiveSha256: config.sha256[target] });
try {
  const existing = JSON.parse(await readFile(path.join(output, "runtime.json"), "utf8"));
  const binaryHash = createHash("sha256").update(await readFile(path.join(output, executable))).digest("hex");
  if (JSON.stringify(existing.source) === expectedMetadata && existing.binarySha256 === binaryHash) {
    console.log(`[node-runtime] ${config.version} ${target} already verified`);
    process.exit(0);
  }
} catch { /* First build or incomplete cached runtime: download and verify below. */ }
const temporary = await mkdtemp(path.join(tmpdir(), "legalwork-node-runtime-"));
try {
  const response = await fetch(`https://nodejs.org/dist/v${config.version}/${archive}`);
  if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== config.sha256[target]) throw new Error(`Node runtime checksum mismatch for ${archive}`);
  await mkdir(output, { recursive: true });
  if (isWindows) {
    const files = unzipSync(bytes, { filter: ({ name: entry }) => entry === `${name}/node.exe` || entry === `${name}/LICENSE` });
    for (const file of ["node.exe", "LICENSE"]) {
      if (!files[`${name}/${file}`]) throw new Error(`Node archive is missing ${file}`);
      await writeFile(path.join(output, file), files[`${name}/${file}`]);
    }
  } else {
    const archivePath = path.join(temporary, archive);
    await writeFile(archivePath, bytes);
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", temporary, `${name}/bin/node`, `${name}/LICENSE`], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Node runtime extraction failed: ${result.status}`);
    await copyFile(path.join(temporary, name, "bin/node"), path.join(output, "node"));
    await copyFile(path.join(temporary, name, "LICENSE"), path.join(output, "LICENSE"));
    await chmod(path.join(output, "node"), 0o755);
  }
  const binarySha256 = createHash("sha256").update(await readFile(path.join(output, executable))).digest("hex");
  await writeFile(path.join(output, "runtime.json"), JSON.stringify({ source: JSON.parse(expectedMetadata), binarySha256 }, null, 2) + "\n");
  console.log(`[node-runtime] verified and prepared Node ${config.version} for ${target}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
