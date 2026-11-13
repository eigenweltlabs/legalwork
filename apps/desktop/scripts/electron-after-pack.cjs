const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");
const { pruneOcrRuntime } = require("./packaged-ocr.cjs");
const { assertPackagedOpencodeSdk } = require("./packaged-opencode-sdk.cjs");

const sidecarBases = [
  "opencode",
  "legalwork-orchestrator",
];

function targetTriple(platformName, arch) {
  if (platformName === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platformName === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platformName === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

function resolveSidecarsDir(context) {
  if (context.electronPlatformName === "darwin") {
    const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
    const appName = entries.find((entry) => entry.endsWith(".app"));
    return appName ? path.join(context.appOutDir, appName, "Contents", "Resources", "sidecars") : null;
  }
  return path.join(context.appOutDir, "resources", "sidecars");
}

function resolveMacAppPath(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const direct = path.join(context.appOutDir, appName);
  if (fs.existsSync(direct)) return direct;

  const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
  const fallback = entries.find((entry) => entry.endsWith(".app"));
  return fallback ? path.join(context.appOutDir, fallback) : null;
}

function copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName) {
  const targetPath = path.join(sidecarsDir, targetName);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing packaged sidecar for target: ${targetName}`);
  }

  const aliasPath = path.join(sidecarsDir, aliasName);
  fs.copyFileSync(targetPath, aliasPath);
  try {
    fs.chmodSync(aliasPath, 0o755);
  } catch {
    // Windows and some filesystems may ignore chmod.
  }
}

async function afterPack(context) {
  const { opencodeEngineSelection, verifySelectedOpencodeEngine } = await import("@legalwork/opencode-release/selection");
  const appPath = resolveMacAppPath(context);
  const resources = appPath ? path.join(appPath, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  const nodePath = path.join(resources, "node", context.electronPlatformName === "win32" ? "node.exe" : "node");
  if (!fs.existsSync(nodePath)) throw new Error(`Missing packaged Node runtime: ${nodePath}`);
  assertPackagedOpencodeSdk(resources);
  const arch = typeof context.arch === "string" ? context.arch : Arch[context.arch];
  pruneOcrRuntime(resources, context.electronPlatformName, arch);
  const triple = targetTriple(context.electronPlatformName, arch);
  if (!triple) return;

  const engineDirectory = path.join(resources, "opencode-engine");
  if (opencodeEngineSelection.kind === "derivative") {
    const { opencodeReleaseTarget } = await import("@legalwork/opencode-release");
    const target = opencodeReleaseTarget(context.electronPlatformName, arch);
    const artifactDirectory = path.join(engineDirectory, opencodeEngineSelection.artifactId);
    await verifySelectedOpencodeEngine(path.join(artifactDirectory, target, context.electronPlatformName === "win32" ? "opencode.exe" : "opencode"), { target });
    for (const entry of fs.readdirSync(artifactDirectory)) if (entry !== target) fs.rmSync(path.join(artifactDirectory, entry), { force: true, recursive: true });
    for (const entry of fs.readdirSync(engineDirectory)) if (entry !== opencodeEngineSelection.artifactId) fs.rmSync(path.join(engineDirectory, entry), { force: true, recursive: true });
  } else if (fs.existsSync(engineDirectory)) {
    // Stale derivative artifacts cannot enter an official-selection package.
    fs.rmSync(engineDirectory, { force: true, recursive: true });
  }

  const sidecarsDir = resolveSidecarsDir(context);
  if (!sidecarsDir || !fs.existsSync(sidecarsDir)) return;

  const isWindows = context.electronPlatformName === "win32";
  const executableSuffix = isWindows ? ".exe" : "";
  const keep = new Set();

  for (const base of sidecarBases.filter(base => opencodeEngineSelection.kind !== "derivative" || base !== "opencode")) {
    const aliasName = `${base}${executableSuffix}`;
    const targetName = `${base}-${triple}${executableSuffix}`;
    copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName);
    keep.add(aliasName);
    keep.add(targetName);
  }

  const versionsAlias = "versions.json";
  const versionsTarget = `versions.json-${triple}`;
  const versionsTargetPath = path.join(sidecarsDir, versionsTarget);
  if (!fs.existsSync(versionsTargetPath)) {
    throw new Error(`Missing packaged sidecar metadata for target: ${versionsTarget}`);
  }
  fs.copyFileSync(versionsTargetPath, path.join(sidecarsDir, versionsAlias));
  keep.add(versionsAlias);
  keep.add(versionsTarget);

  for (const entry of fs.readdirSync(sidecarsDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(sidecarsDir, entry), { force: true, recursive: true });
    }
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
