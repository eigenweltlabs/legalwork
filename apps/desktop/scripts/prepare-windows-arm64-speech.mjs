// Upstream ships Windows ARM64 C libraries but no ARM64 Node addon package.
// Build only its N-API adapter against the pinned, prebuilt C libraries.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.CARGO_CFG_TARGET_TRIPLE ?? process.env.TARGET;
if (target !== "aarch64-pc-windows-msvc" && !(target == null && process.platform === "win32" && process.arch === "arm64")) process.exit(0);
if (process.platform !== "win32" || process.arch !== "arm64") throw new Error("Build Windows ARM64 speech on a native Windows ARM64 runner.");

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(desktop, "package.json"));
const pin = JSON.parse(await readFile(path.join(desktop, "build/windows-arm64-speech.json"), "utf8"));
const installed = require("sherpa-onnx-node/package.json");
if (installed.version !== pin.version) throw new Error("Update Windows ARM64 speech pins alongside sherpa-onnx-node.");
const temporary = await mkdtemp(path.join(tmpdir(), "legalwork-arm64-speech-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
async function download(url, sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Speech dependency download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`Checksum mismatch: ${url}`);
  return bytes;
}
async function extract(url, name, sha256, members = []) {
  const bytes = await download(url, sha256);
  const archive = path.join(temporary, name);
  await writeFile(archive, bytes);
  // Git's GNU tar treats the drive letter in an absolute path as a remote host.
  // Windows ships bsdtar, which also supports the upstream bzip2 archive.
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  run(tar, ["-xf", name, ...members], { cwd: temporary });
}
try {
  const sourceName = `sherpa-onnx-${pin.version}`;
  const cppPath = "harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp";
  // Static CRT linkage also works on clean Windows machines without VC++ tools.
  const nativeName = `sherpa-onnx-v${pin.version}-win-arm64-shared-MT-Release-lib`;
  await extract(`https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v${pin.version}.tar.gz`, "source.tar.gz", pin.sourceSha256, [
    `--exclude=${sourceName}/${cppPath}/include`,
    `${sourceName}/scripts/node-addon-api/CMakeLists.txt`, `${sourceName}/${cppPath}`,
    `${sourceName}/sherpa-onnx/c-api/c-api.h`, `${sourceName}/LICENSE`,
  ]);
  await extract(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${pin.version}/${nativeName}.tar.bz2`, "native.tar.bz2", pin.nativeSha256);
  const source = path.join(temporary, sourceName);
  const addon = path.join(source, "scripts/node-addon-api");
  const native = path.join(temporary, nativeName);
  // Upstream's addon source entries are symlinks. Copy their real sources so
  // this build does not require Windows developer mode or symlink privileges.
  await mkdir(path.join(addon, "src"), { recursive: true });
  for (const name of await readdir(path.join(source, cppPath))) {
    if (/\.(cc|h)$/.test(name)) await copyFile(path.join(source, cppPath, name), path.join(addon, "src", name));
  }
  // The prebuilt release contains libraries only; use the matching C API header.
  await mkdir(path.join(native, "include/sherpa-onnx/c-api"), { recursive: true });
  await copyFile(path.join(source, "sherpa-onnx/c-api/c-api.h"), path.join(native, "include/sherpa-onnx/c-api/c-api.h"));
  // Upstream's addon CMake file passes Unix rpath flags to every platform.
  const cmake = path.join(addon, "CMakeLists.txt");
  await writeFile(cmake, (await readFile(cmake, "utf8")).replace(/^\s*-Wl,-rpath,.*$/gm, ""));
  run(process.execPath, [require.resolve("cmake-js/bin/cmake-js"), "compile", "--directory", addon, "--arch", "arm64", "--CDCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"], {
    env: { ...process.env, SHERPA_ONNX_INSTALL_DIR: native, NODE_PATH: path.join(desktop, "node_modules") },
  });
  const destination = path.dirname(require.resolve("sherpa-onnx-node/package.json"));
  await copyFile(path.join(addon, "build/Release/sherpa-onnx.node"), path.join(destination, "sherpa-onnx.node"));
  for (const name of await readdir(path.join(native, "lib"))) {
    if (name.endsWith(".dll")) await copyFile(path.join(native, "lib", name), path.join(destination, name));
  }
  const notices = path.join(destination, "arm64-notices");
  await mkdir(notices, { recursive: true });
  await copyFile(path.join(source, "LICENSE"), path.join(notices, "sherpa-onnx-LICENSE"));
  const onnxSource = `https://raw.githubusercontent.com/microsoft/onnxruntime/v${pin.onnxruntimeVersion}`;
  await writeFile(path.join(notices, "onnxruntime-LICENSE"), await download(`${onnxSource}/LICENSE`, pin.onnxruntimeLicenseSha256));
  await writeFile(path.join(notices, "onnxruntime-ThirdPartyNotices.txt"), await download(`${onnxSource}/ThirdPartyNotices.txt`, pin.onnxruntimeNoticesSha256));
  // Prove that the generated adapter can load its native DLLs before packaging.
  run(process.execPath, ["-e", "const s=require('sherpa-onnx-node');console.log('ARM64 speech:',s.version)"] , { cwd: desktop });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
