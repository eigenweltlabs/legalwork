import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const retiredDeveloperLauncherMessage = "The extra developer engine launcher is retired. Use 'legalwork serve --workspace <folder>' for the supported LegalWork server runtime. Original registry and configuration files are preserved. Existing developer daemons can still be inspected or stopped with 'legalwork daemon status' or 'legalwork daemon stop'.";

type LegacyDaemon = { pid: number; port: number; baseUrl: string; startedAt: number };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function daemon(value: unknown): LegacyDaemon | undefined {
  if (!record(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0
    || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.baseUrl !== "string" || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt <= 0) return;
  return { pid: value.pid, port: value.port, baseUrl: value.baseUrl, startedAt: value.startedAt };
}
function loopback(value: LegacyDaemon): URL {
  const url = new URL(value.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || Number(url.port || "80") !== value.port) throw new Error("Refusing to contact a legacy daemon without an exact loopback registry address. Its files were preserved.");
  return url;
}

/** Compatibility is read/verified HTTP shutdown only: never start an engine,
 * rewrite the registry, follow redirects, or kill a PID from a saved file. */
export async function legacyDeveloperDaemon(dataDirectory: string, stop: boolean) {
  let saved: unknown;
  try { saved = JSON.parse(await readFile(join(dataDirectory, "legalwork-orchestrator-state.json"), "utf8")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("The legacy developer registry could not be read. Preserve it for inspection; no process was changed.", { cause: error });
  }
  if (!record(saved) || saved.daemon === undefined) return { ok: true, retired: true, running: false, stopped: false };
  const expected = daemon(saved.daemon);
  if (!expected) throw new Error("The legacy daemon identity is invalid. Its registry was preserved and no process was changed.");
  const base = loopback(expected);
  try { process.kill(expected.pid, 0); }
  catch { return { ok: true, retired: true, running: false, stopped: false }; }
  const response = await fetch(new URL("/health", base), { redirect: "error", signal: AbortSignal.timeout(3000) });
  const health: unknown = await response.json();
  const actual = record(health) ? daemon(health.daemon) : undefined;
  if (!response.ok || !record(health) || health.ok !== true || !actual || actual.pid !== expected.pid || actual.port !== expected.port
    || actual.startedAt !== expected.startedAt || loopback(actual).href !== base.href) throw new Error("The loopback service does not match the saved developer daemon identity. No shutdown was sent and its files were preserved.");
  if (stop) {
    const stopped = await fetch(new URL("/shutdown", base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!stopped.ok) throw new Error(`The verified legacy daemon did not accept shutdown (HTTP ${stopped.status}).`);
  }
  return { ok: true, retired: true, running: !stop, stopped: stop, daemon: expected };
}
