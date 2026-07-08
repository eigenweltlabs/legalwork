/**
 * Platform backends for the Office add-in manager (see
 * office-addin-manager.mjs for the overall install/uninstall flow).
 *
 * A backend owns everything OS-specific:
 *  - which Office apps exist on this machine,
 *  - trusting/untrusting the per-install CA in the OS trust store,
 *  - installing/removing the add-in manifest per app,
 *  - launching an Office app.
 *
 * macOS: manifests are files in each app's sandboxed `wef` folder; trust is
 * the login keychain via `security`.
 *
 * Windows: manifests are registered as REG_SZ values under
 * HKCU\...\Office\16.0\WEF\Developer — the value name is the manifest's Id
 * and the data is the manifest's path on disk (the same mechanism
 * Microsoft's office-addin-dev-settings uses). Trust is the CurrentUser
 * Root store via `certutil` (one native confirmation dialog, no admin).
 * Office apps are detected through their App Paths registry entries, which
 * cover both MSI and Click-to-Run installs.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { CA_COMMON_NAME } from "./office-addin-cert.mjs";

const MANIFEST_FILENAME = "legalwork-office-addin.manifest.xml";

/**
 * @typedef {object} OfficeAppEntry
 * @property {"word" | "excel" | "powerpoint"} id
 * @property {string} label
 * @property {boolean} installed          The Office app exists on this machine.
 * @property {boolean} manifestInstalled  The LegalWork manifest is sideloaded for it.
 * @property {string} [unsupportedReason] Install is blocked (e.g. Microsoft Store Office).
 */

function logError(message) {
  console.error(`[office-addin] ${message}`);
}

// ── Shared pure helpers (exported for tests) ─────────────────────────────

/**
 * Extract the string data of the first REG_SZ/REG_EXPAND_SZ value in
 * `reg.exe query` output; expands %VAR% environment references.
 */
export function parseRegSzValue(output, env = process.env) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/\bREG_(?:EXPAND_)?SZ\s+(.*\S)/);
    if (match) {
      return match[1].replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
    }
  }
  return null;
}

/**
 * Office installed from the Microsoft Store lives under WindowsApps and
 * cannot load registry-sideloaded add-ins — installing would "succeed"
 * silently and never show up. Detected so install can fail with a clear
 * message instead.
 */
export function isStoreOfficeExecutable(exePath) {
  return /[\\/]WindowsApps[\\/]/i.test(String(exePath ?? ""));
}

/**
 * SHA-1 thumbprint (lowercase hex) of the first certificate in a PEM string
 * — the identifier Windows cert stores use (`certutil -verifystore Root
 * <thumbprint>`). Returns null when no certificate block is found.
 */
export function certSha1ThumbprintFromPem(pem) {
  const match = String(pem ?? "").match(
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\r\n\s]+?)-----END CERTIFICATE-----/,
  );
  if (!match) return null;
  try {
    const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    if (der.length === 0) return null;
    return createHash("sha1").update(der).digest("hex");
  } catch {
    return null;
  }
}

// ── macOS ────────────────────────────────────────────────────────────────

/** @type {ReadonlyArray<{ id: "word" | "excel" | "powerpoint"; label: string; container: string }>} */
const MAC_OFFICE_APPS = [
  { id: "word", label: "Word", container: "com.microsoft.Word" },
  { id: "excel", label: "Excel", container: "com.microsoft.Excel" },
  { id: "powerpoint", label: "PowerPoint", container: "com.microsoft.Powerpoint" },
];

/**
 * Real account home — homedir() lies when dev mode rewrites $HOME (see
 * buildChildEnv in runtime.mjs), so every user-home path MUST use the real
 * account home from the user database.
 */
function realHomeDir() {
  try {
    const info = userInfo();
    if (info?.homedir) return info.homedir;
  } catch {
    // Accounts without a passwd entry fall back to the env-derived home.
  }
  return homedir();
}

