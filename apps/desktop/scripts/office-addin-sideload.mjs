/**
 * Dev sideloading for the LegalWork Office add-in (Word, Excel, PowerPoint).
 *
 * Idempotent and best-effort: ensures the office-addin-dev-certs localhost
 * certificate exists (interactive keychain prompt on first run) and copies
 * the generated multi-host manifest into the sideload location of every
 * installed Office app. Runs as part of electron-dev; failures never block
 * the dev flow — the add-in listener simply stays off until fixed.
 *
 * Requires apps/server to be built (dist/word-addin.js), which electron-dev
 * does right before invoking this script. Skip with LEGALWORK_WORD_ADDIN=0
 * or LEGALWORK_SKIP_OFFICE_SIDELOAD=1.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const log = (message) => console.log(`[office-sideload] ${message}`);

const MAC_OFFICE_CONTAINERS = [
  { app: "Word", container: "com.microsoft.Word" },
  { app: "Excel", container: "com.microsoft.Excel" },
  { app: "PowerPoint", container: "com.microsoft.Powerpoint" },
];
const MANIFEST_FILENAME = "legalwork-office-addin.manifest.xml";

async function main() {
  if (process.env.LEGALWORK_WORD_ADDIN === "0" || process.env.LEGALWORK_SKIP_OFFICE_SIDELOAD === "1") {
    log("skipped (disabled via env)");
    return;
  }

  ensureDevCerts();

  const manifest = await buildManifest();
  if (!manifest) return;

  if (platform() === "darwin") {
    sideloadMac(manifest);
  } else if (platform() === "win32") {
    log("Windows sideloading is not automated yet. See docs/word-addin.md (office-addin-debugging start).");
  } else {
    log("no Office sideload target on this platform");
  }
}

function devCertsVerified() {
  // A plain file-existence check is a trap: a non-interactive run can
  // generate the files while the sudo/keychain trust step fails, and the
  // files then mask the broken trust forever. On macOS, ask the OS trust
  // store directly (validates the chain AND expiry — what Office's webview
  // actually enforces); office-addin-dev-certs' own `verify` reports OK
  // even when the trust settings are missing.
  const certDir = join(homedir(), ".office-addin-dev-certs");
  const certPath = join(certDir, "localhost.crt");
  if (!existsSync(certPath) || !existsSync(join(certDir, "localhost.key"))) return false;
  if (platform() === "darwin") {
    const result = spawnSync("security", ["verify-cert", "-c", certPath], {
      stdio: "pipe",
      timeout: 30_000,
    });
    return result.status === 0;
  }
  const result = spawnSync("npx", ["-y", "office-addin-dev-certs", "verify"], {
    stdio: "pipe",
    timeout: 120_000,
  });
  return result.status === 0;
}

function ensureDevCerts() {
  if (devCertsVerified()) return;

  // Clear generated-but-untrusted leftovers first: `install` early-exits on
  // existing files ("You already have trusted access") and would never redo
  // the failed keychain trust step.
  rmSync(join(homedir(), ".office-addin-dev-certs"), { recursive: true, force: true });

  log("localhost dev certificate missing or not trusted — running `npx office-addin-dev-certs install`");
  log("(expect a one-time password prompt for the keychain trust step)");
  if (!process.stdin.isTTY) {
    log("NOTE: no interactive terminal — the trust step will likely fail here.");
  }
  spawnSync("npx", ["-y", "office-addin-dev-certs", "install"], {
    stdio: "inherit",
    timeout: 180_000,
  });

  if (!devCertsVerified()) {
    log("WARNING: the dev certificate is not trusted yet. Office will refuse the add-in pane.");
    log("Fix: run `pnpm office:sideload` in an interactive terminal, then restart dev.");
  }
}

async function buildManifest() {
  const manifestModulePath = join(repoRoot, "apps", "server", "dist", "word-addin.js");
  if (!existsSync(manifestModulePath)) {
    log(`WARNING: ${manifestModulePath} not built yet; skipping manifest sideload`);
    return null;
  }
  const { buildWordAddinManifest } = await import(pathToFileURL(manifestModulePath).href);
  const portRaw = Number.parseInt(process.env.LEGALWORK_WORD_ADDIN_PORT ?? "", 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 47443;
  return buildWordAddinManifest({ baseUrl: `https://localhost:${port}` });
}

function sideloadMac(manifest) {
  for (const { app, container } of MAC_OFFICE_CONTAINERS) {
    const containerDir = join(homedir(), "Library", "Containers", container);
    if (!existsSync(containerDir)) {
      log(`${app}: not installed, skipping`);
      continue;
    }
    const wefDir = join(containerDir, "Data", "Documents", "wef");
    const target = join(wefDir, MANIFEST_FILENAME);
    try {
      mkdirSync(wefDir, { recursive: true });
      const current = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (current === manifest) {
        log(`${app}: manifest up to date`);
        continue;
      }
      writeFileSync(target, manifest, "utf8");
      log(`${app}: manifest ${current ? "updated" : "installed"} (restart ${app} to pick it up)`);
    } catch (error) {
      log(`${app}: WARNING: could not write manifest: ${error?.message ?? error}`);
    }
  }
}

main().catch((error) => {
  log(`WARNING: sideload failed: ${error?.message ?? error}`);
});
