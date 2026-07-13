import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { createOfficeAddinManager } from "./office-addin-manager.mjs";

const __runtimeDir = path.dirname(fileURLToPath(import.meta.url));

/** Directory holding the built server bundle (embedded.js, word-addin.js). */
function locateServerDistDir() {
  const candidates = [
    path.resolve(__runtimeDir, "..", "..", "server", "dist"),
    path.resolve(__runtimeDir, "..", "server", "dist"),
    ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "server", "dist")] : []),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "word-addin.js"))) ?? null;
}

/** Directory holding the built Office task pane bundle (taskpane.html). */
function locatePaneDistDir() {
  const candidates = [
    path.resolve(__runtimeDir, "..", "..", "app", "dist-word-addin"),
    ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "word-addin-dist")] : []),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "taskpane.html"))) ?? null;
}

const DIRECT_RUNTIME = "direct";
const ORCHESTRATOR_RUNTIME = "legalwork-orchestrator";
const LEGALWORK_SERVER_PORT_RANGE_START = 48_000;
const LEGALWORK_SERVER_PORT_RANGE_END = 51_000;

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function appendOutput(state, key, chunk) {
  const next = `${state[key] ?? ""}${String(chunk ?? "")}`;
  state[key] = truncateOutput(next);
}

function normalizeWorkspaceKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();
}

export function prioritizeWorkspacePaths(preferredPath, workspacePaths = []) {
  const preferred = String(preferredPath ?? "").trim();
  const paths = [];
  const seen = new Set();
  const add = (value) => {
    const workspacePath = String(value ?? "").trim();
    const key = normalizeWorkspaceKey(workspacePath);
    if (!workspacePath || !key || seen.has(key)) return;
    paths.push(workspacePath);
    seen.add(key);
  };
  add(preferred);
  for (const workspacePath of workspacePaths) add(workspacePath);
  return paths;
}

export function resolveLegalworkServerConfigPath(env = process.env) {
  const override = String(env.LEGALWORK_SERVER_CONFIG ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim();
    const root = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(root, "legalwork", "server.json");
  }
  const xdgConfigHome = String(env.XDG_CONFIG_HOME ?? "").trim();
  const root = xdgConfigHome || path.join(os.homedir(), ".config");
  return path.join(root, "legalwork", "server.json");
}

export function seedWorkspacePathsForEmbeddedServer(workspacePaths, serverConfigExists) {
  return serverConfigExists ? [] : workspacePaths;
}

export function selectStickyLegalworkPortWorkspace(requestedWorkspacePaths = [], serverWorkspacePaths = []) {
  for (const value of [...requestedWorkspacePaths, ...serverWorkspacePaths]) {
    const workspacePath = String(value ?? "").trim();
    if (workspacePath) return workspacePath;
  }
  return "";
}

// Env overrides that point OpenCode at an app-owned directory tree rooted at
// `root`, used as a fallback when the user's standard config/data locations
// (e.g. ~/.config/opencode) are not writable. Mirrors the dev-mode layout.
// Pure + exported so the layout is unit-testable without touching the FS.
export function opencodeHomeEnvFromRoot(root) {
  return {
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
  };
}

export function commandMatchesPackagedSidecar(command, sidecarDirs = []) {
  const value = String(command ?? "");
  if (!sidecarDirs.some((dir) => String(dir ?? "").trim() && value.includes(dir))) {
    return false;
  }
  return value.includes("legalwork-orchestrator") ||
    value.includes("legalwork-server") ||
    /(?:^|[/\\])opencode[^/\\\s]*\s+serve\b/.test(value);
}

function nowMs() {
  return Date.now();
}

function createEngineState() {
  return {
    child: null,
    childExited: true,
    runtime: DIRECT_RUNTIME,
    projectDir: null,
    hostname: null,
    port: null,
    baseUrl: null,
    opencodeUsername: null,
    opencodePassword: null,
    opencodeBinPath: null,
    opencodeBinSource: null,
    lastStdout: null,
    lastStderr: null,
    execution: null,
  };
}

function snapshotEngineState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
    runtime: state.runtime,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    opencodeBinPath: state.opencodeBinPath,
    opencodeBinSource: state.opencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    execution: state.execution,
  };
}

function createLegalworkServerState() {
  return {
    child: null,
    childExited: true,
    inProcess: false,
    remoteAccessEnabled: false,
    host: null,
    port: null,
    baseUrl: null,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: null,
    ownerToken: null,
    hostToken: null,
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    lastStdout: null,
    lastStderr: null,
    managedOpencodeExecution: null,
  };
}

function snapshotLegalworkServerState(state) {
  const child = state.childExited ? null : state.child;
  const running = state.inProcess || Boolean(child && child.exitCode === null && !child.killed);
  return {
    running,
    remoteAccessEnabled: state.remoteAccessEnabled,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    connectUrl: state.connectUrl,
    mdnsUrl: state.mdnsUrl,
    lanUrl: state.lanUrl,
    clientToken: state.clientToken,
    ownerToken: state.ownerToken,
    hostToken: state.hostToken,
    managedOpencodeBinPath: state.managedOpencodeBinPath,
    managedOpencodeBinSource: state.managedOpencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    managedOpencodeExecution: state.managedOpencodeExecution,
  };
}

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function redactedExecutionSnapshot(command, args, cwd, injectedEnv) {
  return {
    command,
    args: [...args],
    cwd,
    env: Object.entries(injectedEnv ?? {})
      .filter((entry) => typeof entry[1] === "string")
      .map(([name, value]) => ({
        name,
        value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
        redacted: SECRET_ENV_PATTERN.test(name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function assertLegalworkServerReady(snapshot) {
  if (!snapshot?.running) {
    throw new Error("LegalWork server did not stay running after startup.");
  }
  if (!snapshot.baseUrl) {
    throw new Error("LegalWork server did not report a base URL after startup.");
  }
  if (!snapshot.ownerToken && !snapshot.clientToken) {
    throw new Error("LegalWork server did not report an access token after startup.");
  }
  return snapshot;
}

function createOrchestratorState() {
  return {
    child: null,
    childExited: true,
    dataDir: null,
    baseUrl: null,
    daemonPort: null,
    lastStdout: null,
    lastStderr: null,
  };
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function selectLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry && entry.family === "IPv4" && entry.internal === false) {
        return entry.address;
      }
    }
  }
  return null;
}

function buildConnectUrls(port) {
  const hostname = os.hostname().trim();
  const mdnsUrl = hostname ? `http://${hostname.replace(/\.local$/i, "")}.local:${port}` : null;
  const lan = selectLanAddress();
  const lanUrl = lan ? `http://${lan}:${port}` : null;
  return {
    connectUrl: lanUrl ?? mdnsUrl,
    mdnsUrl,
    lanUrl,
  };
}

function targetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
}

function binaryFileNames(baseName) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const triple = targetTriple();
  return [
    triple ? `${baseName}-${triple}${ext}` : null,
    `${baseName}${ext}`,
  ].filter(Boolean);
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function nvmVersionBinPaths(home) {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "bin"))
      .filter(isDirectory)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function pathHelperEntries() {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/libexec/path_helper", ["-s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  const stdout = String(result.stdout ?? "");
  const match = stdout.match(/PATH="([^"]+)"/) ?? stdout.match(/PATH=([^;\n]+)/);
  return match?.[1]?.split(path.delimiter).filter(Boolean) ?? [];
}