function createDarwinBackend({ certPaths }) {
  function loginKeychain() {
    return join(realHomeDir(), "Library", "Keychains", "login.keychain-db");
  }

  function officeApps() {
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

  function caTrusted() {
    const { caCertPath, leafCertPath } = certPaths;
    if (!existsSync(caCertPath) || !existsSync(leafCertPath)) return false;
    const result = spawnSync("security", ["verify-cert", "-c", leafCertPath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    return result.status === 0;
  }

  return {
    platformId: "darwin",

    /** @returns {OfficeAppEntry[]} */
    listApps() {
      return officeApps().map((entry) => ({
        id: entry.id,
        label: entry.label,
        installed: entry.installed,
        manifestInstalled: existsSync(entry.manifestPath),
      }));
    },

    /** macOS keeps one multi-host manifest per app folder. */
    manifestHost() {
      return undefined;
    },

    caTrusted,

    trustCa() {
      const { caCertPath } = certPaths;
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
    },

    untrustCa() {
      const { caCertPath } = certPaths;
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
    },

    writeManifest(appId, manifest) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
      try {
        mkdirSync(target.wefDir, { recursive: true });
        const current = existsSync(target.manifestPath) ? readFileSync(target.manifestPath, "utf8") : null;
        if (current !== manifest) writeFileSync(target.manifestPath, manifest, "utf8");
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `Could not write the ${target.label} manifest: ${String(error?.message ?? error)}`,
        };
      }
    },

    removeManifest(appId) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
      rmSync(target.manifestPath, { force: true });
      return { ok: true };
    },

    openApp(appId) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
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
    },
  };
}

// ── Windows ──────────────────────────────────────────────────────────────

const WIN_DEVELOPER_KEY = "HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer";

/**
 * Per-host manifest ids double as the registry value names. Keep in sync
 * with WORD_ADDIN_MANIFEST_IDS in apps/server/src/word-addin.ts and with
 * apps/desktop/build/installer.nsh (NSIS uninstall cleanup).
 */
const WIN_MANIFEST_IDS = {
  word: "fdea378d-ff62-4a4f-af08-d1622c083957",
  excel: "65facd67-9deb-4356-8072-e2cc6e36d9fe",
  powerpoint: "db1cc438-a239-4b01-b732-2ff838ecca38",
};

/** @type {ReadonlyArray<{ id: "word" | "excel" | "powerpoint"; label: string; exe: string }>} */
const WIN_OFFICE_APPS = [
  { id: "word", label: "Word", exe: "WINWORD.EXE" },
  { id: "excel", label: "Excel", exe: "EXCEL.EXE" },
  { id: "powerpoint", label: "PowerPoint", exe: "POWERPNT.EXE" },
];

function runReg(args, timeout = 15_000) {
  return spawnSync("reg.exe", args, { encoding: "utf8", timeout });
}

function runCertutil(args, timeout) {
  return spawnSync("certutil", args, { encoding: "utf8", timeout });
}

