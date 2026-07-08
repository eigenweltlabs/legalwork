/**
 * Build the macOS audio-tap helper (Core Audio process taps, macOS 14.4+)
 * and stage it under resources/helpers for electron-builder.
 *
 * Run on macOS: `pnpm --filter @legalwork/desktop run build:audiotap`
 * No-op on other platforms so cross-platform CI keeps working.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const packageDir = path.join(desktopRoot, "native", "audiotap");
const helpersDir = path.join(desktopRoot, "resources", "helpers");

if (process.platform !== "darwin") {
  console.log("[audiotap] skipped — macOS only");
  process.exit(0);
}

execFileSync("swift", ["build", "--package-path", packageDir, "-c", "release"], {
  stdio: "inherit",
});

const candidates = [
  path.join(packageDir, ".build", "release", "LegalWorkAudioTap"),
  path.join(packageDir, ".build", "arm64-apple-macosx", "release", "LegalWorkAudioTap"),
  path.join(packageDir, ".build", "x86_64-apple-macosx", "release", "LegalWorkAudioTap"),
];
const built = candidates.find((candidate) => existsSync(candidate));
if (!built) {
  console.error("[audiotap] build succeeded but binary not found in .build/");
  process.exit(1);
}

mkdirSync(helpersDir, { recursive: true });
copyFileSync(built, path.join(helpersDir, "LegalWorkAudioTap"));
console.log(`[audiotap] staged ${path.join(helpersDir, "LegalWorkAudioTap")}`);
