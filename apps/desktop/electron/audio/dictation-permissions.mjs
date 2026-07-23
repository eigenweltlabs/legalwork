/**
 * Readiness checks + guided re-prompts for "Dictate anywhere".
 *
 * Dictation crosses four OS permission boundaries that fail independently
 * and mostly silently:
 *
 *  - microphone: recording the speech (promptable).
 *  - inputMonitoring: the global hotkey listener (macOS Input Monitoring).
 *    The dangerous state is "broken": the pane toggle looks on, but the
 *    grant went stale (app updated under the same entry) and the OS lets
 *    the tap be created yet refuses to enable it. Detected end-to-end by
 *    the helper's `--check` probe, never by reading the pane state alone.
 *  - accessibility: pasting the transcript via a synthetic keystroke.
 *  - automation: the paste runs through System Events, which needs Apple
 *    Events consent. Its one-time alert is the permission users dismiss
 *    without reading; afterwards paste fails with a generic error unless
 *    we re-detect and deep-link the Automation pane.
 *
 * All native probes run through the key-monitor helper binary, spawned from
 * the app so macOS attributes prompts and pane entries to LegalWork.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveKeyMonitorPath } from "./system-key-monitor.mjs";

const CHECK_TIMEOUT_MS = 10_000;
// Consent alerts block the helper until the user answers them.
const REQUEST_TIMEOUT_MS = 120_000;

const MAC_PANE_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

/** tccutil service names, for resetting our own stale entries. */
const TCC_SERVICE_NAMES = {
  inputMonitoring: "ListenEvent",
  accessibility: "Accessibility",
  automation: "AppleEvents",
};

/** Spawn the helper in a one-shot mode and parse its single JSON line. */
function runHelperMode(app, mode, timeoutMs, spawnFn = spawn) {
  return new Promise((resolve) => {
    const executable = resolveKeyMonitorPath(app);
    if (!fs.existsSync(executable)) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawnFn(executable, [mode], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => finish(null));
    child.once("exit", () => {
      try {
        finish(JSON.parse(stdout.trim()));
      } catch {
        finish(null);
      }
    });
  });
}

/** @returns {Promise<import("@legalwork/types/audio").AudioDictationPermissionState>} */
async function inputMonitoringStatus(app, platform, spawnFn) {
  if (platform !== "darwin") return "not-required";
  const result = await runHelperMode(app, "--check", CHECK_TIMEOUT_MS, spawnFn);
  if (!result || typeof result.state !== "string") return "unavailable";
  if (result.state === "denied") return "denied";
  if (result.state !== "granted") return "not-determined";
  return result.tapCreated && result.tapEnabled ? "granted" : "broken";
}

/** @returns {Promise<import("@legalwork/types/audio").AudioDictationPermissionState>} */
async function automationStatus(app, platform, spawnFn) {
  if (platform !== "darwin") return "not-required";
  const result = await runHelperMode(app, "--check-automation", CHECK_TIMEOUT_MS, spawnFn);
  if (!result || typeof result.state !== "string") return "unavailable";
  return ["granted", "denied", "not-determined"].includes(result.state)
    ? result.state
    : "unavailable";
}

