// Support-log bundle: gathers everything we know about the local runtime into
// one plain-text file the user can send to support. Used by the Help menu
// ("Collect Support Logs..."), Settings > Updates and the boot error screen.
//
// Contents are text-only and deliberately token-free:
//   - app/OS/arch metadata
//   - how GitHub is reached: the system proxy and proxy env vars
//   - runtimeManager.collectRuntimeDiagnostics() (already redacts secrets)
//   - runtime-boot-failure.log written by describeRuntimeBootFailure()
//   - any other *.log files in the app logs directory, e.g. main.log with
//     every main-process error (main-error-log.mjs)
//   - the packaged sidecar versions.json
// A final scrub pass redacts anything that still looks like a secret
// assignment, as a safety net for stderr passthrough from child processes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// main.log rotates at 1 MB, so this keeps every log file whole.
const LOG_TAIL_LIMIT = 2_000_000;

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

/** Collect desktop traces locally; the server removes chat bodies and credentials before returning the export. */
export async function collectTechnicalSupportBundle({ app, runtimeManager, serverInfo, days = 7, fetchImpl = fetch }) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Choose a whole number of days from 1 to 365.");
  if (!serverInfo.running || !serverInfo.baseUrl || !serverInfo.hostToken) {
    throw new Error("Start the local LegalWork service before exporting technical diagnostics.");
  }
  const logs = [];
  let logsError = null;
  const since = Date.now() - days * 86400000;
  try {
    const logsDir = app.getPath("logs");
    for (const name of readdirSync(logsDir).filter(name => name.endsWith(".log")).sort().slice(-10)) {
      const logPath = path.join(logsDir, name);
      const modifiedAt = statSync(logPath).mtimeMs;
      if (modifiedAt < since) {
        logs.push({ name, modifiedAt, excludedBeforePeriod: true });
        continue;
      }
      const content = readFileTail(logPath);
      let include = true;
      let excludedLines = 0;
      const lines = content === null ? null : content.split(/\r?\n/).filter(line => {
        const timestamp = /^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line)?.[1];
        if (timestamp) include = Date.parse(timestamp) >= since;
        if (!include) excludedLines++;
        // Continuation lines (including stacks) inherit the preceding timestamp.
        return include;
      });
      // Separate lines preserve the newest log entries when individual string limits apply.
      logs.push({ name, modifiedAt, lines, excludedLines, tailLimit: LOG_TAIL_LIMIT, unavailable: content === null });
    }
  } catch (error) { logsError = error instanceof Error ? error.message : String(error); }
  let runtime;
  try { runtime = await runtimeManager.collectRuntimeDiagnostics(); }
  catch (error) { runtime = { error: error instanceof Error ? error.message : String(error) }; }
  const sidecarVersionsPath = process.resourcesPath ? path.join(process.resourcesPath, "sidecars", "versions.json") : null;
  const desktop = {
    app: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged },
    system: { platform: process.platform, arch: process.arch, osRelease: os.release(), versions: process.versions,
      uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpu: process.cpuUsage() },
    runtime, logs, logsError, logFileLimit: 10,
    sidecarVersions: sidecarVersionsPath ? readFileTail(sidecarVersionsPath, 16_000) : null,
  };
  const response = await fetchImpl(`${serverInfo.baseUrl}/diagnostics/export`, {
    method: "POST",
    headers: { "X-LegalWork-Host-Token": serverInfo.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ desktop, days }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error("Technical diagnostics could not be collected from the local service.");
  const diagnostics = await response.json();
  if (diagnostics?.format !== "legalwork-technical-diagnostics" || diagnostics.schemaVersion !== 2) {
    throw new Error("This service does not support the technical diagnostics export.");
  }
  if (diagnostics.scope?.days !== days) throw new Error("Restart the local LegalWork service to use the selected export period.");
  return JSON.stringify(diagnostics, null, 2);
}

/**
 * Build the bundle contents as one scrubbed plain-text string. Writing it to
 * disk is the caller's job (main.mjs shows a save dialog first, so the user
 * picks where the file goes). `network` is how this machine reaches GitHub,
 * which main.mjs looks up asynchronously.
 */
export async function buildSupportBundleText({ app, runtimeManager, network = null }) {
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
  if (network) parts.push(section("Network", JSON.stringify(network, null, 2)));

  try {
    const diagnostics = await runtimeManager.collectRuntimeDiagnostics();
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
