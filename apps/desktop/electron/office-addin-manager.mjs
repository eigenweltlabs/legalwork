/**
 * Production manager for the LegalWork Office add-in (Word/Excel/PowerPoint).
 *
 * Owns everything the "Office Add-ins" settings tab drives:
 *  - a persisted enable/disable state (read by startLegalworkServer so the
 *    HTTPS listener comes up on every launch when installed),
 *  - a per-install, localhost-constrained CA + leaf certificate,
 *  - OS trust-store install/removal of that CA,
 *  - manifest install/removal into each Office app's sideload folder,
 *  - status reporting for the UI.
 *
 * Privileged steps (trust store) shell out to platform tools and surface a
 * single OS auth prompt. Every operation is best-effort and returns a
 * structured result with per-step outcomes; nothing throws fatally.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
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

  function readState() {
    try {
      const raw = readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled === true,
        port: Number.isFinite(parsed.port) ? parsed.port : DEFAULT_PORT,
        installedAt: Number.isFinite(parsed.installedAt) ? parsed.installedAt : null,
      };
    } catch {
      return { enabled: false, port: DEFAULT_PORT, installedAt: null };
    }
  }

  function writeState(next) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  function certPaths() {
    return {
      caCertPath: join(certDir, "legalwork-local-ca.crt"),
      leafCertPath: join(certDir, "localhost.crt"),
      leafKeyPath: join(certDir, "localhost.key"),
    };
  }

  /**
   * Server config the embedded server should launch with, based on persisted
   * state. Returns null when the add-in is disabled or its files are missing,
   * so the listener stays off.
   */
  function serverConfig() {
    const state = readState();
    if (!state.enabled) return null;
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
    return join(homedir(), "Library", "Keychains", "login.keychain-db");
  }

  function caTrusted() {
    if (platform() !== "darwin") return false;
    const { caCertPath, leafCertPath } = certPaths();
    if (!existsSync(caCertPath) || !existsSync(leafCertPath)) return false;
    // verify-cert consults the OS trust store; it only passes when the CA is
    // present AND trusted for SSL.
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
    // Adds to the user's login keychain and marks it trusted for SSL. Shows
    // one native auth prompt; no sudo. Restrict trust to SSL server policy.
    const result = spawnSync(
      "security",
      ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychain(), caCertPath],
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
      spawnSync("security", ["remove-trusted-cert", caCertPath], { encoding: "utf8", timeout: 30_000 });
    }
    // Remove every copy of our CA from the login keychain (loop: delete-certificate
    // removes one match at a time).
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
    return MAC_OFFICE_APPS.map((entry) => {
      const containerDir = join(homedir(), "Library", "Containers", entry.container);
      const wefDir = join(containerDir, "Data", "Documents", "wef");
      return {
        ...entry,
        installed: existsSync(containerDir),
        wefDir,
        manifestPath: join(wefDir, MANIFEST_FILENAME),
      };
    });
  }

  function installManifests(manifest) {
    const results = [];
    for (const entry of officeApps()) {
      if (!entry.installed) {
        results.push({ app: entry.id, label: entry.label, present: false, changed: false });
        continue;
      }
      try {
        mkdirSync(entry.wefDir, { recursive: true });
        const current = existsSync(entry.manifestPath) ? readFileSync(entry.manifestPath, "utf8") : null;
        if (current !== manifest) writeFileSync(entry.manifestPath, manifest, "utf8");
        results.push({ app: entry.id, label: entry.label, present: true, changed: current !== manifest });
      } catch (error) {
        results.push({ app: entry.id, label: entry.label, present: true, changed: false, error: String(error?.message ?? error) });
      }
    }
    return results;
  }

  function removeManifests() {
    for (const entry of officeApps()) {
      rmSync(entry.manifestPath, { force: true });
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
      manifestInstalled: existsSync(entry.manifestPath),
    }));
    return {
      supported: platform() === "darwin",
      platform: platform(),
      toolAvailable: officeAddinCertToolAvailable(),
      enabled: state.enabled,
      port: state.port,
      installedAt: state.installedAt,
      certPresent: existsSync(leafCertPath),
      certTrusted: caTrusted(),
      caFingerprint: caFingerprint(caCertPath),
      paneBundlePresent: Boolean(locatePaneDist?.() && existsSync(join(locatePaneDist(), "taskpane.html"))),
      apps,
    };
  }

  async function install() {
    const steps = [];
    if (platform() !== "darwin") {
      return { ok: false, error: "The Office add-in installer currently supports macOS only.", status: status() };
    }
    if (!officeAddinCertToolAvailable()) {
      return { ok: false, error: "OpenSSL is required to generate the certificate but was not found.", status: status() };
    }

    const port = readState().port || DEFAULT_PORT;

    // 1. Certificate.
    try {
      const { leafCertPath, caCertPath } = ensureLocalCert(certDir);
      steps.push({ step: "certificate", ok: leafCertValid(leafCertPath, caCertPath) });
    } catch (error) {
      steps.push({ step: "certificate", ok: false, error: String(error?.message ?? error) });
      return { ok: false, steps, status: status(), error: "Certificate generation failed." };
    }

    // 2. Trust (single OS auth prompt). Idempotent — skip if already trusted.
    if (caTrusted()) {
      steps.push({ step: "trust", ok: true, skipped: true });
    } else {
      const trust = trustCa();
      steps.push({ step: "trust", ok: trust.ok, ...(trust.error ? { error: trust.error } : {}) });
      if (!trust.ok) {
        return { ok: false, steps, status: status(), error: `Could not trust the certificate: ${trust.error}` };
      }
    }

    // 3. Manifests.
    const manifest = await buildManifest(port);
    if (!manifest) {
      steps.push({ step: "manifest", ok: false, error: "Could not build the add-in manifest (server bundle missing)." });
      return { ok: false, steps, status: status(), error: "Add-in manifest could not be built." };
    }
    const manifestResults = installManifests(manifest);
    steps.push({ step: "manifest", ok: true, apps: manifestResults });

    // 4. Persist enabled + start the listener.
    writeState({ enabled: true, port, installedAt: Date.now() });
    try {
      await requestServerRestart();
      steps.push({ step: "listener", ok: true });
    } catch (error) {
      steps.push({ step: "listener", ok: false, error: String(error?.message ?? error) });
    }

    return { ok: true, steps, status: status() };
  }

  async function uninstall() {
    const steps = [];

    removeManifests();
    steps.push({ step: "manifest", ok: true });

    const untrust = untrustCa();
    steps.push({ step: "trust", ok: untrust.ok });

    // Keep the generated key material out of the way once uninstalled.
    rmSync(certDir, { recursive: true, force: true });
    steps.push({ step: "certificate", ok: true });

    writeState({ enabled: false, port: readState().port, installedAt: null });
    try {
      await requestServerRestart();
      steps.push({ step: "listener", ok: true });
    } catch (error) {
      steps.push({ step: "listener", ok: false, error: String(error?.message ?? error) });
    }

    return { ok: true, steps, status: status() };
  }

  return { readState, serverConfig, status, install, uninstall };
}