function createWin32Backend({ userDataDir, certPaths }) {
  function appPathsExecutable(exe) {
    // App Paths is maintained by the Office installer for both MSI and
    // Click-to-Run; the default value is the absolute executable path.
    const result = runReg([
      "query",
      `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      "/ve",
    ]);
    if (result.status !== 0) return null;
    const value = parseRegSzValue(result.stdout);
    return value && existsSync(value) ? value : null;
  }

  function manifestPathFor(appId) {
    return join(userDataDir, "office-addin-manifests", `legalwork-${appId}.manifest.xml`);
  }

  function registryValuePresent(appId) {
    return runReg(["query", WIN_DEVELOPER_KEY, "/v", WIN_MANIFEST_IDS[appId]]).status === 0;
  }

  function caThumbprint() {
    const { caCertPath } = certPaths;
    if (!existsSync(caCertPath)) return null;
    try {
      return certSha1ThumbprintFromPem(readFileSync(caCertPath, "utf8"));
    } catch {
      return null;
    }
  }

  function officeAppById(appId) {
    return WIN_OFFICE_APPS.find((entry) => entry.id === appId) ?? null;
  }

  function caTrusted() {
    const { caCertPath, leafCertPath } = certPaths;
    if (!existsSync(caCertPath) || !existsSync(leafCertPath)) return false;
    const thumbprint = caThumbprint();
    if (!thumbprint) return false;
    // Presence in the CurrentUser Root store makes the CA a trusted root
    // for WebView2/schannel; leafCertValid (checked at install) covers the
    // chain itself.
    return runCertutil(["-user", "-verifystore", "Root", thumbprint], 20_000).status === 0;
  }

  return {
    platformId: "win32",

    /** @returns {OfficeAppEntry[]} */
    listApps() {
      return WIN_OFFICE_APPS.map((entry) => {
        const executable = appPathsExecutable(entry.exe);
        return {
          id: entry.id,
          label: entry.label,
          installed: executable != null,
          manifestInstalled: existsSync(manifestPathFor(entry.id)) && registryValuePresent(entry.id),
          ...(executable && isStoreOfficeExecutable(executable)
            ? {
                unsupportedReason: `${entry.label} is installed from the Microsoft Store, which cannot load locally installed add-ins. Install the Microsoft 365 desktop apps (from office.com) to use the LegalWork add-in.`,
              }
            : {}),
        };
      });
    },

    /**
     * Windows registers each app individually: the registry value name must
     * be the manifest's Id, so each app gets a single-host manifest with its
     * own id.
     */
    manifestHost(appId) {
      return appId;
    },

    caTrusted,

    trustCa() {
      const { caCertPath } = certPaths;
      // Shows Windows' native root-store confirmation dialog; cancelling it
      // makes certutil exit non-zero.
      const result = runCertutil(["-user", "-addstore", "Root", caCertPath], 120_000);
      if (result.status !== 0) {
        return { ok: false, error: (result.stderr || result.stdout || "certutil -addstore failed").trim() };
      }
      return { ok: true };
    },

    untrustCa() {
      const { caCertPath } = certPaths;
      if (existsSync(caCertPath)) {
        const wasTrusted = caTrusted();
        // Delete by common name so stale CAs from older installs are swept
        // too; delstore removes one match per invocation.
        let lastResult = null;
        for (let i = 0; i < 8; i += 1) {
          const result = runCertutil(["-user", "-delstore", "Root", CA_COMMON_NAME], 120_000);
          lastResult = result;
          if (result.status !== 0) break;
        }
        // Like the keychain on macOS, removal shows a confirmation dialog;
        // the store state is the truth about whether the user allowed it.
        if (wasTrusted && caTrusted()) {
          const detail =
            (lastResult?.stderr || lastResult?.stdout || "").trim() ||
            "the certificate removal was not authorized";
          return { ok: false, error: detail };
        }
      }
      return { ok: true };
    },

    writeManifest(appId, manifest) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
      const manifestPath = manifestPathFor(appId);
      try {
        mkdirSync(dirname(manifestPath), { recursive: true });
        const current = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
        if (current !== manifest) writeFileSync(manifestPath, manifest, "utf8");
      } catch (error) {
        return {
          ok: false,
          error: `Could not write the ${target.label} manifest: ${String(error?.message ?? error)}`,
        };
      }
      const result = runReg([
        "add",
        WIN_DEVELOPER_KEY,
        "/v",
        WIN_MANIFEST_IDS[appId],
        "/t",
        "REG_SZ",
        "/d",
        manifestPath,
        "/f",
      ]);
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "reg add failed").trim();
        return { ok: false, error: `Could not register the ${target.label} manifest: ${detail}` };
      }
      return { ok: true };
    },

    removeManifest(appId) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
      // A missing value also exits non-zero, so the exit code alone is
      // ambiguous — re-query for the truth.
      const result = runReg(["delete", WIN_DEVELOPER_KEY, "/v", WIN_MANIFEST_IDS[appId], "/f"]);
      if (registryValuePresent(appId)) {
        const detail = (result.stderr || result.stdout || "reg delete failed").trim();
        return { ok: false, error: `Could not unregister the ${target.label} manifest: ${detail}` };
      }
      rmSync(manifestPathFor(appId), { force: true });
      return { ok: true };
    },

    openApp(appId) {
      const target = officeAppById(appId);
      if (!target) return { ok: false, error: `Unknown Office app: ${appId}` };
      const executable = appPathsExecutable(target.exe);
      if (!executable) {
        return { ok: false, error: `${target.label} is not installed on this machine.` };
      }
      try {
        const child = spawn(executable, [], { detached: true, stdio: "ignore" });
        child.on("error", (error) => logError(`open app failed: ${String(error?.message ?? error)}`));
        child.unref();
        return { ok: true };
      } catch (error) {
        const detail = String(error?.message ?? error);
        logError(`open app failed: ${detail}`);
        return { ok: false, error: detail };
      }
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Backend for the current platform, or null where installing the add-in is
 * not supported.
 *
 * @param {object} deps
 * @param {string} deps.userDataDir  Electron userData dir (manifest storage on Windows).
 * @param {{ caCertPath: string; leafCertPath: string; leafKeyPath: string }} deps.certPaths
 */
export function createOfficeAddinPlatformBackend({ userDataDir, certPaths }) {
  switch (platform()) {
    case "darwin":
      return createDarwinBackend({ certPaths });
    case "win32":
      return createWin32Backend({ userDataDir, certPaths });
    default:
      return null;
  }
}
