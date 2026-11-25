import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
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

const targetTriple = process.env.CARGO_CFG_TARGET_TRIPLE ?? process.env.TARGET;
const arch = targetTriple?.startsWith("x86_64-apple-darwin") ? "x86_64"
  : targetTriple?.startsWith("aarch64-apple-darwin") ? "arm64" : undefined;
const buildArgs = ["build", "--package-path", packageDir, "-c", "release", ...(arch ? ["--arch", arch] : [])];
execFileSync("swift", buildArgs, {
  stdio: "inherit",
});
const output = execFileSync("swift", [...buildArgs, "--show-bin-path"], { encoding: "utf8" }).trim();
const built = path.join(output, helperName);

mkdirSync(helpersDir, { recursive: true });
// Replacing a running signed executable in place leaves macOS with stale
// signature pages. Stage a fresh inode so the next helper can launch safely.
const staged = path.join(helpersDir, `${helperName}.tmp-${process.pid}`);
copyFileSync(built, staged);
renameSync(staged, path.join(helpersDir, helperName));
console.log(`[key-monitor] staged ${path.join(helpersDir, helperName)}`);
