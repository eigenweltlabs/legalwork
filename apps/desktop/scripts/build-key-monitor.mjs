import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const packageDir = path.join(desktopRoot, "native", "key-monitor");
const helpersDir = path.join(desktopRoot, "resources", "helpers");
const helperName = "LegalWorkKeyMonitor";

if (process.platform !== "darwin") {
  console.log("[key-monitor] skipped - macOS helper is not built on this platform");
  process.exit(0);
}

execFileSync("swift", ["build", "--package-path", packageDir, "-c", "release"], {
  stdio: "inherit",
});

const candidates = [
  path.join(packageDir, ".build", "release", helperName),
  path.join(packageDir, ".build", "arm64-apple-macosx", "release", helperName),
  path.join(packageDir, ".build", "x86_64-apple-macosx", "release", helperName),
];
const built = candidates.find((candidate) => existsSync(candidate));
if (!built) {
  console.error("[key-monitor] build succeeded but binary was not found");
  process.exit(1);
}

mkdirSync(helpersDir, { recursive: true });
copyFileSync(built, path.join(helpersDir, helperName));
console.log(`[key-monitor] staged ${path.join(helpersDir, helperName)}`);
