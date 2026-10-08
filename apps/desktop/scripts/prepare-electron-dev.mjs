import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { findNotificationSigning } from "./mac-notification-signing.mjs";

const require = createRequire(import.meta.url);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Keep macOS dev notifications separate from other Electron apps and production. */
export function prepareElectronDev(desktopRoot) {
  const executable = require("electron");
  if (typeof executable !== "string") throw new Error("Expected the installed Electron executable path");
  if (process.platform !== "darwin") return executable;
  const sourceApp = resolve(dirname(executable), "../..");
  const identifier = process.env.LEGALWORK_ELECTRON_APP_IDENTIFIER?.trim() || "com.eigenweltlabs.legalwork.dev";
  const name = process.env.LEGALWORK_ELECTRON_APP_NAME?.trim() || "LegalWork - Dev";
  const signing = findNotificationSigning(identifier);
  const cache = resolve(desktopRoot, "dist-electron/dev-runtime");
  const appPath = resolve(cache, "LegalWork Dev.app");
  const markerPath = resolve(cache, "runtime.json");
  const signature = JSON.stringify({ sourceApp, modified: statSync(resolve(sourceApp, "Contents/Info.plist")).mtimeMs, identifier, name, signing, revision: 4 });
  const devExecutable = resolve(appPath, "Contents/MacOS/Electron");
  if (existsSync(devExecutable) && existsSync(markerPath) && readFileSync(markerPath, "utf8") === signature) return devExecutable;

  console.log("[electron-dev] Preparing signed macOS dev app for native notifications...");
  mkdirSync(cache, { recursive: true });
  // Only this generated copy is modified. Never sign node_modules or the installed app.
  rmSync(appPath, { recursive: true, force: true });
  run("/usr/bin/ditto", [sourceApp, appPath]);
  const plist = resolve(appPath, "Contents/Info.plist");
  for (const [key, value] of Object.entries({ CFBundleIdentifier: identifier, CFBundleName: name, CFBundleDisplayName: name })) {
    run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
  copyFileSync(resolve(desktopRoot, "resources/icons/dev/icon-dev.icns"), resolve(appPath, "Contents/Resources/electron.icns"));
  run("/usr/bin/plutil", ["-replace", "NSUserActivityTypes", "-json", '["INSendMessageIntent"]', plist]);
  // Sign nested Electron code without the main app's restricted capability.
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
  if (signing) {
    copyFileSync(signing.path, resolve(appPath, "Contents/embedded.provisionprofile"));
    const entitlements = resolve(cache, "assistant.entitlements.plist");
    const values = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", resolve(desktopRoot, "build/entitlements.mac.assistant.plist")]));
    values["com.apple.application-identifier"] = `${signing.team}.${identifier}`;
    values["com.apple.developer.team-identifier"] = signing.team;
    writeFileSync(entitlements, JSON.stringify(values));
    run("/usr/bin/plutil", ["-convert", "xml1", entitlements]);
    run("/usr/bin/codesign", ["--force", "--sign", signing.identity, "--entitlements", entitlements, appPath]);
    console.log("[electron-dev] Communication Notifications capability enabled.");
  } else {
    console.warn("[electron-dev] No matching Communication Notifications provisioning profile. macOS notifications will use the app icon.");
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath]);
  writeFileSync(markerPath, signature);
  return devExecutable;
}
