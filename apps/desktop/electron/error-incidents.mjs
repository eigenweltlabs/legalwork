import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { scrubSecrets } from "./support-bundle.mjs";

const SOURCES = new Set(["main_uncaught", "main_unhandledrejection", "sidecar_exit", "renderer_exit"]);
const CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError", "DOMException"]);
const MODULES = new Set(["main.mjs", "runtime.mjs", "updater.mjs", "workspace-store.mjs", "browser-panel.mjs", "safe-open.mjs", "error-incidents.mjs"]);
const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
function nativeFrames(error) {
  if (typeof error?.stack !== "string") return [];
  return error.stack.split("\n").slice(1, 40).flatMap(line => {
    const match = line.match(/(?:\(|\s)((?:file:\/\/|\/|[A-Z]:\\).+):(\d+):(\d+)\)?$/i);
    if (!match) return [];
    try {
      const file = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1];
      const asset = path.basename(file);
      const lineno = Number(match[2]); const column = Number(match[3]);
      if (path.dirname(file) !== MODULE_ROOT || !MODULES.has(asset) || lineno < 1 || lineno > 10_000_000 || column > 10_000_000) return [];
      return [{ asset, chunk_id: null, line: lineno, column }];
    } catch { return []; }
  }).slice(0, 8);
}
const TTL = 24 * 60 * 60 * 1000;
const safeVersion = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/i.test(value) && value.length <= 80 ? value : null;

/** Sanitized main-process summary; raw details never enter the incident backlog.
 * @param {string} source
 * @param {{ name?: string; stack?: string }} error
 * @param {{ version?: string; platform?: string; exitCode?: number | null }} [options]
 */
export function createNativeDiagnostic(source, error, { version, platform, exitCode } = {}) {
  if (!SOURCES.has(source)) return null;
  const name = CLASSES.has(error?.name) ? error.name : "other";
  const code = source === "sidecar_exit" ? "engine_crash" : source === "renderer_exit" ? "renderer_crash" : "application_error";
  const frames = nativeFrames(error);
  const component = source === "sidecar_exit" ? "engine" : "desktop";
  return {
    schema_version: 1, incident_id: randomUUID(), occurred_at: new Date().toISOString(),
    code, error_class: name, native_code: null, component, source, operation: source === "renderer_exit" ? "render" : "uncaught", phase: source === "renderer_exit" ? "render" : "unknown",
    status_code: null, provider: "unknown", model_family: "unknown", api_format: "unknown",
    app_version: safeVersion(version), engine_version: null, server_version: null, build_id: null,
    platform: ["darwin", "win32", "linux"].includes(platform) ? platform : "unknown", surface: "desktop",
    retryable: null, retry_count: null, duration_ms: null,
    exit_code: Number.isInteger(exitCode) && exitCode >= -1 && exitCode <= 65535 ? exitCode : null,
    causes: [], frames, fingerprint: createHash("sha256").update(JSON.stringify([code, name, component, source, exitCode, frames])).digest("hex").slice(0, 16),
  };
}
export function createNativeIncidentStore(directory) {
  const file = path.join(directory, "error-incidents.json");
  let records = [];
  const details = new Map();
  try {
    if (statSync(file).size <= 128_000) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(value)) records = value.filter(item => SOURCES.has(item?.source) && typeof item.incident_id === "string");
    }
  } catch { /* First launch or unavailable storage. */ }
  function prune() {
    records = records.filter(item => Date.parse(item.occurred_at) >= Date.now() - TTL).slice(-30);
    const retained = new Set(records.map(item => item.incident_id));
    for (const id of details.keys()) if (!retained.has(id)) details.delete(id);
  }
  function persist() {
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(records), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* Memory remains usable; never report a reporting failure. */ }
  }
  return {
    record(source, error, context) {
      const diagnostic = createNativeDiagnostic(source, error, context);
      if (!diagnostic) return null;
      prune(); records.push(diagnostic);
      // Raw details remain in memory; the on-disk crash backlog stays sanitized.
      details.set(diagnostic.incident_id, {
        name: typeof error?.name === "string" ? scrubSecrets(error.name) : "Error",
        message: typeof error?.message === "string" ? scrubSecrets(error.message) : typeof error === "string" ? scrubSecrets(error) : diagnostic.code,
        stack: typeof error?.stack === "string" ? scrubSecrets(error.stack) : null,
        exception: scrubSecrets(inspect(error, { depth: 20, maxArrayLength: 10_000, maxStringLength: 2_000_000, getters: false, customInspect: false })),
        context: scrubSecrets(inspect(context, { depth: 20, getters: false, customInspect: false })),
      });
      prune(); persist();
      return diagnostic;
    },
    list() { prune(); persist(); return records; },
    details(id) { prune(); return details.get(id) ?? null; },
    clear() { records = []; details.clear(); persist(); },
  };
}
