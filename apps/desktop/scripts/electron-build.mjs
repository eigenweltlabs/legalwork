import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronHelperDir = resolve(desktopRoot, "resources", "helpers");
const electronRoot = resolve(desktopRoot, "electron");
const packagedServerRoot = resolve(desktopRoot, "server");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeCmd = process.execPath;

function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: needsShell(command),
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(nodeCmd, [resolve(__dirname, "prepare-sidecar.mjs"), "--force", "--outdir", electronSidecarDir], desktopRoot);
run(nodeCmd, [resolve(__dirname, "prepare-computer-use-helper.mjs"), "--force", "--outdir", electronHelperDir], desktopRoot);
// Build the server TS → JS so Electron can import it in-process
run(pnpmCmd, ["--filter", "legalwork-server", "build"], repoRoot);
// LEGALWORK_ELECTRON_BUILD tells Vite to emit relative asset paths so
// index.html resolves /assets/* correctly when loaded via file:// from
// inside the packaged .app bundle.
run(pnpmCmd, ["--filter", "@legalwork/app", "build"], repoRoot, {
  LEGALWORK_ELECTRON_BUILD: "1",
});
// Office task pane bundle — electron-builder.yml ships apps/app/dist-word-addin
// as Resources/word-addin-dist. The dir is gitignored, and electron-builder
// silently skips a missing extraResources source, so build it here and fail
// loudly if the entry point is absent (the packaged add-in would otherwise
// 503 with word_addin_bundle_missing).
run(pnpmCmd, ["--filter", "@legalwork/app", "build:word-addin"], repoRoot);
const wordAddinDistDir = resolve(repoRoot, "apps", "app", "dist-word-addin");
if (!existsSync(resolve(wordAddinDistDir, "taskpane.html"))) {
  console.error(`Word add-in bundle missing after build: ${wordAddinDistDir}/taskpane.html`);
  process.exit(1);
}
// Copy constants.json next to server dist so the packaged asar can resolve it.
// Also patch the compiled import path so it works from both dev and packaged layouts.
const serverDistDir = resolve(repoRoot, "apps", "server", "dist");
const constantsSrc = resolve(repoRoot, "constants.json");
copyFileSync(constantsSrc, resolve(serverDistDir, "constants.json"));
// Every compiled module importing the repo-root constants.json needs the
// same rewrite (server.js: opencodeVersion; eigenwelt-free.js: mint key).
for (const jsFile of ["server.js", "eigenwelt-free.js"]) {
  const jsPath = resolve(serverDistDir, jsFile);
  const jsSrc = readFileSync(jsPath, "utf8");
  const patched = jsSrc.replace(
    /from\s+["']\.\.\/\.\.\/\.\.\/constants\.json["']/,
    'from "./constants.json"',
  );
  if (patched !== jsSrc) {
    writeFileSync(jsPath, patched, "utf8");
  }
}
rmSync(packagedServerRoot, { recursive: true, force: true });
cpSync(serverDistDir, resolve(packagedServerRoot, "dist"), { recursive: true });
copyFileSync(resolve(repoRoot, "apps", "server", "package.json"), resolve(packagedServerRoot, "package.json"));
for (const fileName of readdirSync(electronRoot).filter((name) => name.endsWith(".mjs")).sort()) {
  run(nodeCmd, ["--check", resolve(electronRoot, fileName)], repoRoot);
}
run(nodeCmd, [resolve(__dirname, "check-electron-bridge.mjs")], repoRoot);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      renderer: "apps/app/dist",
      wordAddin: "apps/app/dist-word-addin",
      electronMain: "apps/desktop/electron/main.mjs",
      electronPreload: "apps/desktop/electron/preload.mjs",
    },
    null,
    2,
  )}\n`,
);
