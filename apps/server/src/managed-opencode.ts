import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { OpenCode, type MigrationV1StatusOutput } from "@opencode/client";
import { expectedOpencodeServiceFilename, expectedOpencodeVersion, type VerifiedOpencodeCandidate } from "@legalwork/opencode-release/candidate";
import { prepareManagedOpencodeService, type ManagedOpencodeServiceOptions } from "./managed-opencode-service.js";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  running: () => boolean;
  execution: OpencodeExecutionSnapshot;
  close: () => Promise<void>;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

// opencode keeps a single persistent SQLite DB (WAL mode) shared across every
// launch. When the app restarts, the previous engine's OS file lock can still
// be releasing as the new one starts, so the fresh `serve` fails to open the
// DB with "database is locked". That is transient — it clears within a second
// or two once the old process is fully reaped — so we retry the spawn with
// backoff instead of surfacing it as a boot failure. See close(), which now
// waits for the previous engine to ACTUALLY exit so this race is rare.
const START_MAX_ATTEMPTS = 4;
const START_RETRY_BASE_MS = 500;
const DB_LOCKED_PATTERN = /database is locked|database table is locked|SQLITE_BUSY/i;

// close() gives the engine this long to handle SIGTERM (flush + WAL checkpoint
// + release the lock cleanly) before escalating to SIGKILL. It resolves as soon
// as the process exits; the value is only a ceiling on a graceful shutdown.
const SIGTERM_GRACE_MS = 3000;
const SIGKILL_GRACE_MS = 2000;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

/** Resolve once before verification. Never search for a different executable
 * after the first executable PATH match fails its independently pinned check. */
export async function resolveEngineExecutable(binary: string, cwd: string, env: Record<string, string | undefined>): Promise<string> {
  const windows = process.platform === "win32";
  const name = windows && !path.extname(binary) ? `${binary}.exe` : binary;
  if (windows && !name.toLowerCase().endsWith(".exe")) throw new Error("The managed OpenCode engine must be a native .exe executable.");
  const explicit = path.isAbsolute(binary) || binary.includes(path.sep) || windows && (binary.includes("/") || /^[a-z]:/i.test(binary));
  const pathKey = windows ? Object.keys(env).sort().find(key => key.toUpperCase() === "PATH" && typeof env[key] === "string") : "PATH";
  const lookupPath = (pathKey ? env[pathKey] : undefined) ?? (windows ? process.env.PATH ?? process.env.Path ?? "" : "/usr/bin:/bin");
  for (const directory of explicit ? [""] : lookupPath.split(path.delimiter)) {
    const candidate = explicit ? path.resolve(cwd, name) : path.resolve(cwd, directory || ".", name);
    try {
      if (!(await stat(candidate)).isFile()) {
        if (explicit) throw new Error("The managed OpenCode executable must be a file.");
        continue;
      }
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (explicit || !(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))) throw error;
    }
  }
  throw new Error(`Cannot find the managed OpenCode executable ${binary} in the child PATH.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePortOnce(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

/** Resolve with the v2 server URL once the child announces its listener,
 * or reject if it exits / errors / times out first. The reject
 * message carries the child's captured output so callers can detect a
 * transient "database is locked" start failure. */
function waitForServerReady(child: ChildProcess, timeoutMs: number, parentLease = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", fail);
      child.off("exit", onExit);
    };
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (parentLease) {
          let info: unknown;
          try { info = JSON.parse(line); } catch { continue; }
          if (typeof info !== "object" || info === null || !("url" in info) || typeof info.url !== "string") continue;
          if (!/^https?:\/\//.test(info.url)) return fail(new Error("OpenCode returned an invalid stdin lease URL."));
          done(info.url);
          return;
        }
        if (!line.startsWith("server listening on ")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
        done(match[1]);
      }
    };
    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };
    const onExit = (code: number | null) =>
      fail(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output}` : ""}`));
    const timeout = setTimeout(
      () => fail(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms${output.trim() ? `\n${output}` : ""}`)),
      timeoutMs,
    );
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", fail);
    child.once("exit", onExit);
  });
}

