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
 *  - manifest install/removal per Office app.
 *
 * Everything OS-specific (trust store, manifest registration, app detection
 * and launch) lives in office-addin-platform.mjs; this module owns state,
 * certificates, manifest building, and orchestration. Supported platforms
 * are macOS and Windows — elsewhere the backend is null and status reports
 * `supported: false`.
 *
 * Privileged steps (trust store) shell out to platform tools and surface a
 * single OS prompt. Operations return structured results with per-step
 * outcomes and real error details; failures also log to the main console.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  caFingerprint,
  ensureLocalCert,
  leafCertValid,
  officeAddinCertToolAvailable,
} from "./office-addin-cert.mjs";
import { createOfficeAddinPlatformBackend } from "./office-addin-platform.mjs";

const DEFAULT_PORT = 47443;

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

  function certPaths() {
    return {
      caCertPath: join(certDir, "legalwork-local-ca.crt"),
      leafCertPath: join(certDir, "localhost.crt"),
      leafKeyPath: join(certDir, "localhost.key"),
    };
  }

  const backend = createOfficeAddinPlatformBackend({ userDataDir, certPaths: certPaths() });

  function unsupportedResult(steps = []) {
    return {
      ok: false,
      error: "The Office add-in installer supports macOS and Windows only.",
      steps,
      status: status(),
    };
  }

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

  // ── Manifests ─────────────────────────────────────────────────────────
  async function buildManifest(port, host) {
    const dist = locateServerDist?.();
    if (!dist) return null;
    const modulePath = join(dist, "word-addin.js");
    if (!existsSync(modulePath)) return null;
    const { buildWordAddinManifest } = await import(pathToFileURL(modulePath).href);
    const version = typeof app.getVersion === "function" ? `${app.getVersion()}.0` : undefined;
    return buildWordAddinManifest({
      baseUrl: `https://localhost:${port}`,
      version,
      ...(host ? { host } : {}),
    });
  }

  // ── Shared install pieces ─────────────────────────────────────────────
  async function ensureCertAndTrust(steps) {
    try {
      const { leafCertPath, caCertPath } = await ensureLocalCert(certDir);
      const valid = leafCertValid(leafCertPath, caCertPath);
      steps.push({ step: "certificate", ok: valid });
      if (!valid) return "The generated certificate did not validate against its CA.";
    } catch (error) {
      const detail = String(error?.message ?? error);
      steps.push({ step: "certificate", ok: false, error: detail });
      logError(`certificate generation failed: ${detail}`);
      return `Certificate generation failed: ${detail}`;
    }

    if (backend.caTrusted()) {
      steps.push({ step: "trust", ok: true, skipped: true });
      return null;
    }
    const trust = backend.trustCa();
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
    const apps = (backend?.listApps() ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      installed: entry.installed,
      enabled: state.apps[entry.id] === true,
      manifestInstalled: entry.manifestInstalled,
    }));
    return {
      supported: backend != null,
      platform: platform(),
      toolAvailable: officeAddinCertToolAvailable(),
      enabled: anyEnabled(state),
      port: state.port,
      installedAt: state.installedAt,
      certPresent: existsSync(leafCertPath),
      certTrusted: backend?.caTrusted() ?? false,
      caFingerprint: caFingerprint(caCertPath),
      paneBundlePresent: Boolean(locatePaneDist?.() && existsSync(join(locatePaneDist(), "taskpane.html"))),
      apps,
    };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  async function install(appId) {
    const steps = [];
    if (!backend) return unsupportedResult(steps);
    const target = backend.listApps().find((entry) => entry.id === appId) ?? null;
    if (!target) {
      return { ok: false, error: `Unknown Office app: ${appId}`, steps, status: status() };
    }
    if (!target.installed) {
      return { ok: false, error: `${target.label} is not installed on this machine.`, steps, status: status() };
    }
    // Checked before any cert/trust work so unsupported Office variants
    // (e.g. Microsoft Store installs) fail fast without OS prompts.
    if (target.unsupportedReason) {
      return { ok: false, error: target.unsupportedReason, steps, status: status() };
    }
    if (!officeAddinCertToolAvailable()) {
      return { ok: false, error: "OpenSSL is required to generate the certificate but was not found.", steps, status: status() };
    }

    const state = readState();

    const certError = await ensureCertAndTrust(steps);
    if (certError) {
      return { ok: false, steps, status: status(), error: certError };
    }

    const manifest = await buildManifest(state.port, backend.manifestHost(appId));
    if (!manifest) {
      const detail = "Could not build the add-in manifest (server bundle missing).";
      steps.push({ step: "manifest", ok: false, error: detail });
      logError(detail);
      return { ok: false, steps, status: status(), error: detail };
    }
    const written = backend.writeManifest(appId, manifest);
    steps.push({ step: "manifest", ok: written.ok, ...(written.error ? { error: written.error } : {}) });
    if (!written.ok) {
      logError(written.error);
      return { ok: false, steps, status: status(), error: written.error };
    }

    state.apps[appId] = true;
    writeState({ ...state, installedAt: state.installedAt ?? Date.now() });
    await applyListenerState(steps);

    return { ok: true, steps, status: status() };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  async function uninstall(appId) {
    const steps = [];
    if (!backend) return unsupportedResult(steps);
    const target = backend.listApps().find((entry) => entry.id === appId) ?? null;
    if (!target) {
      return { ok: false, error: `Unknown Office app: ${appId}`, steps, status: status() };
    }

    const state = readState();
    const nextApps = { ...state.apps, [appId]: false };
    const lastOne = !Object.values(nextApps).some(Boolean);

    if (lastOne) {
      // Last app: remove the trust-store entry FIRST, before touching any
      // other state. If the user denies the OS prompt, abort with
      // everything intact instead of stranding a trusted CA in the store.
      const untrust = backend.untrustCa();
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

    const removed = backend.removeManifest(appId);
    steps.push({ step: "manifest", ok: removed.ok, ...(removed.error ? { error: removed.error } : {}) });
    if (!removed.ok) {
      logError(removed.error);
      return { ok: false, steps, status: status(), error: removed.error };
    }

    writeState({ apps: nextApps, port: state.port, installedAt: lastOne ? null : state.installedAt });
    await applyListenerState(steps);

    return { ok: true, steps, status: status() };
  }

  /** @param {"word" | "excel" | "powerpoint"} appId */
  function openApp(appId) {
    if (!backend) {
      return { ok: false, error: "The Office add-in installer supports macOS and Windows only." };
    }
    return backend.openApp(appId);
  }

  return { readState, serverConfig, status, install, uninstall, openApp };
}
