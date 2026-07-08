// Support-log bundle: gathers everything we know about the local runtime into
// one plain-text file the user can send to support. Used by the Help menu
// ("Collect Support Logs...") and by the boot error screen, i.e. exactly the
// situations where the embedded server never came up and the generic error
// message hides the cause.
//
// Contents are text-only and deliberately token-free:
//   - app/OS/arch metadata
//   - runtimeManager.collectRuntimeDiagnostics() (already redacts secrets)
//   - runtime-boot-failure.log written by describeRuntimeBootFailure()
//   - tails of any other *.log files in the app logs directory
//   - the packaged sidecar versions.json
// A final scrub pass redacts anything that still looks like a secret
// assignment, as a safety net for stderr passthrough from child processes.
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_TAIL_LIMIT = 64_000;

function tail(text, limit = LOG_TAIL_LIMIT) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `…(truncated)…\n${value.slice(value.length - limit)}`;
}

function readFileTail(filePath, limit = LOG_TAIL_LIMIT) {
  try {
    return tail(readFileSync(filePath, "utf8"), limit);
  } catch {
    return null;
  }
}

// Safety net on top of the already-redacted diagnostics: child-process stderr
// flows through verbatim, so scrub anything that looks like a secret
// assignment before the bundle leaves the machine.
export function scrubSecrets(text) {
  return String(text ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(
      /((?:token|password|secret|credential|authorization|api[-_]?key)[^\s:=]*["']?\s*[:=]\s*)(["']?)[^"'\s,;}]+\2/gi,
      "$1$2<redacted>$2",
    );
}

function section(title, body) {
  const content = String(body ?? "").trim() || "(empty)";
  return `\n========== ${title} ==========\n${content}\n`;
}

/** Timestamped default file name offered in the save dialog. */
export function defaultSupportBundleFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `legalwork-support-${stamp}.txt`;
}

/**
 * Build the bundle contents as one scrubbed plain-text string. Writing it to
 * disk is the caller's job (main.mjs shows a save dialog first, so the user
 * picks where the file goes).
 */
export function buildSupportBundleText({ app, runtimeManager }) {
  const parts = [];

  const meta = {
    app: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
    collectedAt: new Date().toISOString(),
  };
  parts.push(section("App / system", JSON.stringify(meta, null, 2)));

  try {
    const diagnostics = runtimeManager.collectRuntimeDiagnostics();
    parts.push(section("Runtime diagnostics", JSON.stringify(diagnostics, null, 2)));
  } catch (error) {
    parts.push(section("Runtime diagnostics", `collection failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  let logsDir = null;
  try {
    logsDir = app.getPath("logs");
  } catch {
    logsDir = null;
  }

  if (logsDir) {
    const bootFailurePath = path.join(logsDir, "runtime-boot-failure.log");
    const bootFailure = readFileTail(bootFailurePath);
    parts.push(section(`Boot failure log (${bootFailurePath})`, bootFailure ?? "(not present — no recorded boot failure)"));

    try {
      for (const entry of readdirSync(logsDir)) {
        if (!entry.endsWith(".log") || entry === "runtime-boot-failure.log") continue;
        const content = readFileTail(path.join(logsDir, entry));
        if (content) parts.push(section(`Log file: ${entry}`, content));
      }
    } catch {
      /* logs dir unreadable — the sections above still stand on their own */
    }
  }

  const sidecarsDirs = [
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
  ].filter(Boolean);
  for (const dir of sidecarsDirs) {
    const versions = readFileTail(path.join(dir, "versions.json"), 4_000);
    if (versions) parts.push(section(`Sidecar versions (${dir})`, versions));
  }

  return scrubSecrets(`LegalWork support bundle\n${parts.join("")}`);
}
