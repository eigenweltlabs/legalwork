import { spawnSync } from "child_process";
import { downloadOpencodeBinary, opencodeReleaseTarget } from "../electron/opencode-release.mjs";
import { engineBuildMode, prepareForBuild } from "../../../packages/opencode-release/prepare.mjs";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.LEGALWORK_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.LEGALWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "resources", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const opencodeVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion.trim() || null : null;
  } catch {
    return null;
  }
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};


// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    // Windows baseline artifacts intermittently fail to extract in CI
    // with Bun 1.3.6. Use the stable x64 target here for now.
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    case "aarch64-pc-windows-msvc":
      return "bun-windows-arm64";
    default:
      return null;
  }
})();

const opencodeBaseName = isWindowsTarget ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;

// legalwork-server paths
const legalworkServerBaseName = "legalwork-server";
const legalworkServerName = isWindowsTarget ? `${legalworkServerBaseName}.exe` : legalworkServerBaseName;
const legalworkServerPath = join(sidecarDir, legalworkServerName);
const legalworkServerBuildName = bunTarget
  ? `${legalworkServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : legalworkServerName;
const legalworkServerBuildPath = join(sidecarDir, legalworkServerBuildName);
const legalworkServerTargetTriple = resolvedTargetTriple;
const legalworkServerTargetName = legalworkServerTargetTriple
  ? `${legalworkServerBaseName}-${legalworkServerTargetTriple}${legalworkServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const legalworkServerTargetPath = legalworkServerTargetName ? join(sidecarDir, legalworkServerTargetName) : null;

const legalworkServerDir = resolve(__dirname, "..", "..", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

// orchestrator paths
const orchestratorBaseName = "legalwork-orchestrator";
const orchestratorName =
  isWindowsTarget ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "orchestrator");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim().replace(/^opencode v?/, "").replace(/^v/, "");
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

// legalwork-server is no longer compiled as a sidecar binary — it runs
// in-process inside Electron via a direct import of the server library.
const didBuildLegalworkServer = false;

// Server binary copy/sign skipped — runs in-process.

const releaseTargetByTriple = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64-baseline",
  "x86_64-unknown-linux-gnu": "linux-x64-baseline",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-unknown-linux-musl": "linux-x64-baseline-musl",
  "aarch64-unknown-linux-musl": "linux-arm64-musl",
  "x86_64-pc-windows-msvc": "windows-x64-baseline",
  "aarch64-pc-windows-msvc": "windows-arm64",
};
const releaseTarget = releaseTargetByTriple[resolvedTargetTriple];
if (!releaseTarget) throw new Error(`No reviewed OpenCode binary for target ${resolvedTargetTriple}`);
const engineMode = engineBuildMode(process.argv.slice(2));
const preparedEngine = await prepareForBuild({ mode: engineMode,
  ...(engineMode === "development" ? { targets: [releaseTarget] } : {}) });
const { installSelectedOpencodeEngine, opencodeEngineSelection } = await import("@legalwork/opencode-release/selection");
const declaredOpencodeBaseVersion = normalizeVersion(opencodeVersion);
if (declaredOpencodeBaseVersion !== opencodeEngineSelection.baseVersion) throw new Error(`OpenCode base API in ${constantsPath} does not match its reviewed engine selection.`);
const normalizedOpencodeVersion = opencodeEngineSelection.version;
// Re-verify the pinned archive even on incremental/offline builds. Never use
// GitHub's latest (v1), npm tags, or an unverified PATH executable for packaging.
const selectedEngineResources = resolve(sidecarDir, "..", "opencode-engine");
mkdirSync(selectedEngineResources, { recursive: true });
let installedOpencodePath = opencodeCandidatePath;
let opencodeSource;
if (opencodeEngineSelection.kind === "derivative") {
  const installed = await installSelectedOpencodeEngine({
    directory: join(selectedEngineResources, opencodeEngineSelection.artifactId, releaseTarget),
    cacheDirectory: process.env.LEGALWORK_OPENCODE_CACHE || resolve(__dirname, "../../../.cache/opencode-derivative"),
    archiveDirectory: preparedEngine.archiveDirectory,
    target: releaseTarget,
  });
  installedOpencodePath = installed.path;
  opencodeSource = { kind: "legalwork-derivative", version: installed.version, baseVersion: installed.baseVersion,
    target: installed.target, provenanceSha256: installed.candidateBuild.provenanceSha256 };
} else {
  const installed = await downloadOpencodeBinary({
    destination: opencodeCandidatePath,
    cacheDirectory: process.env.LEGALWORK_OPENCODE_CACHE || resolve(__dirname, "../../../.cache/opencode"),
    target: releaseTarget,
    version: normalizedOpencodeVersion,
  });
  opencodeSource = { kind: "official", package: installed.package, integrity: installed.integrity };
  if (opencodeCandidatePath !== opencodePath) copyFileSync(opencodeCandidatePath, opencodePath);
}
if (releaseTarget === opencodeReleaseTarget()) {
  const actual = readBinaryVersion(installedOpencodePath);
  if (actual !== normalizedOpencodeVersion) throw new Error(`OpenCode executable is ${actual}, expected ${normalizedOpencodeVersion}`);
}
console.log(`OpenCode ${normalizedOpencodeVersion}: verified ${opencodeSource.kind} artifact for ${releaseTarget}`);

// Build orchestrator sidecar
let didBuildOrchestrator = false;
const shouldBuildOrchestrator =
  forceBuild || !existsSync(orchestratorBuildPath) || isStubBinary(orchestratorBuildPath);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  const orchestratorArgs = [
    orchestratorBuildScript,
    "--engine-mode",
    engineMode,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical =
    didBuildOrchestrator || !existsSync(orchestratorPath) || isStubBinary(orchestratorPath);
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    try {
      if (existsSync(orchestratorPath)) unlinkSync(orchestratorPath);
    } catch {
      // ignore
    }
    copyFileSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget =
      didBuildOrchestrator ||
      !existsSync(orchestratorTargetPath) ||
      isStubBinary(orchestratorTargetPath);
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      try {
        if (existsSync(orchestratorTargetPath)) unlinkSync(orchestratorTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

adHocSignDarwinSidecars([
  ...(opencodeEngineSelection.kind === "official" ? [opencodePath, opencodeTargetPath] : []),
  // legalwork-server runs in-process — no binary to sign.
  orchestratorBuildPath,
  orchestratorPath,
  orchestratorTargetPath,
]);

const legalworkServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(legalworkServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    source: opencodeSource,
    sha256: existsSync(installedOpencodePath) ? sha256File(installedOpencodePath) : null,
  },
  "legalwork-server": {
    version: legalworkServerVersion,
    sha256: "in-process",
  },
  "legalwork-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath) ? sha256File(orchestratorPath) : null,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
