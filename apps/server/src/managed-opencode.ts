import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
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

/** Resolve with the server URL once the child prints "opencode server
 * listening", or reject if it exits / errors / times out first. The reject
 * message carries the child's captured output so callers can detect a
 * transient "database is locked" start failure. */
function waitForServerReady(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for OpenCode server after ${timeoutMs}ms`)),
      timeoutMs,
    );
    let output = "";
    const done = (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
        done(match[1]);
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output}` : ""}`)),
    );
  });
}

/** A terminate function scoped to one child: SIGTERM, wait for the process to
 * ACTUALLY exit (so callers never start a replacement engine while this one
 * still holds the DB lock), then SIGKILL if it overstays. Memoized so repeated
 * close() calls share one shutdown. */
function makeTerminator(child: ChildProcess, exited: Promise<void>): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  const alive = () => child.exitCode === null && child.signalCode === null;
  return () => {
    closePromise ??= (async () => {
      if (!alive()) return;
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
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const username = randomSecret();
  const password = randomSecret();
  const command = options.bin?.trim() || "opencode";
  const env = {
    ...process.env,
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const injectedEnv = Object.entries({
    ...(options.env ?? {}),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
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
    const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const terminate = makeTerminator(child, exited);

    try {
      const url = await waitForServerReady(child, options.timeoutMs ?? 15000);
      return {
        url,
        username,
        password,
        pid: child.pid ?? null,
        execution: { command, args, cwd: options.cwd, env: injectedEnv },
        close: terminate,
      };
    } catch (error) {
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
