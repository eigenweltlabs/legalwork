/**
 * OS-level capture permissions for the Recorder tab.
 *
 * Reads the real TCC / OS status for the two permissions recording can need
 * and drives the guided "allow this" flow in the renderer:
 *
 *  - microphone: promptable via systemPreferences.askForMediaAccess.
 *  - systemAudio: the macOS "Screen & System Audio Recording" privacy pane.
 *    It gates BOTH the getDisplayMedia loopback (system audio) and the
 *    per-app Core Audio tap. There is no programmatic prompt — the user has
 *    to flip the toggle in System Settings, so we deep-link the exact pane.
 *
 * Dev caveat: unpackaged runs are attributed by macOS to the launching app
 * (terminal/IDE), not LegalWork. `packaged: false` lets the renderer show
 * that hint instead of confusing users with a missing "LegalWork" entry.
 */

import { shell, systemPreferences } from "electron";

const MAC_SETTINGS_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  // macOS 15 renamed the pane to "Screen & System Audio Recording"; the
  // ScreenCapture anchor still resolves to it.
  systemAudio: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

const WINDOWS_SETTINGS_URLS = {
  microphone: "ms-settings:privacy-microphone",
  // Windows loopback needs no permission; land users near the audio settings.
  systemAudio: "ms-settings:sound",
};

/** @returns {import("@legalwork/types/audio").AudioPermissionState} */
function mediaAccessStatus(kind) {
  try {
    const status = systemPreferences.getMediaAccessStatus(kind);
    return status === "granted" || status === "denied" || status === "not-determined" || status === "restricted"
      ? status
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** @returns {import("@legalwork/types/audio").AudioCapturePermissions} */
export function captureAuthStatus(app) {
  /** @type {import("@legalwork/types/audio").AudioCapturePermissions} */
  const permissions = {
    platform: process.platform,
    packaged: app.isPackaged,
    microphone: "granted",
    systemAudio: "granted",
  };
  if (process.platform === "darwin" || process.platform === "win32") {
    permissions.microphone = mediaAccessStatus("microphone");
  }
  if (process.platform === "darwin") {
    permissions.systemAudio = mediaAccessStatus("screen");
  }
  return permissions;
}

/** @returns {Promise<import("@legalwork/types/audio").AudioCapturePermissions>} */
export async function requestCapturePermission(app, kind) {
  if (kind === "microphone" && process.platform === "darwin") {
    // Shows the OS prompt when not-determined; resolves immediately otherwise.
    await systemPreferences.askForMediaAccess("microphone").catch(() => {});
  } else if (kind === "systemAudio") {
    // No programmatic prompt exists — send the user to the exact pane.
    await openCapturePermissionSettings(kind);
  }
  return captureAuthStatus(app);
}

/** @returns {Promise<boolean>} */
export async function openCapturePermissionSettings(kind) {
  const urls = process.platform === "darwin"
    ? MAC_SETTINGS_URLS
    : process.platform === "win32"
      ? WINDOWS_SETTINGS_URLS
      : null;
  const url = urls?.[kind];
  if (!url) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}
