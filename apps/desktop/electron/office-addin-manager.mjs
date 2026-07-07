/**
 * Production manager for the LegalWork Office add-ins (Word/Excel/PowerPoint).
 *
 * Owns everything the "Office Add-ins" settings tab drives:
 *  - per-app install state (word/excel/powerpoint), persisted in userData and
 *    read by startLegalworkServer so the HTTPS listener comes up on every
 *    launch while at least one app is installed,
 *  - a per-install, localhost-constrained CA + leaf certificate (shared by
 *    all apps; created on first install, removed with the last uninstall),
 *  - OS trust-store install/removal of that CA,
 *  - manifest install/removal into each Office app's sideload folder.
 *
 * HOME pitfall: in dev mode the Electron main process's HOME is redirected to
 * an app sandbox (see buildChildEnv in runtime.mjs), so every user-home path
 * here MUST use the real account home from the user database, never homedir().
 *
 * Privileged steps (trust store) shell out to platform tools and surface a
 * single OS auth prompt. Operations return structured results with per-step
 * outcomes and real error details; failures also log to the main console.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CA_COMMON_NAME,
  caFingerprint,
  ensureLocalCert,
  leafCertValid,
  officeAddinCertToolAvailable,
} from "./office-addin-cert.mjs";

const DEFAULT_PORT = 47443;
const MANIFEST_FILENAME = "legalwork-office-addin.manifest.xml";

/** @type {ReadonlyArray<{ id: "word" | "excel" | "powerpoint"; label: string; container: string }>} */
const MAC_OFFICE_APPS = [
  { id: "word", label: "Word", container: "com.microsoft.Word" },
  { id: "excel", label: "Excel", container: "com.microsoft.Excel" },
  { id: "powerpoint", label: "PowerPoint", container: "com.microsoft.Powerpoint" },
];

/** Real account home — homedir() lies when dev mode rewrites $HOME. */
function realHomeDir() {
  try {
    const info = userInfo();
    if (info?.homedir) return info.homedir;
  } catch {
    // Accounts without a passwd entry fall back to the env-derived home.
  }
  return homedir();
}

function logError(message) {
  console.error(`[office-addin] ${message}`);
}

/**
 * @param {object} deps
 * @param {import("electron").App} deps.app
 * @param {() => string | null} deps.locateServerDist  Directory holding the built server (word-addin.js), or null.
 * @param {() => string | null} deps.locatePaneDist    Directory holding the built task pane bundle, or null.
 * @param {() => Promise<unknown>} deps.requestServerRestart  Restart the embedded server so listener state applies.
 */
