const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const { performance } = require('node:perf_hooks');
const { recordSpan } = require('../../../scripts/ci/timing.cjs');

function run(command, args) {
  const started = performance.now();
  const result = spawnSync(command, args, { stdio: "inherit" });
  recordSpan(`package:${command === 'ditto' ? 'notary-archive' : args.slice(0, 2).join(':')}`, started, { status: result.status });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

async function runStapler(action, appPath) {
  const started = performance.now();
  const args = ["stapler", action, appPath];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = spawnSync("xcrun", args, { stdio: "inherit" });
    if (result.status === 0) { recordSpan(`package:stapler:${action}`, started); return; }
    // Apple ticket lookups can lose their CloudKit connection even after
    // notarization was accepted or stapling succeeded. Retry that service
    // failure only; every attempt must still pass Apple's real validation.
    if (result.status !== 68 || attempt === 5) {
      throw new Error(`xcrun ${args.join(" ")} failed with status ${result.status}`);
    }
    const waitMs = Math.min(15_000 * 2 ** (attempt - 1), 60_000);
    console.warn(`[electron-after-sign] Apple ticket service failed during ${action}; retrying in ${waitMs / 1000}s (${attempt}/5).`);
    await delay(waitMs);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to notarize the Electron macOS app`);
  }
  return value;
}

async function afterSign(context) {
  if (context.electronPlatformName === "win32") {
    // Authenticode changes the copied QEMU executable. Hash the final signed
    // resources before the installer is built, never the pre-signing inputs.
    const directory = path.join(context.appOutDir, "resources", "agent-sandbox");
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const name of Object.keys(manifest.files)) {
      if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) throw new Error("Invalid sandbox resource name");
      manifest.files[name] = createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex");
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return;
  }
  if (context.electronPlatformName !== "darwin") return;

  if (process.env.MACOS_NOTARIZE !== "true") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "legalwork-electron-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");

  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    run("xcrun", [
      "notarytool",
      "submit",
      notaryZipPath,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
    ]);
    await runStapler("staple", appPath);
    await runStapler("validate", appPath);
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