/** @returns {import("@legalwork/types/audio").AudioDictationPermissionState} */
function accessibilityStatus(systemPreferences, platform) {
  if (platform !== "darwin") return "not-required";
  try {
    return systemPreferences?.isTrustedAccessibilityClient?.(false) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export class DictationPermissions {
  /**
   * @param {{
   *   app: import("electron").App,
   *   systemPreferences: import("electron").SystemPreferences,
   *   shell: { openExternal: (url: string) => Promise<unknown> },
   *   captureAuthStatus: (app: import("electron").App) => import("@legalwork/types/audio").AudioCapturePermissions,
   *   platform?: string,
   *   spawn?: typeof spawn,
   *   execFile?: typeof execFile,
   * }} options
   */
  constructor(options) {
    this.app = options.app;
    this.systemPreferences = options.systemPreferences;
    this.shell = options.shell;
    this.captureAuthStatus = options.captureAuthStatus;
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? spawn;
    this.execFile = options.execFile ?? execFile;
    /** Last observed hotkey-listener state, for grant-transition detection. */
    this.lastInputMonitoring = null;
    /** @type {string | null} */
    this.cachedBundleId = null;
  }

  /**
   * The app's bundle identifier, read from the bundle on disk. Only
   * meaningful when packaged; dev runs are attributed to the launching app
   * and must never reset anyone's TCC entries.
   */
  async bundleIdentifier() {
    if (this.cachedBundleId) return this.cachedBundleId;
    if (this.platform !== "darwin" || !this.app.isPackaged) return null;
    // process.execPath: <App>.app/Contents/MacOS/<binary>
    const infoPlist = path.resolve(process.execPath, "..", "..", "Info");
    const id = await new Promise((resolve) => {
      this.execFile(
        "/usr/bin/defaults",
        ["read", infoPlist, "CFBundleIdentifier"],
        (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
      );
    });
    this.cachedBundleId = id;
    return id;
  }

  /** @returns {Promise<import("@legalwork/types/audio").AudioDictationReadiness>} */
  async readiness() {
    const [inputMonitoring, automation] = await Promise.all([
      inputMonitoringStatus(this.app, this.platform, this.spawn),
      automationStatus(this.app, this.platform, this.spawn),
    ]);
    return {
      platform: this.platform === "darwin" || this.platform === "linux"
        ? this.platform
        : this.platform === "win32"
          ? "windows"
          : "linux",
      packaged: this.app.isPackaged,
      microphone: this.captureAuthStatus(this.app).microphone,
      inputMonitoring,
      accessibility: accessibilityStatus(this.systemPreferences, this.platform),
      automation,
    };
  }

  /**
   * Whether the hotkey listener just became usable, so the caller can
   * restart the long-running key monitor (a monitor started under a stale
   * grant keeps its dead tap until respawned).
   */
  inputMonitoringBecameUsable(readiness) {
    const previous = this.lastInputMonitoring;
    this.lastInputMonitoring = readiness.inputMonitoring;
    return readiness.inputMonitoring === "granted" && previous !== null && previous !== "granted";
  }

  async openPane(kind) {
    const url = MAC_PANE_URLS[kind];
    if (this.platform !== "darwin" || !url) return;
    await this.shell.openExternal(url).catch(() => {});
  }

  /**
   * Fire the strongest available re-prompt for one permission, then report
   * fresh readiness. Prompts that macOS only ever shows once fall back to
   * deep-linking the exact pane.
   * @param {import("@legalwork/types/audio").AudioDictationPermissionKind} kind
   */
  async request(kind) {
    if (this.platform !== "darwin") {
      if (kind === "microphone") {
        // Windows: the mediaDevices prompt path is handled by the renderer;
        // the pane is the only OS surface to send people to.
        await this.openPane(kind);
      }
      return this.readiness();
    }
    if (kind === "microphone") {
      const current = this.captureAuthStatus(this.app).microphone;
      if (current === "not-determined") {
        await this.systemPreferences.askForMediaAccess?.("microphone").catch(() => {});
      } else if (current !== "granted") {
        await this.openPane("microphone");
      }
    } else if (kind === "inputMonitoring") {
      const current = await inputMonitoringStatus(this.app, this.platform, this.spawn);
      // Registers the app in the pane either way; prompts when undetermined.
      await runHelperMode(this.app, "--request", REQUEST_TIMEOUT_MS, this.spawn);
      if (current === "denied" || current === "broken") {
        // No second prompt exists; the user has to flip (or re-flip) the
        // toggle. Land them on the exact pane.
        await this.openPane("inputMonitoring");
      }
    } else if (kind === "accessibility") {
      try {
        // Prompts when the app is not in the list yet.
        this.systemPreferences.isTrustedAccessibilityClient?.(true);
      } catch {
        // The pane below remains the manual path.
      }
      await this.openPane("accessibility");
    } else if (kind === "automation") {
      const result = await runHelperMode(this.app, "--request-automation", REQUEST_TIMEOUT_MS, this.spawn);
      if (result?.state === "denied") {
        // The consent alert is one-time; afterwards only the pane helps.
        await this.openPane("automation");
      }
    }
    return this.readiness();
  }

  /**
   * One-click fix for stale grants: delete our own TCC entries for the
   * service (tccutil scoped to the app's bundle id needs no privileges),
   * then fire the fresh consent prompt via {@link request}.
   *
   * This is the programmatic version of the manual dance stale grants
   * otherwise force on users: remove the pane row that "looks on" but is
   * bound to an older build's signature, re-add, re-enable. Duplicate rows
   * (old + current build) are wiped in one go, which matters because the
   * stale twin is the one macOS keeps consulting.
   * @param {import("@legalwork/types/audio").AudioDictationPermissionKind} kind
   */
  async repair(kind) {
    const service = TCC_SERVICE_NAMES[kind];
    const bundleId = await this.bundleIdentifier();
    if (this.platform === "darwin" && service && bundleId) {
      await new Promise((resolve) => {
        this.execFile("/usr/bin/tccutil", ["reset", service, bundleId], () => resolve(undefined));
      });
    }
    return this.request(kind);
  }
}
