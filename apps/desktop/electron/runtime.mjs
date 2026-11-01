import {configureMailDesktop} from './mail-desktop.mjs';
import {configureMailPortability} from "./mail-portability.mjs";
import { configureMailBadge } from "./app-badge.mjs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { createOfficeAddinManager } from "./office-addin-manager.mjs";
import { createHostApprovalHandler } from "./host-approvals.mjs";
import { migrateLegacyWindowsOpenCodeConfig } from "./opencode-config-migration.mjs";
import { downloadOpencodeBinary, opencodeRelease, opencodeReleaseTarget } from "./opencode-release.mjs";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import { installSelectedOpencodeEngine, opencodeEngineSelection } from "@legalwork/opencode-release/selection";
import { createDesktopMailService } from "./mail-runtime.mjs";
import { applyEmbeddedServerEnvironment } from "./runtime-environment.mjs";

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

function locateEmbeddedServerPath() {
  const devPath = path.resolve(__runtimeDir, "..", "..", "server", "dist", "embedded.js");
  const packagedPaths = [
    path.resolve(__runtimeDir, "..", "server", "dist", "embedded.js"),
    ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "server", "dist", "embedded.js")] : []),
  ];
  const candidates = process.env.LEGALWORK_DEV_MODE === "1"
    ? [devPath, ...packagedPaths]
    : [...packagedPaths, devPath];
  const embeddedPath = candidates.find((candidate) => existsSync(candidate));
  if (!embeddedPath) throw new Error(`Cannot find LegalWork embedded server bundle. Checked: ${candidates.join(", ")}`);
  return embeddedPath;
}

/** Directory holding the built Office task pane bundle (taskpane.html). */
function locatePaneDistDir() {
  const candidates = [
    path.resolve(__runtimeDir, "..", "..", "app", "dist-word-addin"),
    ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "word-addin-dist")] : []),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "taskpane.html"))) ?? null;
}

export function bundledOpencodeSdkDirectory({ isPackaged, resourcesPath, desktopRoot }) {
  // Development Electron has its own resourcesPath, unrelated to our staged SDK.
  return path.join(isPackaged ? resourcesPath : path.join(desktopRoot, "resources"), "opencode-sdk");
}