async function waitForHttpReady(child: ChildProcess, url: string, username: string, password: string, timeoutMs: number, expectedVersion: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  let lastError = "No API response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("OpenCode server exited before its HTTP listener was ready");
    }
    try {
      const response = await fetch(new URL("/api/info", url), {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) { lastError = `HTTP ${response.status}`; await response.body?.cancel(); await delay(100); continue; }
      const info: unknown = await response.json();
      if (typeof info === "object" && info !== null && "version" in info &&
          typeof info.version === "string" && info.version === expectedVersion &&
          "pid" in info && info.pid === child.pid) return;
      lastError = `The info response did not identify the spawned OpenCode ${expectedVersion} process`;
      await delay(100);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  throw new Error(`Timeout waiting for OpenCode HTTP listener after ${timeoutMs}ms: ${lastError}`);
}

/** The HTTP listener starts before upstream's asynchronous history conversion.
 * Never expose an apparently empty engine while that conversion is still running. */
async function waitForMigration(child: ChildProcess, url: string, username: string, password: string,
  signal?: AbortSignal, onProgress?: (status: MigrationV1StatusOutput) => void): Promise<void> {
  const controller = new AbortController();
  const onExit = () => controller.abort(new Error("OpenCode server exited while migrating chat history"));
  const onAbort = () => controller.abort(signal?.reason ?? new Error("OpenCode startup was cancelled"));
  child.once("exit", onExit);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (child.exitCode !== null || child.signalCode !== null) onExit();
  if (signal?.aborted) onAbort();
  const client = OpenCode.make({ baseUrl: url,
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } });
  try {
    while (true) {
      controller.signal.throwIfAborted();
      const status = await client.migration.v1.status({ signal: controller.signal });
      if (!["running", "completed", "error"].includes(status.status)) throw new Error("OpenCode returned an invalid chat history migration status.");
      onProgress?.(status);
      if (status.status === "completed") return;
      if (status.status === "error") throw new Error(`OpenCode chat history migration failed: ${status.error}`);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 250);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    }
  } finally {
    child.off("exit", onExit);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A terminate function scoped to one child: SIGTERM, wait for the process to
 * ACTUALLY exit (so callers never start a replacement engine while this one
 * still holds the DB lock), then SIGKILL if it overstays. Memoized so repeated
 * close() calls share one shutdown. */
function makeTerminator(child: ChildProcess, exited: Promise<void>, parentLease = false): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  return () => {
    closePromise ??= (async () => {
      if (!alive()) return;
      if (parentLease) {
        // Upstream --stdio closes its HTTP scope on stdin EOF, including EOF
        // received during startup. SIGTERM/KILL remain bounded fallbacks.
        child.stdin?.end();
        await Promise.race([exited, delay(SIGTERM_GRACE_MS)]);
        if (!alive()) return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, delay(SIGTERM_GRACE_MS)]);
      if (alive()) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        await Promise.race([exited, delay(SIGKILL_GRACE_MS)]);
      }
    })();
    return closePromise;
  };
}