function extraPathEntries() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === "darwin") {
    candidates.push(
      ...pathHelperEntries(),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "linux") {
    candidates.push(
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "win32") {
    candidates.push(
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm") : null,
    );
  }

  return candidates.filter((entry) => entry && isDirectory(entry));
}

function enrichedPath(sidecarDirs, currentPath, fallbackDirs = []) {
  const entries = [
    ...sidecarDirs.filter(isDirectory),
    ...extraPathEntries(),
    ...String(currentPath ?? "").split(path.delimiter).filter(Boolean),
    ...fallbackDirs.filter(isDirectory),
  ];
  const deduped = entries.filter((entry, index) => entries.indexOf(entry) === index);
  return deduped.length > 0 ? deduped.join(path.delimiter) : null;
}

export function nodeShimFileName(platform = process.platform) {
  return platform === "win32" ? "node.cmd" : "node";
}

// A `node` that re-execs this app's own binary in Node mode. Electron ships a
// full Node runtime, so machines without a system Node.js can still run the
// bundled workspace skills (docx-edit, pdf-tools, tabular-review), which shell
// out to `node`. The shim directory is appended LAST to the child PATH, so any
// real Node installation always wins.
export function nodeShimScriptContent(execPath, platform = process.platform) {
  if (platform === "win32") {
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`;
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${execPath}" "$@"\n`;
}

async function portAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Resolves ~/.config/legalwork/env.json (or %APPDATA%\legalwork\env.json on
// Windows) — must agree byte-for-byte with apps/server/src/env-file.ts and
// apps/orchestrator/src/cli.ts. Honor LEGALWORK_ENV_STORE override.
function resolveUserEnvFilePath() {
  const override = String(process.env.LEGALWORK_ENV_STORE ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim();
    const root = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(root, "legalwork", "env.json");
  }
  return path.join(os.homedir(), ".config", "legalwork", "env.json");
}

const USER_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_ENV_RESERVED_PREFIXES = ["LEGALWORK_", "OPENCODE_"];

// Synchronous, best-effort; absent or malformed returns {}. Reserved prefixes
// are stripped so a tampered file can never shadow LEGALWORK_* / OPENCODE_*.
function loadUserEnvFile() {
  try {
    const raw = readFileSync(resolveUserEnvFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.variables)) return {};
    const out = {};
    for (const entry of parsed.variables) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!USER_ENV_KEY_PATTERN.test(key)) continue;
      if (USER_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths, recorder, onSidecarExit }) {
  const engineState = createEngineState();
  const legalworkServerState = createLegalworkServerState();
  const orchestratorState = createOrchestratorState();

  // Report an unexpected sidecar (agent runtime) exit as a content-free signal.
  // Intentional stops/restarts are filtered out in spawnManagedChild via the
  // intentional-stop registry that stopChild marks, and a crash loop is
  // deduped to one event per session by the renderer's app_error throttle.
  function reportSidecarCrash(detail = {}) {
    try {
      // A numeric exit uses the code directly; a signal-terminated exit is
      // encoded as the conventional 128 + signal number (137 = SIGKILL/OOM,
      // 139 = SIGSEGV, ...); a spawn failure (error event) has no code.
      const { code = null, signal = null } = detail;
      let exitCode = null;
      if (typeof code === "number") exitCode = code;
      else if (signal) exitCode = 128 + (os.constants.signals[signal] ?? 0);
      onSidecarExit?.({ exitCode });
    } catch {
      // Never let crash reporting throw.
    }
  }

  // Serialize engine lifecycle operations. Without this, concurrent renderer
  // invocations of engineStart/engineStop/engineRestart race: each call's
  // stopAllRuntimeChildren kills the previous call's freshly-spawned
  // orchestrator daemon, and the prior call then times out its /health probe.
  /** @type {Promise<unknown>} */
  let runtimeLifecycleQueue = Promise.resolve();
  let lifecycleState = "idle";
  /**
   * Serialize engine lifecycle operations; preserves the wrapped function's
   * return type (untyped, this collapsed runtime-manager inference to
   * Promise<void> and blocked tightening the DesktopCommandMap results).
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withRuntimeLifecycle(fn) {
    const next = runtimeLifecycleQueue.then(fn, fn);
    runtimeLifecycleQueue = next.catch(() => {});
    return next;
  }

  const userDataDir = app.getPath("userData");
  const sidecarDirs = [
    path.join(desktopRoot, "resources", "sidecars"),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    path.join(path.dirname(app.getPath("exe")), "sidecars"),
  ].filter(Boolean);

  // Office add-in (Word/Excel/PowerPoint) manager. Install/uninstall is driven
  // by the "Office Add-ins" settings tab; startLegalworkServer reads its state
  // so the HTTPS listener comes up on every launch when installed.
  const officeAddinManager = createOfficeAddinManager({
    app,
    locateServerDist: locateServerDistDir,
    locatePaneDist: locatePaneDistDir,
    requestServerRestart: () => withRuntimeLifecycle(() => legalworkServerRestart({})),
  });

  function legalworkServerTokenStorePath() {
    return path.join(userDataDir, "legalwork-server-tokens.json");
  }

  function legalworkServerStatePath() {
    return path.join(userDataDir, "legalwork-server-state.json");
  }

  function managedOpencodeWorkdir() {
    return path.join(userDataDir, "managed-opencode-workdir");
  }

  function orchestratorDataDir() {
    const envDir = process.env.LEGALWORK_DATA_DIR?.trim();
    if (envDir) return envDir;
    return path.join(app.getPath("home"), ".legalwork", "legalwork-orchestrator");
  }

  function orchestratorStatePath(dataDir) {
    return path.join(dataDir, "legalwork-orchestrator-state.json");
  }

  function orchestratorAuthPath(dataDir) {
    return path.join(dataDir, "legalwork-orchestrator-auth.json");
  }

  async function readOrchestratorStateFile(dataDir) {
    return readJsonFile(orchestratorStatePath(dataDir), null);
  }

  async function readOrchestratorAuthFile(dataDir) {
    return readJsonFile(orchestratorAuthPath(dataDir), null);
  }

  async function writeOrchestratorAuthFile(dataDir, auth) {
    const filePath = orchestratorAuthPath(dataDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ ...auth, updatedAt: nowMs() }, null, 2)}\n`, "utf8");
  }

  async function clearOrchestratorAuthFile(dataDir) {
    await rm(orchestratorAuthPath(dataDir), { force: true });
  }

  async function requestOrchestratorShutdown(dataDir) {
    const state = await readOrchestratorStateFile(dataDir);
    const baseUrl = state?.daemon?.baseUrl?.trim();
    if (!baseUrl) return false;
    try {
      await fetch(`${baseUrl.replace(/\/+$/, "")}/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function loadTokenStore() {
    return readJsonFile(legalworkServerTokenStorePath(), { version: 1, workspaces: {} });
  }

  async function saveTokenStore(store) {
    const filePath = legalworkServerTokenStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  async function loadPortState() {
    return readJsonFile(legalworkServerStatePath(), {
      version: 3,
      workspacePorts: {},
      preferredPort: null,
    });
  }

  async function savePortState(state) {
    const filePath = legalworkServerStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function loadOrCreateWorkspaceTokens(workspaceKey) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (store.workspaces?.[normalized]) {
      return store.workspaces[normalized];
    }
    const next = {
      clientToken: randomUUID(),
      hostToken: randomUUID(),
      ownerToken: null,
      updatedAt: nowMs(),
    };
    store.workspaces ??= {};
    store.workspaces[normalized] = next;
    await saveTokenStore(store);
    return next;
  }

  async function persistWorkspaceOwnerToken(workspaceKey, ownerToken) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (!store.workspaces?.[normalized]) return;
    store.workspaces[normalized].ownerToken = ownerToken;
    store.workspaces[normalized].updatedAt = nowMs();
    await saveTokenStore(store);
  }

  async function readPreferredLegalworkPort(workspaceKey) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (normalized && state.workspacePorts?.[normalized]) {
      return state.workspacePorts[normalized];
    }
    return state.preferredPort ?? null;
  }

  async function persistPreferredLegalworkPort(workspaceKey, port) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    state.version = 3;
    state.workspacePorts ??= {};
    if (normalized) {
      state.workspacePorts[normalized] = port;
      state.preferredPort = null;
    } else {
      state.preferredPort = port;
    }
    await savePortState(state);
  }

  async function waitForPortAvailable(host, port, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portAvailable(host, port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return portAvailable(host, port);
  }

  async function resolveLegalworkPort(host, workspaceKey, currentPort = null) {
    const preferredPort = await readPreferredLegalworkPort(workspaceKey);
    if (currentPort && (await waitForPortAvailable(host, currentPort))) {
      return { port: currentPort, preferredPort };
    }
    if (preferredPort && (await waitForPortAvailable(host, preferredPort))) {
      return { port: preferredPort, preferredPort };
    }
    return { port: await findFreePort(host), preferredPort };
  }

  async function ensureDevModePaths() {
    const root = path.join(userDataDir, "legalwork-dev-data");
    const paths = {
      homeDir: path.join(root, "home"),
      xdgConfigHome: path.join(root, "xdg", "config"),
      xdgDataHome: path.join(root, "xdg", "data"),
      xdgCacheHome: path.join(root, "xdg", "cache"),
      xdgStateHome: path.join(root, "xdg", "state"),
      opencodeConfigDir: path.join(root, "config", "opencode"),
    };

    for (const dir of Object.values(paths)) {
      await mkdir(dir, { recursive: true });
    }
    await mkdir(path.join(paths.xdgDataHome, "opencode"), { recursive: true });
    return paths;
  }

  // Can OpenCode create + write its dir under `parent` (…/opencode)? Probes by
  // creating the dir and round-tripping a marker file, so it catches both an
  // unwritable parent (mkdir EACCES) and a pre-existing but unwritable dir.
  async function opencodeDirIsWritable(parent) {
    const dir = path.join(parent, "opencode");
    const probe = path.join(dir, ".legalwork-write-probe");
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(probe, "");
      await rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // Production only. OpenCode uses its standard config/data locations
  // (~/.config/opencode + ~/.local/share/opencode). If those aren't writable —
  // most commonly ~/.config ends up owned by root after someone runs a tool
  // with sudo — OpenCode dies at startup with EACCES and the embedded server
  // never finishes coming up. Detect that once per launch and, only then,
  // redirect OpenCode to an app-owned directory under userData so a broken
  // ~/.config can't block the app. Returns the env overrides to apply, or null
  // when the standard locations are fine (leave them untouched) / on Windows.
  let opencodeHomeOverridePromise = null;
  function ensureWritableOpencodeHome() {
    opencodeHomeOverridePromise ??= (async () => {
      if (process.platform === "win32") return null;
      const home = app.getPath("home");
      const configParent = String(process.env.XDG_CONFIG_HOME ?? "").trim() || path.join(home, ".config");
      const dataParent = String(process.env.XDG_DATA_HOME ?? "").trim() || path.join(home, ".local", "share");
      const [configOk, dataOk] = await Promise.all([
        opencodeDirIsWritable(configParent),
        opencodeDirIsWritable(dataParent),
      ]);
      if (configOk && dataOk) return null;

      const root = path.join(userDataDir, "opencode-home");
      const overrideEnv = opencodeHomeEnvFromRoot(root);
      for (const dir of Object.values(overrideEnv)) {
        await mkdir(dir, { recursive: true });
      }
      await mkdir(path.join(overrideEnv.XDG_DATA_HOME, "opencode"), { recursive: true });
      console.warn(
        `[runtime] OpenCode's standard config/data location is not writable ` +
          `(config: ${configParent}, data: ${dataParent}); redirecting OpenCode to ${root}. ` +
          `The original is likely owned by root — restoring ownership of ~/.config would let OpenCode use it again.`,
      );
      return overrideEnv;
    })().catch((error) => {
      console.warn("[runtime] failed to prepare a writable OpenCode home:", error);
      return null;
    });
    return opencodeHomeOverridePromise;
  }

  // Written once per app launch so the shim tracks the current binary
  // location across updates/moves. Best-effort: on failure children simply
  // fall back to whatever `node` the PATH provides.
  let nodeShimDirPromise = null;
  function ensureNodeShimDir() {
    nodeShimDirPromise ??= (async () => {
      const shimDir = path.join(userDataDir, "node-shim");
      const shimPath = path.join(shimDir, nodeShimFileName());
      await mkdir(shimDir, { recursive: true });
      await writeFile(shimPath, nodeShimScriptContent(process.execPath), "utf8");
      if (process.platform !== "win32") {
        await chmod(shimPath, 0o755);
      }
      return shimDir;
    })().catch(() => null);
    return nodeShimDirPromise;
  }

  async function buildChildEnv(extra = {}) {
    /** @type {NodeJS.ProcessEnv} */
    // User env is layered first so process.env + any caller overrides always
    // win. See apps/server/src/env-file.ts and apps/orchestrator/src/cli.ts —
    // all loaders must agree on path + reserved-keys policy.
    const env = {
      ...loadUserEnvFile(),
      ...process.env,
      BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
      ...extra,
    };
    const pathKey =
      Object.prototype.hasOwnProperty.call(env, "PATH") ||
      !Object.prototype.hasOwnProperty.call(env, "Path")
        ? "PATH"
        : "Path";
    const nodeShimDir = await ensureNodeShimDir();
    const pathEnv = enrichedPath(sidecarDirs, env[pathKey], nodeShimDir ? [nodeShimDir] : []);
    if (pathEnv) {
      env[pathKey] = pathEnv;
    }
    if (process.env.LEGALWORK_DEV_MODE === "1") {
      const devPaths = await ensureDevModePaths();
      env.LEGALWORK_DEV_MODE = "1";
      env.HOME = devPaths.homeDir;
      env.USERPROFILE = devPaths.homeDir;
      env.XDG_CONFIG_HOME = devPaths.xdgConfigHome;
      env.XDG_DATA_HOME = devPaths.xdgDataHome;
      env.XDG_CACHE_HOME = devPaths.xdgCacheHome;
      env.XDG_STATE_HOME = devPaths.xdgStateHome;
      env.OPENCODE_CONFIG_DIR = devPaths.opencodeConfigDir;
      env.OPENCODE_TEST_HOME = devPaths.homeDir;
    } else {
      // Production uses opencode's standard per-platform config/data locations
      // (unix: $XDG_DATA_HOME|~/.local/share/opencode + ~/.config/opencode;
      // Windows: %LOCALAPPDATA%\opencode) rather than a LegalWork-specific dir.
      // The one exception: if those locations aren't writable (e.g. ~/.config
      // owned by root), opencode fails to start with EACCES, so transparently
      // redirect it to an app-owned dir. No-op on healthy machines and Windows.
      const opencodeHomeOverride = await ensureWritableOpencodeHome();
      if (opencodeHomeOverride) Object.assign(env, opencodeHomeOverride);
    }
    return env;
  }

  function resolveBinaryInfo(baseName, extraPaths = []) {
    for (const directory of [...sidecarDirs, ...extraPaths]) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(directory, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "bundled" };
        }
      }
    }

    const pathEntries = (enrichedPath([], process.env.PATH) ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    for (const entry of pathEntries) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(entry, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "path" };
        }
      }
    }

    if (baseName === "opencode") {
      for (const candidate of [
        path.join(app.getPath("home"), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/opt/homebrew/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/local/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
      ]) {
        if (existsSync(candidate)) {
          return { path: candidate, source: "known-location" };
        }
      }
    }

    return null;
  }

  function resolveBinary(baseName, extraPaths = []) {
    return resolveBinaryInfo(baseName, extraPaths)?.path ?? null;
  }

  function resolveOpencodeBinary(opencodeBinPath) {
    const explicitPath = typeof opencodeBinPath === "string" ? opencodeBinPath.trim() : "";
    return explicitPath ? { path: explicitPath, source: "custom" } : resolveBinaryInfo("opencode");
  }

  function resolveDockerCandidates() {
    const candidates = [];
    const seen = new Set();

    for (const key of ["LEGALWORK_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"]) {
      const value = process.env[key]?.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        candidates.push(value);
      }
    }

    for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(entry, process.platform === "win32" ? "docker.exe" : "docker");
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    for (const candidate of [
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    return candidates.filter((candidate) => existsSync(candidate));
  }

  function runDockerCommandDetailed(args, timeoutMs = 8000) {
    const tried = [...resolveDockerCandidates(), process.platform === "win32" ? "docker.exe" : "docker"];
    const errors = [];

    for (const program of tried) {
      try {
        const result = spawnSync(program, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
        });
        return {
          program,
          status: typeof result.status === "number" ? result.status : -1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Failed to run docker: ${errors.join("; ")} (Set LEGALWORK_DOCKER_BIN to your docker binary if needed)`,
    );
  }

  function parseDockerClientVersion(stdout) {
    const line = String(stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    return line.toLowerCase().startsWith("docker version") ? line : null;
  }

  function parseDockerServerVersion(stdout) {
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Server Version:")) {
        return trimmed.slice("Server Version:".length).trim() || null;
      }
    }
    return null;
  }

  function deriveOrchestratorContainerName(runId) {
    const sanitized = String(runId ?? "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .slice(0, 24);
    return `legalwork-orchestrator-${sanitized}`;
  }

  async function listLegalworkManagedContainers() {
    const result = runDockerCommandDetailed(["ps", "-a", "--format", "{{.Names}}"], 8000);
    if (result.status !== 0) {
      const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
      throw new Error(combined || `docker ps -a failed (status ${result.status})`);
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name && (name.startsWith("legalwork-orchestrator-") || name.startsWith("legalwork-dev-") || name.startsWith("openwrk-")))
      .sort();
  }

  async function runShellCommand(program, args, options = {}) {
    const result = spawnSync(program, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    return {
      status: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function engineDoctor(options = {}) {
    const resolved = resolveOpencodeBinary(options?.opencodeBinPath);
    if (!resolved?.path) {
      return {
        found: false,
        inPath: false,
        resolvedPath: null,
        resolvedSource: null,
        version: null,
        supportsServe: false,
        notes: ["OpenCode binary not found in bundled sidecars or PATH."],
        serveHelpStatus: null,
        serveHelpStdout: null,
        serveHelpStderr: null,
      };
    }

    const versionResult = spawnSync(resolved.path, ["--version"], { encoding: "utf8" });
    const helpResult = spawnSync(resolved.path, ["serve", "--help"], { encoding: "utf8" });
    const notes = [`Using ${resolved.source}: ${resolved.path}`];
    if (versionResult.status !== 0) {
      notes.push("OpenCode version probe failed.");
    }
    if (helpResult.status !== 0) {
      notes.push("OpenCode serve --help probe failed.");
    }

    return {
      found: true,
      inPath: resolved.source === "path",
      resolvedPath: resolved.path,
      resolvedSource: resolved.source,
      version: versionResult.stdout?.trim() || versionResult.stderr?.trim() || null,
      supportsServe: helpResult.status === 0,
      notes,
      serveHelpStatus: typeof helpResult.status === "number" ? helpResult.status : null,
      serveHelpStdout: helpResult.stdout?.trim() || null,
      serveHelpStderr: helpResult.stderr?.trim() || null,
    };
  }

  async function pinnedOpencodeInstallCommand() {
    const constantsPath = path.resolve(desktopRoot, "../../constants.json");
    const payload = JSON.parse(await readFile(constantsPath, "utf8"));
    const version = String(payload?.opencodeVersion ?? "").trim().replace(/^v/, "");
    if (!version) {
      throw new Error("constants.json is missing opencodeVersion");
    }
    return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version} --no-modify-path`;
  }

  // Children stopped on purpose (stop/restart) — their exit is not a crash.
  // A WeakSet rather than a property on the child, so the entries die with the
  // process objects and the Electron-main typecheck accepts it.
  const intentionallyStoppedChildren = new WeakSet();

  function spawnManagedChild(state, program, args, options = {}) {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    state.child = child;
    state.childExited = false;
    state.lastStdout = null;
    state.lastStderr = null;

    child.stdout?.on("data", (chunk) => appendOutput(state, "lastStdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => appendOutput(state, "lastStderr", chunk.toString()));
    child.on("exit", (code, signal) => {
      state.childExited = true;
      if (code != null && code !== 0) {
        appendOutput(state, "lastStderr", `Process exited with code ${code}.\n`);
      }
      // A clean exit (code 0) or a stop/restart we initiated is not a crash.
      const intentional = intentionallyStoppedChildren.has(child) || child.killed === true;
      const abnormal = code === 0 ? false : code != null || signal != null;
      if (abnormal && !intentional) options.onCrash?.({ code, signal });
      options.onExit?.(code);
    });
    child.on("error", (error) => {
      state.childExited = true;
      appendOutput(state, "lastStderr", `${error instanceof Error ? error.message : String(error)}\n`);
      // Spawn/runtime failure (e.g. ENOENT) — a crash unless we were stopping it.
      const intentional = intentionallyStoppedChildren.has(child) || child.killed === true;
      if (!intentional) options.onCrash?.({ error });
    });

    return child;
  }

  function processMatchesSidecar(command) {
    return commandMatchesPackagedSidecar(command, sidecarDirs);
  }

  function killProcessId(pid, signal = "SIGTERM") {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or is not ours.
    }
  }

  async function cleanupPackagedSidecars() {
    if (!app.isPackaged) return;

    // First ask the previously recorded orchestrator daemon to shut itself and
    // its OpenCode child down. This handles the happy path without relying on
    // process-list parsing.
    await requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()).catch(() => false);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Safety net: an unclean Electron quit can orphan sidecars. Packaged builds
    // should always own a fresh runtime per app launch, so remove any leftover
    // sidecars from this app bundle before choosing ports for the new runtime.
    const result = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    const rows = String(result.stdout ?? "").split(/\r?\n/);
    const pids = [];
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (processMatchesSidecar(command)) pids.push(pid);
    }
    for (const pid of pids) killProcessId(pid, "SIGTERM");
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const pid of pids) killProcessId(pid, "SIGKILL");
    }
  }

  async function stopChild(state, options = {}) {
    const child = state.child;
    state.child = null;
    state.childExited = true;
    // Mark this as a deliberate shutdown so the managed-child exit/error handler
    // doesn't misreport the stop (or a subsequent restart) as a sidecar crash.
    if (child) intentionallyStoppedChildren.add(child);
    if (!child || child.exitCode != null || child.killed) return;

    if (options.requestShutdown) {
      try {
        const shutdownRequested = await options.requestShutdown();
        if (shutdownRequested) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch {
        // ignore
      }
    }

    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async function ensureOpencodeConfig(projectDir) {
    // Seed the project config in the hidden .opencode/ directory (the engine
    // reads it from there too) so the user's workspace folder stays free of
    // files they didn't create. A config the user already keeps at the
    // workspace root is respected and left alone.
    const candidates = [
      path.join(projectDir, "opencode.jsonc"),
      path.join(projectDir, "opencode.json"),
      path.join(projectDir, ".opencode", "opencode.jsonc"),
      path.join(projectDir, ".opencode", "opencode.json"),
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return;
    }
    const hiddenJsoncPath = path.join(projectDir, ".opencode", "opencode.jsonc");
    await mkdir(path.dirname(hiddenJsoncPath), { recursive: true });
    await writeFile(
      hiddenJsoncPath,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  function generateManagedCredentials() {
    return [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")];
  }

  async function issueOwnerToken(baseUrl, hostToken) {
    const payload = await fetchJson(
      `${baseUrl.replace(/\/+$/, "")}/tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LegalWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ scope: "owner", label: "LegalWork desktop owner token" }),
      },
      5000,
    );
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    return token || null;
  }

  // In-process server handle. Kept alive across restarts so we can stop it.
  let inProcessServer = null;

  async function startLegalworkServer(options) {
    const currentPort = legalworkServerState.port;
    // Stop any previously running in-process server
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(legalworkServerState);

    const host = options.remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";

    const managedOpencode = options.manageOpencode ? resolveOpencodeBinary(options.opencodeBinPath) : null;
    legalworkServerState.managedOpencodeBinPath = managedOpencode?.path ?? null;
    legalworkServerState.managedOpencodeBinSource = managedOpencode?.source ?? null;
    if (options.manageOpencode) {
      engineState.opencodeBinPath = managedOpencode?.path ?? null;
      engineState.opencodeBinSource = managedOpencode?.source ?? null;
    }

    // Inject user env vars so the server and managed OpenCode inherit them.
    const serverEnv = await buildChildEnv({});
    Object.assign(process.env, serverEnv);

    // Once the embedded server has a persisted registry, it is the source of
    // truth. Do not pass Electron's legacy workspace list as CLI workspaces or
    // the server config loader will ignore server.json and lose server-created
    // workspaces after restart.
    const serverConfigPath = resolveLegalworkServerConfigPath(process.env);
    const requestedWorkspacePaths = (options.workspacePaths ?? []).filter((value) => value.trim().length > 0);
    const workspacePaths = seedWorkspacePathsForEmbeddedServer(
      requestedWorkspacePaths,
      existsSync(serverConfigPath),
    );
    const activeWorkspace = selectStickyLegalworkPortWorkspace(requestedWorkspacePaths, workspacePaths);
    const portSelection = await resolveLegalworkPort(host, activeWorkspace, currentPort);
    const tokens = await loadOrCreateWorkspaceTokens(activeWorkspace);

    // One call: resolve config, spawn managed OpenCode, start HTTP server.
    // Dev must prefer apps/server/dist; build output also stages a packaged
    // copy under apps/desktop/server for electron-builder.
    const devPath = path.resolve(__runtimeDir, "..", "..", "server", "dist", "embedded.js");
    const packagedPaths = [
      path.resolve(__runtimeDir, "..", "server", "dist", "embedded.js"),
      ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "server", "dist", "embedded.js")] : []),
    ];
    const candidates = process.env.LEGALWORK_DEV_MODE === "1"
      ? [devPath, ...packagedPaths]
      : [...packagedPaths, devPath];
    const embeddedPath = candidates.find((candidate) => existsSync(candidate));
    if (!embeddedPath) {
      throw new Error(`Cannot find LegalWork embedded server bundle. Checked: ${candidates.join(", ")}`);
    }
    const { startEmbeddedServer } = await import(pathToFileURL(embeddedPath).href);
    // startEmbeddedServer falls back to an OS-assigned port if `port` races
    // into EADDRINUSE (see apps/server/src/serve-node.ts), so the bound port
    // below is authoritative.
    const handle = await startEmbeddedServer({
      host,
      port: portSelection.port,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath: serverConfigPath,
      workspaces: workspacePaths,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
      opencodeBaseUrl: options.opencodeBaseUrl ?? undefined,
      opencodeDirectory: activeWorkspace || undefined,
      manageOpencode: options.manageOpencode === true,
      opencodeBin: managedOpencode?.path ?? undefined,
      opencodeCwd: managedOpencodeWorkdir(),
      // Native folder picker for webview clients (Office task pane): the
      // pane cannot open OS dialogs itself, so the server forwards here.
      // Focus is stolen because the request originates from another app
      // (Word/Excel) — without it the dialog opens behind that app. After
      // the dialog closes, focus is handed back to that Office app.
      pickDirectory: async (pickOptions) => {
        const { dialog } = await import("electron");
        app.focus({ steal: true });
        const result = await dialog.showOpenDialog({
          title: pickOptions?.title,
          defaultPath: pickOptions?.defaultPath,
          properties: ["openDirectory", "createDirectory"],
        });
        const officeBundleIds = {
          word: "com.microsoft.Word",
          excel: "com.microsoft.Excel",
          powerpoint: "com.microsoft.Powerpoint",
        };
        const bundleId = officeBundleIds[pickOptions?.returnFocusTo ?? ""];
        if (process.platform === "darwin" && bundleId) {
          spawn("open", ["-b", bundleId], { stdio: "ignore", detached: true }).unref();
        }
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      recorder,
      // Word/Excel/PowerPoint add-in listener — enabled via the Office Add-ins
      // settings tab; null when not installed so the listener stays off.
      ...(officeAddinManager.serverConfig() ?? {}),
    });
    inProcessServer = handle;
    legalworkServerState.managedOpencodeExecution = handle.managedOpencodeExecution ?? null;

    const boundPort = handle.port;
    const baseUrl = handle.url;

    legalworkServerState.inProcess = true;
    legalworkServerState.remoteAccessEnabled = options.remoteAccessEnabled;
    legalworkServerState.host = host;
    legalworkServerState.port = boundPort;
    legalworkServerState.baseUrl = baseUrl;
    legalworkServerState.clientToken = tokens.clientToken;
    legalworkServerState.hostToken = tokens.hostToken;

    const connectUrls = options.remoteAccessEnabled ? buildConnectUrls(boundPort) : { connectUrl: null, mdnsUrl: null, lanUrl: null };
    legalworkServerState.connectUrl = connectUrls.connectUrl;
    legalworkServerState.mdnsUrl = connectUrls.mdnsUrl;
    legalworkServerState.lanUrl = connectUrls.lanUrl;

    // No health check needed -- startServer() resolves only after the listener is bound.
    let workspaceList = null;
    let ownerToken = tokens.ownerToken?.trim() || null;
    if (ownerToken) {
      try {
        workspaceList = await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
      } catch {
        ownerToken = null;
      }
    }
    ownerToken ||= await issueOwnerToken(baseUrl, tokens.hostToken);
    legalworkServerState.ownerToken = ownerToken;
    if (ownerToken) {
      await persistWorkspaceOwnerToken(activeWorkspace, ownerToken);
    }
    if (ownerToken) {
      try {
        const list = workspaceList ?? await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
        const first = Array.isArray(list?.items) ? list.items[0] : undefined;
        const opencode = first?.opencode;
        if (opencode?.baseUrl) {
          engineState.runtime = DIRECT_RUNTIME;
          engineState.projectDir = opencode.directory ?? activeWorkspace ?? null;
          engineState.hostname = new URL(opencode.baseUrl).hostname;
          engineState.port = Number(new URL(opencode.baseUrl).port) || null;
          engineState.baseUrl = opencode.baseUrl;
          engineState.opencodeUsername = opencode.username ?? null;
          engineState.opencodePassword = opencode.password ?? null;
          engineState.execution = handle.managedOpencodeExecution ?? null;
          engineState.child = null;
          engineState.childExited = false;
        }
      } catch (error) {
        appendOutput(legalworkServerState, "lastStderr", `LegalWork server workspace probe: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!portSelection.preferredPort || boundPort === portSelection.preferredPort) {
      await persistPreferredLegalworkPort(activeWorkspace, boundPort);
    }
    return snapshotLegalworkServerState(legalworkServerState);
  }

  async function resolveOrchestratorBaseUrl() {
    if (orchestratorState.baseUrl) {
      return orchestratorState.baseUrl;
    }
    const stateFile = await readOrchestratorStateFile(orchestratorState.dataDir || orchestratorDataDir());
    const baseUrl = stateFile?.daemon?.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error("orchestrator daemon is not running");
    }
    return baseUrl;
  }

  async function startOrchestratorRuntime(projectDir, options = {}) {
    const dataDir = orchestratorDataDir();
    await mkdir(dataDir, { recursive: true });
    const daemonPort = await findFreePort("127.0.0.1");
    const opencodePort = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();

    const orchestratorProgram = resolveBinary("legalwork-orchestrator") ?? resolveBinary("legalwork");
    if (!orchestratorProgram) {
      throw new Error("Failed to locate legalwork-orchestrator.");
    }

    const opencodeBinary = resolveOpencodeBinary(options.opencodeBinPath);
    if (!opencodeBinary?.path) {
      throw new Error("Failed to locate opencode.");
    }

    const env = await buildChildEnv({
      LEGALWORK_INTERNAL_ALLOW_OPENCODE_CREDENTIALS: "1",
      LEGALWORK_OPENCODE_USERNAME: username,
      LEGALWORK_OPENCODE_PASSWORD: password,
      ...(options.opencodeEnableExa !== false ? { OPENCODE_ENABLE_EXA: "1" } : {}),
    });

    const args = [
      "daemon",
      "run",
      "--data-dir",
      dataDir,
      "--daemon-host",
      "127.0.0.1",
      "--daemon-port",
      String(daemonPort),
      "--opencode-bin",
      opencodeBinary.path,
      "--opencode-host",
      "127.0.0.1",
      "--opencode-workdir",
      projectDir,
      "--opencode-port",
      String(opencodePort),
      "--allow-external",
      "--cors",
      "*",
    ];

    spawnManagedChild(orchestratorState, orchestratorProgram, args, { env, onCrash: reportSidecarCrash });
    orchestratorState.dataDir = dataDir;
    orchestratorState.daemonPort = daemonPort;
    orchestratorState.baseUrl = `http://127.0.0.1:${daemonPort}`;

    await writeOrchestratorAuthFile(dataDir, {
      opencodeUsername: username,
      opencodePassword: password,
      projectDir,
    });

    const health = await waitForHttpOk(`${orchestratorState.baseUrl}/health`, 180_000).then((response) => response.json());
    const opencode = health?.opencode;
    if (!opencode?.port) {
      throw new Error("Orchestrator did not report OpenCode status.");
    }

    engineState.runtime = ORCHESTRATOR_RUNTIME;
    engineState.projectDir = projectDir;
    engineState.hostname = "127.0.0.1";
    engineState.port = opencode.port;
    engineState.baseUrl = `http://127.0.0.1:${opencode.port}`;
    engineState.opencodeUsername = username;
    engineState.opencodePassword = password;
    engineState.opencodeBinPath = opencodeBinary.path;
    engineState.opencodeBinSource = opencodeBinary.source;

    return snapshotEngineState(engineState);
  }

  async function startDirectRuntime(projectDir, options = {}) {
    const opencodeBinary = resolveOpencodeBinary(options.opencodeBinPath);
    if (!opencodeBinary?.path) {
      throw new Error("Failed to locate opencode.");
    }

    const port = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();
    const env = await buildChildEnv({
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    });

    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", "*"];
    engineState.execution = redactedExecutionSnapshot(opencodeBinary.path, args, projectDir, {
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    });

    spawnManagedChild(
      engineState,
      opencodeBinary.path,
      args,
      {
        cwd: projectDir,
        env,
        onCrash: reportSidecarCrash,
      },
    );

    engineState.runtime = DIRECT_RUNTIME;
    engineState.projectDir = projectDir;
    engineState.hostname = "127.0.0.1";
    engineState.port = port;
    engineState.baseUrl = `http://127.0.0.1:${port}`;
    engineState.opencodeUsername = username;
    engineState.opencodePassword = password;
    engineState.opencodeBinPath = opencodeBinary.path;
    engineState.opencodeBinSource = opencodeBinary.source;

    await waitForHttpOk(`${engineState.baseUrl}/health`, 10_000).catch(() => undefined);
    return snapshotEngineState(engineState);
  }

  async function stopAllRuntimeChildren() {
    // Stop the in-process server (and its managed OpenCode child) if running.
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(legalworkServerState);
    await stopChild(orchestratorState, {
      requestShutdown: () => requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()),
    });
    await clearOrchestratorAuthFile(orchestratorState.dataDir || orchestratorDataDir()).catch(() => undefined);
    await stopChild(engineState);

    Object.assign(engineState, createEngineState());
    Object.assign(legalworkServerState, createLegalworkServerState());
    Object.assign(orchestratorState, createOrchestratorState());
  }

  async function prepareFreshRuntime() {
    lifecycleState = "cleaning";
    await stopAllRuntimeChildren();
    await cleanupPackagedSidecars();
    lifecycleState = "idle";
  }

  async function ensureLegalwork(options) {
    let legalworkServer;
    try {
      legalworkServer = await startLegalworkServer({
        workspacePaths: options.workspacePaths,
        opencodeBaseUrl: engineState.baseUrl,
        opencodeUsername: engineState.opencodeUsername,
        opencodePassword: engineState.opencodePassword,
        remoteAccessEnabled: options.remoteAccessEnabled,
        manageOpencode: options.manageOpencode === true,
        opencodeBinPath: options.opencodeBinPath,
      });
    } catch (error) {
      appendOutput(engineState, "lastStderr", `LegalWork server: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }

    assertLegalworkServerReady(legalworkServer);
  }

  async function engineStart(projectDir, options = {}) {
    const safeProjectDir = String(projectDir ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("projectDir is required");
    }

    // Reuse a healthy server instead of tearing it down. During boot the
    // main process kicks off bootRuntimeForSelectedWorkspace while renderer
    // routes independently call ensureDesktopLocalLegalworkConnection. Both go
    // through this serialized path; without this guard the second call runs
    // prepareFreshRuntime (killing the freshly bound server) and then rebinds
    // the sticky preferred port, racing the not-yet-released socket into
    // EADDRINUSE and leaving the runtime in error -> boot screen.
    const requestedRemoteAccess = options.legalworkRemoteAccess === true;
    if (
      legalworkServerState.inProcess &&
      lifecycleState === "healthy" &&
      normalizeWorkspaceKey(engineState.projectDir) === normalizeWorkspaceKey(safeProjectDir) &&
      legalworkServerState.remoteAccessEnabled === requestedRemoteAccess
    ) {
      const existing = snapshotLegalworkServerState(legalworkServerState);
      if (existing.running && existing.baseUrl && (existing.ownerToken || existing.clientToken)) {
        return snapshotEngineState(engineState);
      }
    }

    await mkdir(safeProjectDir, { recursive: true });
    await ensureOpencodeConfig(safeProjectDir);
    await prepareFreshRuntime();

    const workspacePaths = [safeProjectDir, ...((options.workspacePaths ?? []).filter(Boolean))].filter(
      (value, index, list) => list.indexOf(value) === index,
    );
    const runtime = DIRECT_RUNTIME;

    try {
      lifecycleState = "starting";
      engineState.runtime = runtime;
      engineState.projectDir = safeProjectDir;
      engineState.child = null;
      engineState.childExited = true;

      await ensureLegalwork({
        projectDir: safeProjectDir,
        workspacePaths,
        remoteAccessEnabled: options.legalworkRemoteAccess === true,
        manageOpencode: true,
        opencodeBinPath: options.opencodeBinPath,
      });

      lifecycleState = "healthy";
      return snapshotEngineState(engineState);
    } catch (error) {
      lifecycleState = "error";
      // Surface the *real* reason to the main-process log before the generic
      // boot error bubbles up to the renderer. Best-effort; never mask the
      // original failure with a diagnostics error.
      try {
        console.error(
          "[runtime] engineStart failed:",
          error instanceof Error ? error.stack || error.message : String(error),
        );
        console.error("[runtime] diagnostics:", JSON.stringify(collectRuntimeDiagnostics(), null, 2));
      } catch {
        /* diagnostics are best-effort */
      }
      throw error;
    }
  }

  async function engineStop() {
    lifecycleState = "stopping";
    await stopAllRuntimeChildren();
    lifecycleState = "idle";
    return snapshotEngineState(engineState);
  }

  async function engineRestart(options = {}) {
    const projectDir = engineState.projectDir;
    if (!projectDir) {
      throw new Error("OpenCode is not configured for a local workspace");
    }
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeEnableExa: options.opencodeEnableExa,
      legalworkRemoteAccess: options.legalworkRemoteAccess,
    });
  }

  async function engineInfo() {
    return { ...snapshotEngineState(engineState), lifecycleState };
  }

  async function runtimeStatus() {
    return {
      lifecycleState,
      engine: await engineInfo(),
      legalworkServer: snapshotLegalworkServerState(legalworkServerState),
    };
  }

  // A token-free snapshot of everything we know about why the local runtime is
  // (not) up: the embedded server + managed OpenCode stderr/stdout tails, exit
  // codes, resolved binary paths, and the OpenCode doctor probe. This is the
  // payload we surface to the console / boot screen instead of the generic
  // "server did not finish starting" message, so a failing machine can be
  // diagnosed without a special build.
  function collectRuntimeDiagnostics() {
    const diagTail = (value, limit = 4000) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      return text.length <= limit ? text : text.slice(text.length - limit);
    };
    const engine = snapshotEngineState(engineState);
    const server = snapshotLegalworkServerState(legalworkServerState);
    let opencode = null;
    try {
      opencode = engineDoctor({
        opencodeBinPath:
          legalworkServerState.managedOpencodeBinPath || engineState.opencodeBinPath || undefined,
      });
    } catch (error) {
      opencode = { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      platform: process.platform,
      arch: process.arch,
      lifecycleState,
      // NOTE: token fields from the snapshots are intentionally omitted here.
      engine: {
        running: engine.running,
        runtime: engine.runtime,
        baseUrl: engine.baseUrl,
        port: engine.port,
        pid: engine.pid,
        opencodeBinPath: engine.opencodeBinPath,
        opencodeBinSource: engine.opencodeBinSource,
        lastStdout: diagTail(engine.lastStdout),
        lastStderr: diagTail(engine.lastStderr),
        execution: engine.execution ?? null,
      },
      legalworkServer: {
        running: server.running,
        inProcess: legalworkServerState.inProcess === true,
        host: server.host,
        port: server.port,
        baseUrl: server.baseUrl,
        pid: server.pid,
        managedOpencodeBinPath: server.managedOpencodeBinPath,
        managedOpencodeBinSource: server.managedOpencodeBinSource,
        lastStdout: diagTail(server.lastStdout),
        lastStderr: diagTail(server.lastStderr),
        managedOpencodeExecution: server.managedOpencodeExecution ?? null,
      },
      orchestrator: {
        baseUrl: orchestratorState.baseUrl,
        daemonPort: orchestratorState.daemonPort,
        lastStdout: diagTail(orchestratorState.lastStdout),
        lastStderr: diagTail(orchestratorState.lastStderr),
      },
      opencode,
    };
  }

  async function legalworkServerInfo() {
    return snapshotLegalworkServerState(legalworkServerState);
  }

  async function legalworkServerRestart(options = {}) {
    const workspacePaths = prioritizeWorkspacePaths(engineState.projectDir, await listLocalWorkspacePaths());
    const shouldManageOpencode = Boolean(
      legalworkServerState.managedOpencodeBinPath || engineState.opencodeBinPath || !engineState.baseUrl,
    );
    return startLegalworkServer({
      workspacePaths,
      opencodeBaseUrl: shouldManageOpencode ? null : engineState.baseUrl,
      opencodeUsername: shouldManageOpencode ? null : engineState.opencodeUsername,
      opencodePassword: shouldManageOpencode ? null : engineState.opencodePassword,
      remoteAccessEnabled: options.remoteAccessEnabled === true,
      manageOpencode: shouldManageOpencode,
      opencodeBinPath: engineState.opencodeBinPath ?? legalworkServerState.managedOpencodeBinPath,
    });
  }

  async function orchestratorStatus() {
    const engine = snapshotEngineState(engineState);
    const legalworkServer = snapshotLegalworkServerState(legalworkServerState);
    const workspaces = engine.projectDir
      ? [{ id: normalizeWorkspaceKey(engine.projectDir), path: engine.projectDir, name: path.basename(engine.projectDir) || "Workspace" }]
      : [];
    return {
      running: engine.running,
      dataDir: null,
      daemon: legalworkServer.running
        ? { baseUrl: legalworkServer.baseUrl, port: legalworkServer.port, pid: legalworkServer.pid, runtime: "direct" }
        : null,
      opencode: engine.running
        ? { baseUrl: engine.baseUrl, port: engine.port, pid: engine.pid, projectDir: engine.projectDir, runtime: "direct" }
        : null,
      cliVersion: null,
      sidecar: null,
      binaries: null,
      activeId: workspaces[0]?.id ?? null,
      workspaceCount: workspaces.length,
      workspaces,
      lastError: engine.lastStderr,
    };
  }

  async function orchestratorWorkspaceActivate(input) {
    const workspacePath = String(input?.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }
    const resolved = path.resolve(workspacePath);
    if (normalizeWorkspaceKey(engineState.projectDir) !== normalizeWorkspaceKey(resolved)) {
      await engineStart(resolved, {
        runtime: DIRECT_RUNTIME,
        workspacePaths: [resolved],
      });
    }
    return {
      id: normalizeWorkspaceKey(resolved),
      path: resolved,
      name: input?.name ?? (path.basename(resolved) || "Workspace"),
    };
  }

  async function orchestratorInstanceDispose(workspacePath) {
    if (normalizeWorkspaceKey(engineState.projectDir) === normalizeWorkspaceKey(workspacePath)) {
      return true;
    }
    return true;
  }

  async function engineInstall() {
    if (process.platform === "win32") {
      return {
        ok: false,
        status: -1,
        stdout: "",
        stderr:
          "Guided install is not supported on Windows yet. Install the LegalWork-pinned OpenCode version manually, then restart LegalWork.",
      };
    }

    const installDir = path.join(app.getPath("home"), ".opencode", "bin");
    const command = await pinnedOpencodeInstallCommand();
    const result = await runShellCommand("bash", ["-lc", command], {
      env: { ...(await buildChildEnv()), OPENCODE_INSTALL_DIR: installDir },
      timeoutMs: 180_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function opencodeMcpAuth(projectDir, serverName) {
    const safeProjectDir = String(projectDir ?? "").trim();
    const safeServerName = String(serverName ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("project_dir is required");
    }
    if (!safeServerName) {
      throw new Error("server_name is required");
    }

    const program = resolveBinary("opencode");
    if (!program) {
      throw new Error("Failed to locate opencode.");
    }

    const result = await runShellCommand(program, ["mcp", "auth", safeServerName], {
      cwd: safeProjectDir,
      env: await buildChildEnv(),
      timeoutMs: 120_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function sandboxDoctor() {
    const candidates = resolveDockerCandidates();
    const debug = {
      candidates,
      selectedBin: null,
      versionCommand: null,
      infoCommand: null,
    };

    let version;
    try {
      version = runDockerCommandDetailed(["--version"], 2000);
    } catch (error) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.selectedBin = version.program;
    debug.versionCommand = {
      status: version.status,
      stdout: truncateOutput(version.stdout, 1200),
      stderr: truncateOutput(version.stderr, 1200),
    };

    const clientVersion = parseDockerClientVersion(version.stdout);
    if (version.status !== 0) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: `docker --version failed (status ${version.status}): ${version.stderr.trim()}`,
        debug,
      };
    }

    let info;
    try {
      info = runDockerCommandDetailed(["info"], 8000);
    } catch (error) {
      return {
        installed: true,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.infoCommand = {
      status: info.status,
      stdout: truncateOutput(info.stdout, 1200),
      stderr: truncateOutput(info.stderr, 1200),
    };

    if (info.status === 0) {
      return {
        installed: true,
        daemonRunning: true,
        permissionOk: true,
        ready: true,
        clientVersion,
        serverVersion: parseDockerServerVersion(info.stdout),
        error: null,
        debug,
      };
    }

    const combined = `${info.stdout.trim()}\n${info.stderr.trim()}`.trim().toLowerCase();
    const permissionOk = !combined.includes("permission denied") && !combined.includes("access is denied");
    const daemonRunning = !combined.includes("cannot connect to the docker daemon") && !combined.includes("is the docker daemon running") && !combined.includes("connection refused") && !combined.includes("no such file or directory");

    return {
      installed: true,
      daemonRunning,
      permissionOk,
      ready: false,
      clientVersion,
      serverVersion: null,
      error: `${info.stdout.trim()}\n${info.stderr.trim()}`.trim() || `docker info failed (status ${info.status})`,
      debug,
    };
  }

  async function sandboxStop(containerName) {
    const name = String(containerName ?? "").trim();
    if (!name) {
      throw new Error("containerName is required");
    }
    if (!name.startsWith("legalwork-orchestrator-")) {
      throw new Error("Refusing to stop container: expected name starting with 'legalwork-orchestrator-'");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("containerName contains invalid characters");
    }
    const result = runDockerCommandDetailed(["stop", name], 15_000);
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function sandboxCleanupLegalworkContainers() {
    const candidates = await listLegalworkManagedContainers().catch((error) => {
      throw error;
    });
    const removed = [];
    const errors = [];

    for (const name of candidates) {
      try {
        const result = runDockerCommandDetailed(["rm", "-f", name], 20_000);
        if (result.status === 0) {
          removed.push(name);
        } else {
          errors.push(`${name}: exit ${result.status}: ${(result.stdout + "\n" + result.stderr).trim()}`);
        }
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { candidates, removed, errors };
  }

  async function orchestratorStartDetached(options = {}) {
    const workspacePath = String(options.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }

    const sandboxBackend = String(options.sandboxBackend ?? "none").trim().toLowerCase();
    if (!["none", "docker", "microsandbox"].includes(sandboxBackend)) {
      throw new Error("sandboxBackend must be one of: none, docker, microsandbox");
    }

    const wantsDockerSandbox = sandboxBackend === "docker" || sandboxBackend === "microsandbox";
    const runId = String(options.runId ?? randomUUID()).trim();
    const containerName = wantsDockerSandbox ? deriveOrchestratorContainerName(runId) : null;
    const port = await findFreePort("127.0.0.1");
    const token = String(options.legalworkToken ?? randomUUID()).trim();
    const hostToken = String(options.legalworkHostToken ?? randomUUID()).trim();
    const legalworkUrl = `http://127.0.0.1:${port}`;
    const program = resolveBinary("legalwork-orchestrator") ?? resolveBinary("legalwork");
    if (!program) {
      throw new Error("Failed to locate legalwork orchestrator.");
    }

    const args = [
      "start",
      "--workspace",
      workspacePath,
      "--approval",
      "auto",
      "--detach",
      "--legalwork-port",
      String(port),
      "--run-id",
      runId,
      ...(wantsDockerSandbox ? ["--sandbox", "docker"] : []),
      ...(options.sandboxImageRef ? ["--sandbox-image", String(options.sandboxImageRef)] : []),
    ];

    const child = spawn(program, args, {
      env: { ...(await buildChildEnv()), LEGALWORK_TOKEN: token, LEGALWORK_HOST_TOKEN: hostToken },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    await waitForHttpOk(`${legalworkUrl}/health`, wantsDockerSandbox ? 90_000 : 12_000);
    const ownerToken = await issueOwnerToken(legalworkUrl, hostToken).catch(() => null);

    return {
      legalworkUrl,
      token,
      ownerToken,
      hostToken,
      port,
      sandboxBackend: wantsDockerSandbox ? sandboxBackend : null,
      sandboxRunId: wantsDockerSandbox ? runId : null,
      sandboxContainerName: containerName,
    };
  }

  async function sandboxDebugProbe() {
    const startedAt = nowMs();
    const runId = `probe-${randomUUID()}`;
    const workspacePath = path.join(os.tmpdir(), `legalwork-sandbox-probe-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });

    const doctor = await sandboxDoctor();
    let detachedHost = null;
    let dockerInspect = null;
    let dockerLogs = null;
    let error = null;
    const cleanupErrors = [];
    let containerRemoved = false;
    let workspaceRemoved = false;
    let removeResult = null;

    if (doctor.ready) {
      try {
        detachedHost = await orchestratorStartDetached({
          workspacePath,
          sandboxBackend: "docker",
          runId,
        });
        const containerName = detachedHost.sandboxContainerName ?? deriveOrchestratorContainerName(runId);
        try {
          const inspectResult = runDockerCommandDetailed(["inspect", containerName], 6000);
          dockerInspect = {
            status: inspectResult.status,
            stdout: truncateOutput(inspectResult.stdout, 48000),
            stderr: truncateOutput(inspectResult.stderr, 48000),
          };
        } catch (inspectError) {
          cleanupErrors.push(`docker inspect failed: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
        }
        try {
          const logsResult = runDockerCommandDetailed(["logs", "--timestamps", "--tail", "400", containerName], 8000);
          dockerLogs = {
            status: logsResult.status,
            stdout: truncateOutput(logsResult.stdout, 48000),
            stderr: truncateOutput(logsResult.stderr, 48000),
          };
        } catch (logsError) {
          cleanupErrors.push(`docker logs failed: ${logsError instanceof Error ? logsError.message : String(logsError)}`);
        }

        try {
          const rmResult = runDockerCommandDetailed(["rm", "-f", containerName], 20_000);
          containerRemoved = rmResult.status === 0;
          removeResult = {
            status: rmResult.status,
            stdout: truncateOutput(rmResult.stdout, 48000),
            stderr: truncateOutput(rmResult.stderr, 48000),
          };
        } catch (removeError) {
          cleanupErrors.push(`docker rm -f ${containerName} failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      } catch (probeError) {
        error = `Sandbox probe failed to start: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
      }
    } else {
      error = doctor.error ?? "Docker is not ready for sandbox creation";
    }

    try {
      await rm(workspacePath, { recursive: true, force: true });
      workspaceRemoved = true;
    } catch (workspaceError) {
      cleanupErrors.push(`Failed to remove probe workspace: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}`);
    }

    return {
      startedAt,
      finishedAt: nowMs(),
      runId,
      workspacePath,
      ready: doctor.ready && !error,
      doctor,
      detachedHost,
      dockerInspect,
      dockerLogs,
      cleanup: {
        containerName: detachedHost?.sandboxContainerName ?? null,
        containerRemoved,
        removeResult,
        workspaceRemoved,
        errors: cleanupErrors,
      },
      error,
    };
  }

  return {
    engineStart: (projectDir, options) => withRuntimeLifecycle(() => engineStart(projectDir, options)),
    engineStop: () => withRuntimeLifecycle(() => engineStop()),
    engineRestart: (options) => withRuntimeLifecycle(() => engineRestart(options)),
    prepareFreshRuntime: () => withRuntimeLifecycle(() => prepareFreshRuntime()),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    runtimeStatus,
    collectRuntimeDiagnostics,
    engineInfo,
    engineDoctor,
    engineInstall,
    legalworkServerInfo,
    legalworkServerRestart: (options) => withRuntimeLifecycle(() => legalworkServerRestart(options)),
    officeAddinStatus: () => officeAddinManager.status(),
    officeAddinInstall: (appId) => officeAddinManager.install(appId),
    officeAddinUninstall: (appId) => officeAddinManager.uninstall(appId),
    officeAddinOpenApp: (appId) => officeAddinManager.openApp(appId),
    orchestratorStatus,
    orchestratorWorkspaceActivate,
    orchestratorInstanceDispose,
    orchestratorStartDetached,
    opencodeMcpAuth,
    sandboxDoctor,
    sandboxStop,
    sandboxCleanupLegalworkContainers,
    sandboxDebugProbe,
  };
}
