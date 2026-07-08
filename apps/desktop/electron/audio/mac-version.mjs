import os from "node:os";

/**
 * macOS version as [major, minor], robust outside Electron too.
 *
 * `process.getSystemVersion()` only exists in Electron processes; plain-node
 * contexts (unit tests, the transcription worker fork) fall back to the
 * Darwin kernel version, whose major maps to the macOS major since Big Sur
 * (22 → 13, 23 → 14, …) and whose minor tracks the macOS minor.
 */
export function macOsVersion() {
  if (process.platform !== "darwin") return [0, 0];
  const fromElectron = String(process.getSystemVersion?.() ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (Number.isFinite(fromElectron[0]) && fromElectron[0] > 0) {
    return [fromElectron[0], Number.isFinite(fromElectron[1]) ? fromElectron[1] : 0];
  }
  const kernel = os.release().split(".").map((part) => Number.parseInt(part, 10));
  if (Number.isFinite(kernel[0]) && kernel[0] >= 20) {
    return [kernel[0] - 9, Number.isFinite(kernel[1]) ? kernel[1] : 0];
  }
  return [0, 0];
}

export function macOsAtLeast(major, minor = 0) {
  const [gotMajor, gotMinor] = macOsVersion();
  return gotMajor > major || (gotMajor === major && gotMinor >= minor);
}