export async function createManagedOpencodeServer(options: {
  bin?: string;
  /** Host-only verified artifact; never sourced from HTTP or authored config. */
  candidateBuild?: VerifiedOpencodeCandidate;
  cwd: string;
  hostname?: string;
  port?: number;
  logLevel?: string;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onMigrationProgress?: (status: MigrationV1StatusOutput) => void;
  /** Enables the released server's durable restart continuity in private state. */
  service?: ManagedOpencodeServiceOptions;
  /** Native stdin lease: keep temporary recovery HTTP tied to this parent. */
  parentLease?: boolean;
  /** After any verified predecessor exits, before native recovery may start. */
  beforeSpawn?: () => Promise<void>;
  /** Published only after authenticated HTTP info verifies this child's PID. */
  onAuthenticated?: (endpoint: { url: string; username: string; password: string; pid: number | null }) => void;
}): Promise<ManagedOpencodeServer> {
  options.signal?.throwIfAborted();
  const hostname = options.hostname ?? "127.0.0.1";
  const username = "opencode";
  const password = randomSecret();
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  const command = await resolveEngineExecutable(options.bin?.trim() || "opencode", options.cwd, env);
  await expectedOpencodeVersion(command, options.candidateBuild);
  if (options.service && options.parentLease) throw new Error("A managed engine cannot combine native service and stdin lease modes.");
  const serviceEnv = options.service ? await prepareManagedOpencodeService({ ...options.service,
    filename: await expectedOpencodeServiceFilename(command, options.candidateBuild),
    executablePath: command,
  }, password) : {};
  await options.beforeSpawn?.();
  Object.assign(env, {
    ...serviceEnv,
    // FFF's background scan reads document contents; filename lookup can use ripgrep.
    OPENCODE_DISABLE_FFF: "true",
    // Use the runtime's supported OS trust store for native provider/MCP TLS.
    NODE_USE_SYSTEM_CA: "1",
    ...(options.service ? {} : { OPENCODE_PASSWORD: password }),
  });
  if (options.service) delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  const injectedEnv = Object.entries({
    ...(options.env ?? {}),
    ...serviceEnv,
    OPENCODE_DISABLE_FFF: "true",
    NODE_USE_SYSTEM_CA: "1",
    ...(options.service ? {} : { OPENCODE_PASSWORD: password }),
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  let lastError: unknown;
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    // Fresh free port each attempt: a start failure never bound a port, and a
    // retry should steer clear of one a slow-dying predecessor may still hold.
    const port = options.port ?? (await findFreePort(hostname, options.excludedPorts));
    const args = ["serve", ...(options.service ? ["--service"] : options.parentLease ? ["--stdio"] : []), "--hostname", hostname, "--port", String(port), "--cors", "*"];
    if (options.logLevel) args.push("--log-level", options.logLevel);
    const expectedVersion = await expectedOpencodeVersion(command, options.candidateBuild);
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: [options.parentLease ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const terminate = makeTerminator(child, exited, options.parentLease);
    const abortStartup = () => { void terminate(); };
    options.signal?.addEventListener("abort", abortStartup, { once: true });
    let closing = false;
    let lastStderr = "";
    child.stderr?.on("data", (chunk) => {
      lastStderr = (lastStderr + chunk.toString()).slice(-2000);
    });

    try {
      const startedAt = Date.now();
      const timeoutMs = options.timeoutMs ?? 15000;
      const url = await waitForServerReady(child, timeoutMs, options.parentLease);
      await waitForHttpReady(child, url, username, password, Math.max(1, timeoutMs - (Date.now() - startedAt)), expectedVersion);
      options.onAuthenticated?.({ url, username, password, pid: child.pid ?? null });
      await waitForMigration(child, url, username, password, options.signal, options.onMigrationProgress);
      options.signal?.removeEventListener("abort", abortStartup);
      child.once("exit", (code, signal) => {
        if (!closing) {
          console.error(`[managed-opencode] engine exited after startup (code ${code}, signal ${signal})${lastStderr.trim() ? `: ${lastStderr.trim()}` : ""}`);
        }
      });
      return {
        url,
        username,
        password,
        pid: child.pid ?? null,
        running: () => child.exitCode === null && child.signalCode === null,
        execution: { command, args, cwd: options.cwd, env: injectedEnv },
        close: () => {
          closing = true;
          return terminate();
        },
      };
    } catch (error) {
      options.signal?.removeEventListener("abort", abortStartup);
      lastError = error;
      // Make sure this attempt's child is fully gone before retrying or giving
      // up, so it never lingers holding the port or the DB lock.
      await terminate();
      const locked = error instanceof Error && DB_LOCKED_PATTERN.test(error.message);
      if (!locked || attempt === START_MAX_ATTEMPTS - 1) throw error;
      const backoff = START_RETRY_BASE_MS * 2 ** attempt; // 500ms, 1s, 2s
      console.warn(
        `[managed-opencode] engine DB locked on start (attempt ${attempt + 1}/${START_MAX_ATTEMPTS}); retrying in ${backoff}ms`,
      );
      await delay(backoff);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenCode server failed to start");
}