export function createOfficeAddinManager({ app, locateServerDist, locatePaneDist, requestServerRestart }) {
  const userDataDir = app.getPath("userData");
  const certDir = join(userDataDir, "office-addin-certs");
  const statePath = join(userDataDir, "office-addins.json");

  function emptyApps() {
    return { word: false, excel: false, powerpoint: false };
  }

  function readState() {
    try {
      const raw = readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const apps = emptyApps();
      if (parsed.apps && typeof parsed.apps === "object") {
        for (const id of Object.keys(apps)) {
          apps[id] = parsed.apps[id] === true;
        }
      } else if (parsed.enabled === true) {
        // Legacy single-switch state: treat as "all apps installed".
        for (const id of Object.keys(apps)) apps[id] = true;
      }
      return {
        apps,
        port: Number.isFinite(parsed.port) ? parsed.port : DEFAULT_PORT,
        installedAt: Number.isFinite(parsed.installedAt) ? parsed.installedAt : null,
      };
    } catch {
      return { apps: emptyApps(), port: DEFAULT_PORT, installedAt: null };
    }
  }

  function writeState(next) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  function anyEnabled(state) {
    return Object.values(state.apps).some(Boolean);
  }

  function certPaths() {
    return {
      caCertPath: join(certDir, "legalwork-local-ca.crt"),
      leafCertPath: join(certDir, "localhost.crt"),
      leafKeyPath: join(certDir, "localhost.key"),
    };
  }

  /**
   * Server config the embedded server should launch with. Null when no app is
   * installed or the certificate is missing, so the listener stays off.
   */
  function serverConfig() {
    const state = readState();
    if (!anyEnabled(state)) return null;
    const { leafCertPath, leafKeyPath } = certPaths();
    if (!existsSync(leafCertPath) || !existsSync(leafKeyPath)) return null;
    const distPath = locatePaneDist?.() ?? undefined;
    return {
      wordAddin: true,
      wordAddinPort: state.port,
      wordAddinCert: leafCertPath,
      wordAddinKey: leafKeyPath,
      ...(distPath ? { wordAddinDist: distPath } : {}),
    };
  }

  // ── OS trust store (macOS) ────────────────────────────────────────────
  function loginKeychain() {
    return join(realHomeDir(), "Library", "Keychains", "login.keychain-db");
  }

  function caTrusted() {
    if (platform() !== "darwin") return false;
    const { caCertPath, leafCertPath } = certPaths();
    if (!existsSync(caCertPath) || !existsSync(leafCertPath)) return false;
    const result = spawnSync("security", ["verify-cert", "-c", leafCertPath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    return result.status === 0;
  }

  function trustCa() {
    if (platform() !== "darwin") {
      return { ok: false, error: "Trust-store install is only implemented on macOS so far." };
    }
    const { caCertPath } = certPaths();
    // Unscoped trust (like office-addin-dev-certs): scoping to `-p ssl` makes
    // `verify-cert -p ssl` demand Certificate Transparency SCTs, which local
    // CAs cannot have. The name constraint is the real risk bound here.
    const result = spawnSync(
      "security",
      ["add-trusted-cert", "-r", "trustRoot", "-k", loginKeychain(), caCertPath],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || "add-trusted-cert failed").trim() };
    }
    return { ok: true };
  }

  function untrustCa() {
    if (platform() !== "darwin") return { ok: true };
    const { caCertPath } = certPaths();
    if (existsSync(caCertPath)) {
      const wasTrusted = caTrusted();
      const result = spawnSync("security", ["remove-trusted-cert", caCertPath], {
        encoding: "utf8",
        timeout: 60_000,
      });
      // The exit code alone is ambiguous (it is also non-zero when no trust
      // settings exist). The OS trust state is the truth: if the CA was
      // trusted before and still is, the user denied the keychain prompt.
      if (wasTrusted && caTrusted()) {
        const detail =
          (result.stderr || result.stdout || "").trim() || "the keychain change was not authorized";
        return { ok: false, error: detail };
      }
    }
    for (let i = 0; i < 8; i += 1) {
      const result = spawnSync(
        "security",
        ["delete-certificate", "-c", CA_COMMON_NAME, loginKeychain()],
        { encoding: "utf8", timeout: 30_000 },
      );
      if (result.status !== 0) break;
    }
    return { ok: true };
  }

  // ── Manifests ─────────────────────────────────────────────────────────
  async function buildManifest(port) {
    const dist = locateServerDist?.();
    if (!dist) return null;
    const modulePath = join(dist, "word-addin.js");
    if (!existsSync(modulePath)) return null;
    const { buildWordAddinManifest } = await import(pathToFileURL(modulePath).href);
    const version = typeof app.getVersion === "function" ? `${app.getVersion()}.0` : undefined;
    return buildWordAddinManifest({ baseUrl: `https://localhost:${port}`, version });
  }

  function officeApps() {
    if (platform() !== "darwin") return [];
    const home = realHomeDir();
    return MAC_OFFICE_APPS.map((entry) => {
      const containerDir = join(home, "Library", "Containers", entry.container);
      const wefDir = join(containerDir, "Data", "Documents", "wef");
      return {
        ...entry,
        installed: existsSync(containerDir),
        wefDir,
        manifestPath: join(wefDir, MANIFEST_FILENAME),
      };
    });
  }

  function officeAppById(appId) {
    return officeApps().find((entry) => entry.id === appId) ?? null;
  }

  // ── Shared install pieces ─────────────────────────────────────────────
  async function ensureCertAndTrust(steps) {
    try {
      const { leafCertPath, caCertPath } = ensureLocalCert(certDir);
      const valid = leafCertValid(leafCertPath, caCertPath);
      steps.push({ step: "certificate", ok: valid });
      if (!valid) return "The generated certificate did not validate against its CA.";
    } catch (error) {
      const detail = String(error?.message ?? error);
      steps.push({ step: "certificate", ok: false, error: detail });
      logError(`certificate generation failed: ${detail}`);
      return `Certificate generation failed: ${detail}`;
    }

    if (caTrusted()) {
      steps.push({ step: "trust", ok: true, skipped: true });
      return null;
    }
    const trust = trustCa();
    steps.push({ step: "trust", ok: trust.ok, ...(trust.error ? { error: trust.error } : {}) });
    if (!trust.ok) {
      logError(`trust step failed: ${trust.error}`);
      return `Could not trust the certificate: ${trust.error}`;
    }
    return null;
  }

  async function applyListenerState(steps) {
    try {
      await requestServerRestart();
      steps.push({ step: "listener", ok: true });
    } catch (error) {
      const detail = String(error?.message ?? error);
      steps.push({ step: "listener", ok: false, error: detail });
      logError(`server restart failed: ${detail}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────
  function status() {
    const state = readState();
    const { caCertPath, leafCertPath } = certPaths();
    const apps = officeApps().map((entry) => ({
      id: entry.id,
      label: entry.label,
      installed: entry.installed,
      enabled: state.apps[entry.id] === true,
      manifestInstalled: existsSync(entry.manifestPath),
    }));
    return {
      supported: platform() === "darwin",
      platform: platform(),
      toolAvailable: officeAddinCertToolAvailable(),
      enabled: anyEnabled(state),
      port: state.port,
      installedAt: state.installedAt,
      certPresent: existsSync(leafCertPath),
      certTrusted: caTrusted(),
      caFingerprint: caFingerprint(caCertPath),
      paneBundlePresent: Boolean(locatePaneDist?.() && existsSync(join(locatePaneDist(), "taskpane.html"))),
      apps,
    };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  async function install(appId) {
    const steps = [];
    const target = officeAppById(appId);
    if (platform() !== "darwin") {
      return { ok: false, error: "The Office add-in installer currently supports macOS only.", steps, status: status() };
    }
    if (!target) {
      return { ok: false, error: `Unknown Office app: ${appId}`, steps, status: status() };
    }
    if (!target.installed) {
      return { ok: false, error: `${target.label} is not installed on this machine.`, steps, status: status() };
    }
    if (!officeAddinCertToolAvailable()) {
      return { ok: false, error: "OpenSSL is required to generate the certificate but was not found.", steps, status: status() };
    }

    const state = readState();

    const certError = await ensureCertAndTrust(steps);
    if (certError) {
      return { ok: false, steps, status: status(), error: certError };
    }

    const manifest = await buildManifest(state.port);
    if (!manifest) {
      const detail = "Could not build the add-in manifest (server bundle missing).";
      steps.push({ step: "manifest", ok: false, error: detail });
      logError(detail);
      return { ok: false, steps, status: status(), error: detail };
    }
    try {
      mkdirSync(target.wefDir, { recursive: true });
      const current = existsSync(target.manifestPath) ? readFileSync(target.manifestPath, "utf8") : null;
      if (current !== manifest) writeFileSync(target.manifestPath, manifest, "utf8");
      steps.push({ step: "manifest", ok: true });
    } catch (error) {
      const detail = `Could not write the ${target.label} manifest: ${String(error?.message ?? error)}`;
      steps.push({ step: "manifest", ok: false, error: detail });
      logError(detail);
      return { ok: false, steps, status: status(), error: detail };
    }

    state.apps[appId] = true;
    writeState({ ...state, installedAt: state.installedAt ?? Date.now() });
    await applyListenerState(steps);

    return { ok: true, steps, status: status() };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  async function uninstall(appId) {
    const steps = [];
    const target = officeAppById(appId);
    if (!target) {
      return { ok: false, error: `Unknown Office app: ${appId}`, steps, status: status() };
    }

    const state = readState();
    const nextApps = { ...state.apps, [appId]: false };
    const lastOne = !Object.values(nextApps).some(Boolean);

    if (lastOne) {
      // Last app: remove the trust-store entry FIRST, before touching any
      // other state. If the user denies the keychain prompt, abort with
      // everything intact instead of stranding a trusted CA in the keychain.
      const untrust = untrustCa();
      steps.push({ step: "trust", ok: untrust.ok, ...(untrust.error ? { error: untrust.error } : {}) });
      if (!untrust.ok) {
        logError(`untrust failed: ${untrust.error}`);
        return {
          ok: false,
          steps,
          status: status(),
          error: `The certificate was not removed (${untrust.error}). Nothing was uninstalled.`,
        };
      }
      rmSync(certDir, { recursive: true, force: true });
      steps.push({ step: "certificate", ok: true });
    }

    rmSync(target.manifestPath, { force: true });
    steps.push({ step: "manifest", ok: true });

    writeState({ apps: nextApps, port: state.port, installedAt: lastOne ? null : state.installedAt });
    await applyListenerState(steps);

    return { ok: true, steps, status: status() };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  function openApp(appId) {
    const target = officeAppById(appId);
    if (!target) {
      return { ok: false, error: `Unknown Office app: ${appId}` };
    }
    if (!target.installed) {
      return { ok: false, error: `${target.label} is not installed on this machine.` };
    }
    // The sandbox container id doubles as the app's bundle id on macOS.
    const result = spawnSync("open", ["-b", target.container], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) {
      const detail =
        (result.stderr || result.stdout || "").trim() || `Could not open ${target.label}.`;
      logError(`open app failed: ${detail}`);
      return { ok: false, error: detail };
    }
    return { ok: true };
  }

  return { readState, serverConfig, status, install, uninstall, openApp };
}