export function toolImageRasterModules({ isPackaged, resourcesPath, serverEntry }) {
  const modules = isPackaged ? realpathSync(path.join(resourcesPath, "app.asar.unpacked", "node_modules")) : null;
  const require = createRequire(isPackaged ? path.join(modules, "image-runtime.cjs") : serverEntry);
  const entry = (name) => {
    // Absolute package lookup prevents a missing packaged module from resolving
    // against a parent directory or the developer's checkout.
    const resolved = realpathSync(require.resolve(isPackaged ? path.join(modules, name) : name));
    if (modules) {
      const relative = path.relative(modules, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Image runtime module escapes the unpacked application: ${name}`);
    }
    return resolved;
  };
  return { canvas: entry("@napi-rs/canvas"), imageSize: entry("image-size") };
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

// Documents is supplied by Electron's OS known-folder API, including redirected
// Windows/OneDrive folders. Never derive user documents from the engine's HOME.
export function desktopProjectsDirectory(documentsDirectory, development = false, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.join(documentsDirectory, development ? "LegalWork Dev" : "LegalWork", "Projects");
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

/** Main-process access to the embedded server's live, private connection. */
export function embeddedOpencodeConnection(config, workspacePath, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const key = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    const resolved = paths.resolve(platform === "win32" ? trimmed.replace(/^\\\\\?\\/, "") : trimmed);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const selected = key(workspacePath);
  if (!selected) return null;
  const matches = config.workspaces.filter((workspace) => key(workspace.path) === selected);
  if (matches.length !== 1) return null;
  const workspace = matches[0];
  const baseUrl = workspace.baseUrl?.trim() || config.opencodeBaseUrl?.trim();
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  return {
    baseUrl,
    projectDir: workspace.directory?.trim() || workspace.path,
    hostname: url.hostname,
    port: Number(url.port) || null,
    opencodeUsername: workspace.opencodeUsername?.trim() || config.opencodeUsername?.trim() || null,
    opencodePassword: workspace.opencodePassword?.trim() || config.opencodePassword?.trim() || null,
  };
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

export function alignWindowsOpencodeConfigEnv(env, platform = process.platform, home = os.homedir()) {
  if (platform === "win32" && !String(env.XDG_CONFIG_HOME ?? "").trim()) {
    env.XDG_CONFIG_HOME = path.join(home, ".config");
  }
  return env;
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

function snapshotEngineState(state, managedStatus = null) {
  const child = state.childExited ? null : state.child;
  return {
    running: managedStatus?.running ?? Boolean(child && child.exitCode === null && !child.killed),
    runtime: state.runtime,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    opencodeBinPath: state.opencodeBinPath,
    opencodeBinSource: state.opencodeBinSource,
    pid: managedStatus ? managedStatus.pid : child?.pid ?? null,
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


async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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

export function bundledNodeDirectory(resourcesRoot, platform = process.platform) {
  const directory = path.join(resourcesRoot, "node");
  const executable = path.join(directory, platform === "win32" ? "node.exe" : "node");
  if (!existsSync(executable)) throw new Error(`Bundled Node runtime is missing: ${executable}`);
  return directory;
}

export function nodeShimFileName(platform = process.platform) {
  return platform === "win32" ? "node.cmd" : "node";
}

// Development-only fallback that re-execs Electron in Node mode. Electron ships a
// full Node runtime, so machines without a system Node.js can still run the
// bundled workspace skills (docx-edit, pdf-tools), which shell
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

async function waitForHttpOk(url, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
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

export function createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths, recorder, onSidecarExit, getApprovalWindow, modelDownloadFetch, opencodeCandidateBuild = undefined }) {
  const requestHostApproval = createHostApprovalHandler({
    getWindow: getApprovalWindow,
    showMessageBox: async (window, options) => {
      const { dialog } = await import("electron");
      if (options.signal.aborted || window.isDestroyed()) return { response: 0, checkboxChecked: false };
      return dialog.showMessageBox(window, options);
    },
  });
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
  const pluginDiscoveryHome = app.getPath("home");
  const projectsDirectory = desktopProjectsDirectory(app.getPath("documents"), process.env.LEGALWORK_DEV_MODE === "1");
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
    onTrustStoreChanged: () => inProcessServer?.invalidateRawHttpTrust(),
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
    // Packaged Electron has RunAsNode fused off. Append our standalone Node
    // directory so document tools also work without a system Node installation.
    if (app.isPackaged) return bundledNodeDirectory(process.resourcesPath);
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

  const windowsConfigMigrations = new Map();
  async function prepareOpencodeConfig(env) {
    if (process.env.LEGALWORK_DEV_MODE === "1") {
      const devPaths = await ensureDevModePaths();
      return { target: path.join(devPaths.xdgConfigHome, "opencode"), result: null };
    }
    if (process.platform !== "win32") return null;
    alignWindowsOpencodeConfigEnv(env);
    const appData = String(env.APPDATA ?? "").trim() || app.getPath("appData");
    const source = path.join(appData, "opencode");
    const target = path.join(env.XDG_CONFIG_HOME, "opencode");
    const key = `${source}\0${target}`;
    if (!windowsConfigMigrations.has(key)) {
      const migration = migrateLegacyWindowsOpenCodeConfig(source, target).catch((error) => {
        windowsConfigMigrations.delete(key);
        throw error;
      });
      windowsConfigMigrations.set(key, migration);
    }
    return { target, result: await windowsConfigMigrations.get(key) };
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
      // Import sources belong to the OS user, even when dev isolates OpenCode's HOME.
      LEGALWORK_PLUGIN_DISCOVERY_HOME: pluginDiscoveryHome,
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
      env.LEGALWORK_DEV_OPENCODE_DATA_DIR = path.join(devPaths.xdgDataHome, "opencode");
      env.XDG_CACHE_HOME = devPaths.xdgCacheHome;
      env.XDG_STATE_HOME = devPaths.xdgStateHome;
      env.OPENCODE_CONFIG_DIR = devPaths.opencodeConfigDir;
      env.OPENCODE_TEST_HOME = devPaths.homeDir;
    } else {
      // Use OpenCode's native config root as the only global config root.
      // Import the previous LegalWork AppData library before any child starts.
      try {
        const prepared = await prepareOpencodeConfig(env);
        if (prepared?.result?.failed.length) {
          console.warn("[runtime] Some Windows OpenCode config files could not be migrated", prepared.result.failed);
        }
      } catch (error) {
        // The native OpenCode config remains usable if importing the old
        // LegalWork library fails. The untouched AppData copy can be retried.
        console.warn("[runtime] Windows OpenCode config migration will retry on the next launch", error);
      }
      // Production keeps OpenCode's native data paths and uses its XDG config
      // root. On Windows we pin that root to ~/.config/opencode after migration.
      // On Unix only, an unwritable standard location redirects to app data.
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

  function findSelectedOpencodeBinary() {
    const target = opencodeReleaseTarget(), filename = process.platform === "win32" ? "opencode.exe" : "opencode";
    const resources = app.isPackaged ? process.resourcesPath : path.join(desktopRoot, "resources");
    const bundled = path.join(resources, "opencode-engine", opencodeEngineSelection.artifactId, target, filename);
    if (existsSync(bundled)) return { path: bundled, source: "bundled" };
    const installed = path.join(userDataDir, "engines", opencodeEngineSelection.artifactId, target, filename);
    if (existsSync(installed)) return { path: installed, source: "installed" };
    return null;
  }

  function resolveOpencodeBinary(opencodeBinPath) {
    const explicitPath = typeof opencodeBinPath === "string" ? opencodeBinPath.trim() : "";
    if (explicitPath) return { path: explicitPath, source: "custom" };
    if (opencodeEngineSelection.kind === "derivative") {
      const selected = findSelectedOpencodeBinary();
      if (selected) return selected;
      throw new Error("The selected LegalWork engine is missing. Restore its verified application resources or install its reviewed archive.");
    }
    const binary = resolveBinaryInfo("opencode");
    if (!binary) throw new Error("OpenCode is not installed. Install the engine before starting a chat.");
    return binary;
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

  async function engineDoctor(options = {}) {
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

    await expectedOpencodeVersion(resolved.path, opencodeCandidateBuild);
    const versionResult = spawnSync(resolved.path, ["--version"], { encoding: "utf8" });
    await expectedOpencodeVersion(resolved.path, opencodeCandidateBuild);
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

  // Children stopped on purpose (stop/restart) — their exit is not a crash.
  // A WeakSet rather than a property on the child, so the entries die with the
  // process objects and the Electron-main typecheck accepts it.
  const intentionallyStoppedChildren = new WeakSet();
  const stoppingChildren = new Set();

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
    if (!child || child.exitCode != null || child.signalCode != null) return;

    stoppingChildren.add(child);
    child.once("exit", () => stoppingChildren.delete(child));
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

    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  }

  function generateManagedCredentials() {
    return ["opencode", randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")];
  }

  // In-process server handle. Kept alive across restarts so we can stop it.
  let inProcessServer = null;
  let embeddedWorkspacePath = null;

  function engineSnapshot() {
    if (inProcessServer) {
      // Recovery can replace the engine and rotate its credentials. Read the
      // current host-owned config each time; never recover secrets over HTTP.
      const connection = embeddedOpencodeConnection(inProcessServer.config, embeddedWorkspacePath);
      Object.assign(engineState, connection ?? {
        baseUrl: null, hostname: null, port: null, opencodeUsername: null, opencodePassword: null,
      });
    }
    return snapshotEngineState(engineState, inProcessServer?.managedOpencodeStatus?.() ?? null);
  }

  async function credentialVault() {
    // Match the local server's profile, environment overrides, module instance and write lock.
    const env = await buildChildEnv({});
    applyEmbeddedServerEnvironment(process.env, env);
    const directory = path.dirname(locateEmbeddedServerPath());
    const { OAuthVault, oauthVaultPath, vaultLock } = await import(pathToFileURL(path.join(directory, "file-storage/oauth/vault.js")).href);
    const { BrowserPasswordStore } = await import(pathToFileURL(path.join(directory, "browser-passwords.js")).href);
    const vault = new OAuthVault(oauthVaultPath({ configPath: resolveLegalworkServerConfigPath(env) }));
    return { vault, lock: vaultLock, browserPasswords: new BrowserPasswordStore(vault) };
  }

  async function startLegalworkServer(options) {
    const currentPort = legalworkServerState.port;
    const managedOpencode = options.manageOpencode ? resolveOpencodeBinary(options.opencodeBinPath) : null;
    // Verify host-only candidate capability before stopping an existing server.
    // The managed lifecycle rechecks the same bytes immediately before spawn.
    if (managedOpencode) await expectedOpencodeVersion(managedOpencode.path, opencodeCandidateBuild);
    // Stop any previously running in-process server
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(legalworkServerState);

    const host = "127.0.0.1";

    legalworkServerState.managedOpencodeBinPath = managedOpencode?.path ?? null;
    legalworkServerState.managedOpencodeBinSource = managedOpencode?.source ?? null;
    if (options.manageOpencode) {
      engineState.opencodeBinPath = managedOpencode?.path ?? null;
      engineState.opencodeBinSource = managedOpencode?.source ?? null;
    }

    // Inject user env vars so the server and managed OpenCode inherit them.
    const serverEnv = await buildChildEnv({});
    applyEmbeddedServerEnvironment(process.env, serverEnv);

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
    const embeddedPath = locateEmbeddedServerPath();
    const { startEmbeddedServer } = await import(pathToFileURL(embeddedPath).href);
    let mail;
    // Host startup control for staged Email-client rollout. Never remove or downgrade its stored data.
    const mailClientEnabled = process.env.LEGALWORK_EMAIL_CLIENT_ENABLED === undefined || process.env.LEGALWORK_EMAIL_CLIENT_ENABLED === '1';
    if (!options.remoteAccessEnabled && mailClientEnabled) {
      const { safeStorage, nativeImage, BrowserWindow, Notification, powerMonitor } = await import("electron");
      mail = await createDesktopMailService({ app, embeddedPath, safeStorage });
      configureMailPortability(mail);
      await configureMailBadge({ app, nativeImage, BrowserWindow, service: mail });
      await configureMailDesktop({app,service:mail,Notification,powerMonitor});
      // Reuse normal keychain preflight/unlock for existing profiles, including rotated stores.
      const mailDirectory = path.join(app.getPath("userData"), "mail");
      if (existsSync(path.join(mailDirectory, "mail.sqlite")) || existsSync(path.join(mailDirectory, "active-store-v1.json"))) void mail.unlock().catch(() => {});
    }
    // startEmbeddedServer falls back to an OS-assigned port if `port` races
    // into EADDRINUSE (see apps/server/src/serve-node.ts), so the bound port
    // below is authoritative.
    await officeAddinManager.refreshManifests();
    const existingNodeExecutable = () => {
      if (app.isPackaged) return path.join(bundledNodeDirectory(process.resourcesPath), process.platform === "win32" ? "node.exe" : "node");
      const executable = resolveBinary("node", [path.join(desktopRoot, "resources", "node")]);
      if (!executable) throw new Error("Node.js is required for managed HTTP transport and image crops in desktop development.");
      return executable;
    };
    const publishServerConnection = ({ port, url }) => {
      legalworkServerState.inProcess = true;
      legalworkServerState.remoteAccessEnabled = false;
      legalworkServerState.host = host;
      legalworkServerState.port = port;
      legalworkServerState.baseUrl = url;
      legalworkServerState.clientToken = tokens.clientToken;
      legalworkServerState.hostToken = tokens.hostToken;

      legalworkServerState.connectUrl = null;
      legalworkServerState.mdnsUrl = null;
      legalworkServerState.lanUrl = null;
      legalworkServerState.ownerToken = null;
    };
    const handle = await startEmbeddedServer({
      onListening: publishServerConnection,
      modelDownloadFetch,
      // Electron's Node TLS uses BoringSSL, whose legacy verifier cannot handle
      // valid IP-name-constrained CAs. Keep verification in our existing Node/OpenSSL runtime.
      rawHttpNodeExecutable: existingNodeExecutable,
      toolImageRasterRuntime: () => ({ executable: existingNodeExecutable(), ...toolImageRasterModules({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, serverEntry: embeddedPath }) }),
      opencodeSdkDirectory: bundledOpencodeSdkDirectory({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot }),
      decryptLegacyConnectorSecrets: async (value) => {
        const { safeStorage } = await import("electron");
        return safeStorage.decryptString(Buffer.from(value, "base64"));
      },
      projectsDirectory,
      host,
      port: portSelection.port,
      corsOrigins: ["*"],
      // Preserve the local convenience default without overriding an explicit
      // LEGALWORK_APPROVAL_MODE or server.json approval.mode setting.
      defaultApprovalMode: "auto",
      requestHostApproval,
      configPath: serverConfigPath,
      workspaces: workspacePaths,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
      opencodeBaseUrl: options.opencodeBaseUrl ?? undefined,
      opencodeUsername: options.opencodeUsername ?? undefined,
      opencodePassword: options.opencodePassword ?? undefined,
      opencodeDirectory: activeWorkspace || undefined,
      manageOpencode: options.manageOpencode === true,
      opencodeBin: managedOpencode?.path ?? undefined,
      opencodeCandidateBuild,
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
      mail,
      // Word/Excel/PowerPoint add-in listener — enabled via the Office Add-ins
      // settings tab; null when not installed so the listener stays off.
      ...(officeAddinManager.serverConfig() ?? {}),
    }).catch(async (error) => {
      legalworkServerState.inProcess = false;
      await mail?.stop();
      throw error;
    });
    publishServerConnection(handle);
    inProcessServer = handle;
    embeddedWorkspacePath = activeWorkspace || null;
    legalworkServerState.managedOpencodeExecution = handle.managedOpencodeExecution ?? null;

    const boundPort = handle.port;
    // startEmbeddedServer resolves after engine readiness. Its config is private to
    // this process; public workspace metadata deliberately contains no auth.
    engineState.runtime = DIRECT_RUNTIME;
    engineState.projectDir = activeWorkspace || null;
    engineState.execution = handle.managedOpencodeExecution ?? null;
    engineState.child = null;
    engineState.childExited = false;
    engineSnapshot();
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

    return engineSnapshot();
  }

  async function startDirectRuntime(projectDir, options = {}) {
    const opencodeBinary = resolveOpencodeBinary(options.opencodeBinPath);
    if (!opencodeBinary?.path) {
      throw new Error("Failed to locate opencode.");
    }

    const port = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();
    const env = await buildChildEnv({
      OPENCODE_PASSWORD: password,
    });

    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", "*"];
    engineState.execution = redactedExecutionSnapshot(opencodeBinary.path, args, projectDir, {
      OPENCODE_PASSWORD: password,
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

    await waitForHttpOk(`${engineState.baseUrl}/api/info`, 10_000, {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    });
    return engineSnapshot();
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

  async function engineStart(projectDir, options = {}, forceRestart = false) {
    const safeProjectDir = String(projectDir ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("projectDir is required");
    }
    const requestedBinary = resolveOpencodeBinary(options.opencodeBinPath);
    await expectedOpencodeVersion(requestedBinary.path, opencodeCandidateBuild);

    // Reuse a healthy server instead of tearing it down. During boot the
    // main process kicks off bootRuntimeForSelectedWorkspace while renderer
    // routes independently call ensureDesktopLocalLegalworkConnection. Both go
    // through this serialized path; without this guard the second call runs
    // prepareFreshRuntime (killing the freshly bound server) and then rebinds
    // the sticky preferred port, racing the not-yet-released socket into
    // EADDRINUSE and leaving the runtime in error -> boot screen.
    const requestedRemoteAccess = false;
    if (
      !forceRestart && legalworkServerState.inProcess &&
      lifecycleState === "healthy" &&
      normalizeWorkspaceKey(engineState.projectDir) === normalizeWorkspaceKey(safeProjectDir) &&
      legalworkServerState.remoteAccessEnabled === requestedRemoteAccess
    ) {
      const existing = snapshotLegalworkServerState(legalworkServerState);
      const managedEngine = inProcessServer?.managedOpencodeStatus?.();
      if (existing.running && existing.baseUrl && (existing.ownerToken || existing.clientToken) && managedEngine?.running !== false) {
        return engineSnapshot();
      }
    }

    // The engine runs in an app-owned directory. Project files are initialized
    // by the server so an unavailable selected project cannot block app boot.
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
      return engineSnapshot();
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
        console.error("[runtime] diagnostics:", JSON.stringify(await collectRuntimeDiagnostics(), null, 2));
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
    return engineSnapshot();
  }

  async function engineRestart(options = {}) {
    const projectDir = engineState.projectDir;
    if (!projectDir) {
      throw new Error("OpenCode is not configured for a local workspace");
    }
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeBinPath: engineState.opencodeBinPath,
      opencodeEnableExa: options.opencodeEnableExa,
      legalworkRemoteAccess: options.legalworkRemoteAccess ?? legalworkServerState.remoteAccessEnabled,
    }, true);
  }

  async function engineInfo() {
    return { ...engineSnapshot(), lifecycleState };
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
  async function collectRuntimeDiagnostics() {
    const diagTail = (value, limit = 4000) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      return text.length <= limit ? text : text.slice(text.length - limit);
    };
    const engine = engineSnapshot();
    const server = snapshotLegalworkServerState(legalworkServerState);
    let opencode = null;
    try {
      opencode = await engineDoctor({
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
    const engine = engineSnapshot();
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
    try {
      if (opencodeEngineSelection.kind === "derivative") {
        const current = findSelectedOpencodeBinary();
        if (current) {
          await expectedOpencodeVersion(current.path, opencodeCandidateBuild);
          return { ok: true, status: 0, stdout: `Verified selected LegalWork engine ${opencodeEngineSelection.version}.`, stderr: "" };
        }
        const target = opencodeReleaseTarget();
        const installed = await installSelectedOpencodeEngine({ directory: path.join(userDataDir, "engines", opencodeEngineSelection.artifactId, target),
          cacheDirectory: path.join(userDataDir, "downloads", "opencode"), target });
        await expectedOpencodeVersion(installed.path, installed.candidateBuild);
        return { ok: true, status: 0, stdout: `Installed selected LegalWork engine ${installed.version} from its verified cache.`, stderr: "" };
      }
      const installDir = path.join(app.getPath("home"), ".opencode", "bin");
      const result = await downloadOpencodeBinary({
        destination: path.join(installDir, process.platform === "win32" ? "opencode.exe" : "opencode"),
        cacheDirectory: path.join(userDataDir, "downloads", "opencode"),
        version: opencodeRelease.version,
      });
      return { ok: true, status: 0, stdout: `Installed OpenCode ${result.version} from its verified official package.`, stderr: "" };
    } catch (error) {
      return { ok: false, status: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
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

    const program = resolveOpencodeBinary().path;
    if (!program) {
      throw new Error("Failed to locate opencode.");
    }
    await expectedOpencodeVersion(program, opencodeCandidateBuild);

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

    return {
      legalworkUrl,
      token,
      ownerToken: null,
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
    prepareOpencodeConfig: async () => prepareOpencodeConfig({ ...loadUserEnvFile(), ...process.env }),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    forceStopOwnedChildren: () => {
      const managed = inProcessServer?.managedOpencodeStatus?.();
      if (managed?.running) killProcessId(managed.pid, "SIGKILL");
      const children = new Set([...stoppingChildren, ...[engineState, legalworkServerState, orchestratorState].map(state => state.child)]);
      for (const child of children) {
        if (child && child.exitCode == null && child.signalCode == null) {
          intentionallyStoppedChildren.add(child);
          child.kill("SIGKILL");
        }
      }
    },
    runtimeStatus,
    collectRuntimeDiagnostics,
    engineInfo,
    engineDoctor,
    engineInstall,
    legalworkServerInfo,
    credentialVault,
    legalworkServerRestart: (options) => withRuntimeLifecycle(() => legalworkServerRestart(options)),
    officeAddinStatus: () => officeAddinManager.status(),
    officeAddinInstall: (appId) => officeAddinManager.install(appId),
    officeAddinUninstall: (appId) => officeAddinManager.uninstall(appId),
    officeAddinOpenApp: (appId) => officeAddinManager.openApp(appId),
    orchestratorStatus,
    orchestratorWorkspaceActivate: (input) => withRuntimeLifecycle(() => orchestratorWorkspaceActivate(input)),
    orchestratorInstanceDispose,
    orchestratorStartDetached,
    opencodeMcpAuth,
    sandboxDoctor,
    sandboxStop,
    sandboxCleanupLegalworkContainers,
    sandboxDebugProbe,
  };
}
