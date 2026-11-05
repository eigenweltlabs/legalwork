import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { constants, realpathSync, statSync } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { OpenCode } from "@opencode/client";
import { opencodeReleaseTarget } from "../../../packages/opencode-release/index.mjs";

const serverCredentials = new Map();

function resolveBasicAuthHeader() {
  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim() ?? "";
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

export function makeClient({ baseUrl, directory }) {
  const authorization = serverCredentials.get(baseUrl) ?? resolveBasicAuthHeader();
  return OpenCode.make({
    baseUrl,
    headers: authorization ? { Authorization: authorization } : undefined,
  });
}

export async function readMessages(client, sessionID) {
  const messages = [], seen = new Set();
  let cursor;
  do {
    const page = await client.message.list({ sessionID, ...(cursor ? { cursor } : { order: "asc" }) });
    messages.push(...page.data);
    cursor = page.cursor.next;
    if (cursor && seen.has(cursor)) throw new Error("The engine repeated a message page cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
}

export function messageText(message) {
  return message.type === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n")
    : typeof message.text === "string" ? message.text : message.payload?.text ?? "";
}

export async function readTodos(client, sessionID) {
  for (const message of (await readMessages(client, sessionID)).toReversed()) {
    if (message.type !== "assistant") continue;
    for (const part of message.content.toReversed()) {
      if (part.type === "tool" && part.name === "todowrite" && part.state.status === "completed" && Array.isArray(part.state.metadata?.todos)) return part.state.metadata.todos;
    }
  }
  return [];
}

export async function findFreePort() {
  const server = net.createServer();
  server.unref();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();

  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to allocate a free port");
  }

  const port = addr.port;
  server.close();
  return port;
}

export async function resolveOpencodeBinary({
  env = process.env,
  resourcesDirectory = fileURLToPath(new URL("../../desktop/resources/", import.meta.url)),
  selection,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const filename = platform === "win32" ? "opencode.exe" : "opencode";
  let candidate = env.LEGALWORK_TEST_OPENCODE_BIN ?? env.OPENCODE_BIN;
  if (candidate === undefined) {
    // Import prepared build metadata only when resolving the actual engine.
    // UI unit tests supply fixture selections and need no compiled binary.
    selection ??= (await import("../../../packages/opencode-release/selection.mjs")).opencodeEngineSelection;
    candidate = selection.kind === "derivative"
      ? join(resourcesDirectory, "opencode-engine", selection.artifactId, opencodeReleaseTarget(platform, arch), filename)
      : join(resourcesDirectory, "sidecars", filename);
  }
  if (!candidate.trim()) throw new Error("OpenCode test executable must be a nonempty path");
  try {
    const executable = await realpath(candidate);
    if (!(await stat(executable)).isFile()) throw new Error("Expected a regular executable file");
    await access(executable, constants.X_OK);
    return executable;
  } catch (cause) {
    throw new Error(`OpenCode test executable is unavailable (${candidate}): ${cause.message}`, { cause });
  }
}

export async function spawnOpencodeServe({
  directory,
  hostname = "127.0.0.1",
  port,
  corsOrigins = [],
  env = {},
}) {
  assert.ok(directory && directory.trim(), "directory is required");
  assert.ok(Number.isInteger(port) && port > 0, "port must be a positive integer");

  const cwd = realpathSync(directory);
  const inheritedEnv = { ...process.env, ...env };
  const executable = await resolveOpencodeBinary({ env: inheritedEnv });
  const args = ["serve", "--hostname", hostname, "--port", String(port)];
  for (const origin of corsOrigins) {
    args.push("--cors", origin);
  }

  const privateRoot = await mkdtemp(join(tmpdir(), "legalwork-native-script-"));
  const password = randomUUID();
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...inheritedEnv,
      // Make it explicit we're a non-TUI client.
      OPENCODE_CLIENT: "legalwork-test",
      OPENCODE_PASSWORD: password,
      OPENCODE_DB: join(privateRoot, "engine.db"),
      HOME: join(privateRoot, "home"),
      USERPROFILE: join(privateRoot, "home"),
      OPENCODE_CONFIG: env.OPENCODE_CONFIG ?? "",
      OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT ?? "",
      OPENCODE_CONFIG_DIR: env.OPENCODE_CONFIG_DIR ?? join(privateRoot, "config"),
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? join(privateRoot, "config"),
      XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(privateRoot, "data"),
      XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(privateRoot, "state"),
      XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(privateRoot, "cache"),
    },
  });

  const baseUrl = `http://${hostname}:${port}`;
  // If the process dies early or never becomes healthy, surface its output so
  // CI failures are diagnosable instead of showing an empty stderr.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  try {
    await once(child, "spawn");
  } catch (cause) {
    await rm(privateRoot, { recursive: true, force: true });
    throw new Error(`Cannot start OpenCode (${executable}): ${cause.message}`, { cause });
  }
  serverCredentials.set(baseUrl, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);

  async function waitForExit(ms) {
    return Promise.race([
      once(child, "exit").then(() => true),
      new Promise((r) => setTimeout(() => r(false), ms)),
    ]);
  }

  return {
    cwd,
    baseUrl,
    child,
    async close() {
      try {
        if (child.exitCode !== null || child.signalCode !== null) return;

      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      const exited = await waitForExit(2500);
      if (exited) {
        return;
      }

      // Force kill.
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }

      await waitForExit(2500);
      } finally { serverCredentials.delete(baseUrl); await rm(privateRoot, { recursive: true, force: true }); }
    },
    getStderr() {
      return stderr;
    },
    getStdout() {
      return stdout;
    },
    getExitInfo() {
      return { exitCode: child.exitCode, signalCode: child.signalCode };
    },
  };
}

export async function waitForHealthy(
  client,
  { timeoutMs = 30_000, pollMs = 250, requestTimeoutMs = 5_000 } = {},
) {
  const start = Date.now();
  let lastError;

  while (Date.now() - start < timeoutMs) {
    try {
      // Bound each individual request: a single fetch to a port that is not
      // yet accepting connections can otherwise block for the OS-level connect
      // timeout (tens of seconds on macOS), blowing past `timeoutMs` because
      // the loop can only re-check the deadline between awaits.
      const health = await client.server.info({
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      assert.ok(typeof health.version === "string");
      return health;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for /api/info: ${msg}`);
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (typeof raw.type === "string") {
    return { type: raw.type, data: raw.data, location: raw.location };
  }

  if (raw.payload && typeof raw.payload === "object" && typeof raw.payload.type === "string") {
    return { type: raw.payload.type, properties: raw.payload.properties };
  }

  return null;
}

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args.set(key, value);
  }
  return args;
}

export function canWriteWorkspace(directory) {
  try {
    const stat = statSync(directory);
    return stat && stat.isDirectory();
  } catch {
    return false;
  }
}
