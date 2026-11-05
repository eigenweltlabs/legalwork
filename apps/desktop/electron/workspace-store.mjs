// Desktop workspace persistence and bootstrap configuration. This module owns
// on-disk local workspace state, per-workspace legalwork.json files, legacy
// record preservation, and the workspace-facing command operations.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureOpencodeStateDir } from "./opencode-state-dir.mjs";
import { exportWorkspaceConfig, importWorkspaceConfig } from "./workspace-archive.mjs";

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseFirstJsonObject(raw) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          return { ok: true, value: JSON.parse(raw.slice(start, index + 1)) };
        } catch {
          return { ok: false, value: null };
        }
      }
    }
  }

  return { ok: false, value: null };
}

async function writeJsonFileAtomic(outputPath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, outputPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      const recovered = parseFirstJsonObject(raw);
      if (recovered.ok) {
        console.warn(`[json] recovered ${targetPath} from trailing invalid data`, error);
        await writeJsonFileAtomic(targetPath, recovered.value);
        return recovered.value;
      }
      throw error;
    }
  } catch {
    return fallback;
  }
}

export function createWorkspaceStore({ app, defaultDenBaseUrl, defaultRequireSignin, forceRequireSignin }) {
  function desktopBootstrapPath() {
    if (process.env.LEGALWORK_DESKTOP_BOOTSTRAP_PATH?.trim()) {
      return process.env.LEGALWORK_DESKTOP_BOOTSTRAP_PATH.trim();
    }
    // Dev mode swaps process.env.HOME to the sandboxed dev-data home midway
    // through startup (runtime.mjs buildChildEnv -> Object.assign(process.env)),
    // which changes what os.homedir() returns. Resolve the dev-data home
    // deterministically so early and late IPC reads target the same file.
    if (process.env.LEGALWORK_DEV_MODE === "1") {
      return path.join(
        app.getPath("userData"),
        "legalwork-dev-data",
        "home",
        ".config",
        "legalwork",
        "desktop-bootstrap.json",
      );
    }
    return path.join(os.homedir(), ".config", "legalwork", "desktop-bootstrap.json");
  }

  function workspaceStatePath() {
    return path.join(app.getPath("userData"), "legalwork-workspaces.json");
  }

  function legalworkServerTokenStorePath() {
    return path.join(app.getPath("userData"), "legalwork-server-tokens.json");
  }

  function legalworkServerConfigPath() {
    if (process.env.LEGALWORK_SERVER_CONFIG?.trim()) return path.resolve(process.env.LEGALWORK_SERVER_CONFIG.trim());
    if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "legalwork", "server.json");
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "legalwork", "server.json");
  }

  // Earlier Electron alpha builds copied Tauri's legalwork-workspaces.json into
  // an Electron-only workspace-state.json. Keep importing that file when the
  // shared canonical file is missing, but write legalwork-workspaces.json going
  // forward so Tauri rollback and Electron both read the same desktop state.
  function legacyElectronWorkspaceStatePath() {
    return path.join(app.getPath("userData"), "workspace-state.json");
  }

  async function migrateLegacyElectronWorkspaceStateIfNeeded() {
    const current = workspaceStatePath();
    const legacy = legacyElectronWorkspaceStatePath();
    try {
      if (existsSync(current)) return false;
      if (!existsSync(legacy)) return false;
      await mkdir(path.dirname(current), { recursive: true });
      const raw = await readFile(legacy, "utf8");
      await writeFile(current, raw, "utf8");
      console.info("[migration] copied workspace-state.json to legalwork-workspaces.json");
      return true;
    } catch (error) {
      console.warn("[migration] legacy Electron workspace-state copy failed", error);
      return false;
    }
  }

  function normalizeDesktopBootstrapConfig(input) {
    const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }

    const apiBaseUrl =
      typeof input?.apiBaseUrl === "string" && input.apiBaseUrl.trim().length > 0
        ? input.apiBaseUrl.trim()
        : null;
    return {
      baseUrl,
      apiBaseUrl,
      requireSignin: forceRequireSignin || input?.requireSignin === true,
    };
  }

  async function getDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    try {
      const raw = await readFile(configPath, "utf8");
      return normalizeDesktopBootstrapConfig(JSON.parse(raw));
    } catch (error) {
      console.warn("[desktop-bootstrap] falling back to defaults", {
        path: configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        baseUrl: defaultDenBaseUrl,
        apiBaseUrl: null,
        requireSignin: defaultRequireSignin,
      };
    }
  }

  async function debugDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const result = {
      path: configPath,
      home: os.homedir(),
      envHome: process.env.HOME ?? null,
      envOverride: process.env.LEGALWORK_DESKTOP_BOOTSTRAP_PATH ?? null,
      exists: existsSync(configPath),
      raw: null,
      parsed: null,
      normalized: null,
      error: null,
    };

    try {
      result.raw = await readFile(configPath, "utf8");
      result.parsed = JSON.parse(result.raw);
      result.normalized = normalizeDesktopBootstrapConfig(result.parsed);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  async function setDesktopBootstrapConfig(config) {
    const normalized = normalizeDesktopBootstrapConfig(config);
    const outputPath = desktopBootstrapPath();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  function defaultWorkspaceLegalworkConfig(workspacePath, preset = null) {
    return {
      version: 1,
      workspace: workspacePath
        ? {
            name: path.basename(workspacePath) || "Workspace",
            createdAt: Date.now(),
            preset: preset || null,
          }
        : null,
      authorizedRoots: workspacePath ? [workspacePath] : [],
      reload: null,
    };
  }

  async function normalizeLocalWorkspacePath(rawPath) {
    const trimmed = String(rawPath ?? "").trim();
    if (!trimmed) return "";
    const expanded = trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
    const resolved = path.resolve(expanded);
    return realpath(resolved).catch(() => resolved);
  }

  function normalizeWorkspacePathKey(value) {
    const trimmed = String(value ?? "").trim();
    return trimmed ? path.resolve(trimmed).replace(/\\/g, "/").toLowerCase() : "";
  }

  function normalizeRecoveredWorkspacePath(value) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    if (process.platform !== "win32") return trimmed;
    return trimmed
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/i, "")
      .replace(/^\/\/\?\/UNC\//i, "//")
      .replace(/^\/\/\?\//i, "")
      .replace(/\//g, "\\");
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  async function recoverWorkspacesFromTokenStore() {
    const store = await readJsonFile(legalworkServerTokenStorePath(), null);
    if (!isRecord(store) || !isRecord(store.workspaces)) return [];

    const candidates = [];
    for (const [rawPath, entry] of Object.entries(store.workspaces)) {
      const normalizedInput = normalizeRecoveredWorkspacePath(rawPath);
      if (!normalizedInput) continue;
      const workspacePath = await normalizeLocalWorkspacePath(normalizedInput);
      if (!(await pathExists(workspacePath))) continue;
      candidates.push({
        path: workspacePath,
        updatedAt: isRecord(entry) && typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      });
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const seen = new Set();
    return candidates.flatMap((candidate) => {
      const key = normalizeWorkspacePathKey(candidate.path);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [normalizeWorkspaceEntry({
        id: localWorkspaceId(candidate.path),
        name: path.basename(candidate.path) || "Workspace",
        displayName: path.basename(candidate.path) || "Workspace",
        path: candidate.path,
        preset: "starter",
        workspaceType: "local",
      })];
    });
  }

  async function recoverWorkspacesFromServerConfig() {
    const config = await readJsonFile(legalworkServerConfigPath(), null);
    if (!isRecord(config) || !Array.isArray(config.workspaces)) return [];

    const seen = new Set();
    const workspaces = [];
    for (const entry of config.workspaces) {
      if (!isRecord(entry)) continue;
      if (entry.workspaceType === "remote") continue;
      const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
      const normalizedPath = await normalizeLocalWorkspacePath(normalizeRecoveredWorkspacePath(rawPath));
      if (!normalizedPath || !(await pathExists(normalizedPath))) continue;
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : localWorkspaceId(normalizedPath);
      const key = normalizeWorkspacePathKey(normalizedPath);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      workspaces.push(normalizeWorkspaceEntry({
        ...entry,
        id,
        path: normalizedPath,
        name: typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : path.basename(normalizedPath) || "Workspace",
        displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
        preset: typeof entry.preset === "string" && entry.preset.trim() ? entry.preset.trim() : "starter",
        workspaceType: "local",
      }));
    }
    return workspaces;
  }

  async function recoverWorkspacesFromKnownState() {
    const fromServerConfig = await recoverWorkspacesFromServerConfig();
    if (fromServerConfig.length > 0) return fromServerConfig;
    return recoverWorkspacesFromTokenStore();
  }

  function stableWorkspaceId(value) {
    return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
  }

  function localWorkspaceId(workspacePath) {
    return stableWorkspaceId(workspacePath);
  }

  function normalizeWorkspaceEntry(input) {
    return {
      id: String(input.id),
      name: String(input.name ?? "Workspace"),
      path: String(input.path ?? ""),
      preset: String(input.preset ?? "starter"),
      workspaceType: "local",
      baseUrl: input.baseUrl ?? null,
      directory: input.directory ?? null,
      displayName: input.displayName ?? null,
      sandboxBackend: input.sandboxBackend ?? null,
      sandboxRunId: input.sandboxRunId ?? null,
      sandboxContainerName: input.sandboxContainerName ?? null,
    };
  }

  async function readWorkspaceLegalworkConfig(workspacePath) {
    const legalworkPath = path.join(workspacePath, ".opencode", "legalwork.json");
    if (!(await pathExists(legalworkPath))) {
      return defaultWorkspaceLegalworkConfig(workspacePath);
    }
    const raw = await readFile(legalworkPath, "utf8");
    return JSON.parse(raw);
  }

  async function writeWorkspaceLegalworkConfig(workspacePath, config) {
    const legalworkPath = path.join(workspacePath, ".opencode", "legalwork.json");
    // A stray file named .opencode makes this mkdir throw EEXIST (and breaks
    // the engine the same way) — repair it rather than failing the write.
    await ensureOpencodeStateDir(workspacePath);
    await writeFile(legalworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return execResult(true, `Wrote ${legalworkPath}`);
  }

  async function writeWorkspaceStateUnchecked(nextState) {
    const outputPath = workspaceStatePath();
    const selectedId = String(nextState?.selectedId ?? nextState?.activeId ?? "");
    const watchedId = typeof nextState?.watchedId === "string" ? nextState.watchedId : "";
    // Retired records are archival input only. Keep the original connection
    // configuration on disk across local edits, without returning credentials.
    const previous = await readJsonFile(outputPath, EMPTY_WORKSPACE_LIST);
    const retired = Array.isArray(previous.workspaces) ? previous.workspaces.filter(entry => entry?.workspaceType === "remote") : [];
    const activeWorkspaces = nextState.workspaces.filter(entry => entry?.workspaceType !== "remote");
    const output = {
      ...nextState,
      workspaces: [...activeWorkspaces, ...retired],
      recoveryCompleted: true,
      // Tauri's Rust state uses selectedWorkspaceId/watchedWorkspaceId on disk
      // with activeId as a legacy alias. Keep Electron's selectedId/watchedId
      // too so older Electron builds can still read the same file.
      selectedId,
      selectedWorkspaceId: selectedId,
      watchedId: watchedId || null,
      watchedWorkspaceId: watchedId,
      activeId: selectedId || null,
    };
    await writeJsonFileAtomic(outputPath, output);
    return { ...output, workspaces: activeWorkspaces };
  }

  async function readWorkspaceStateUnchecked() {
    // A killed writer cannot run its finally block. Reap only this store's old
    // temporary files, and only when their owning process is known to be gone.
    const directory = app.getPath("userData");
    for (const name of await readdir(directory).catch(() => [])) {
      const match = /^legalwork-workspaces\.json\.(\d+)\.([a-f0-9]{12})\.tmp$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const target = path.join(directory, name);
      try {
        const file = await lstat(target);
        if (!file.isFile() || Date.now() - file.mtimeMs < 60_000) continue;
        try { process.kill(pid, 0); continue; }
        catch (error) { if (error?.code !== "ESRCH") continue; }
        await rm(target, { force: true });
      } catch { /* Cleanup must never prevent reading the committed state. */ }
    }
    const state = await readJsonFile(workspaceStatePath(), EMPTY_WORKSPACE_LIST);
    let selectedId =
      typeof state?.selectedId === "string"
        ? state.selectedId
        : typeof state?.selectedWorkspaceId === "string"
          ? state.selectedWorkspaceId
          : typeof state?.activeId === "string"
            ? state.activeId
            : "";
    let watchedId =
      typeof state?.watchedId === "string"
        ? state.watchedId
        : typeof state?.watchedWorkspaceId === "string"
          ? state.watchedWorkspaceId
          : null;
    let activeId = typeof state?.activeId === "string" ? state.activeId : null;
    let workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
    let changed = state?.recoveryCompleted !== true;
    if (!state?.recoveryCompleted && workspaces.length === 0 && process.env.LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY !== "1") {
      const recoveredWorkspaces = await recoverWorkspacesFromKnownState();
      if (recoveredWorkspaces.length > 0) {
        const selectedWorkspace = recoveredWorkspaces[0];
        console.info("[migration] recovered desktop workspaces from persisted LegalWork state", {
          count: recoveredWorkspaces.length,
          selectedWorkspaceId: selectedWorkspace.id,
        });
        selectedId = selectedWorkspace.id;
        watchedId = selectedWorkspace.id;
        activeId = selectedWorkspace.id;
        workspaces = recoveredWorkspaces;
        changed = true;
      }
    }
    const retired = workspaces.filter(entry => entry?.workspaceType === "remote");
    workspaces = workspaces.filter(entry => entry?.workspaceType !== "remote");
    const warnings = retired.length ? [`${retired.length} saved remote agent workspace(s) are no longer supported. Their connection settings remain preserved in ${workspaceStatePath()}.`] : [];
    const selected = workspaces.some(entry => entry.id === selectedId) ? selectedId : workspaces[0]?.id ?? "";
    const watched = workspaces.some(entry => entry.id === watchedId) ? watchedId : selected || null;
    const active = workspaces.some(entry => entry.id === activeId) ? activeId : selected || null;
    if (selected !== selectedId || watched !== watchedId || active !== activeId) changed = true;
    const nextState = { recoveryCompleted: true, selectedId: selected, watchedId: watched, activeId: active, workspaces, warnings };

    if (changed) {
      return writeWorkspaceStateUnchecked(nextState);
    }
    return nextState;
  }

  // Reads may migrate state too. Serialize the entire transaction so a second
  // window cannot overwrite a removal with a selection based on an older list.
  let stateOperations = Promise.resolve();
  /** @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  function withWorkspaceState(operation) {
    const result = stateOperations.then(operation);
    stateOperations = result.then(() => undefined, () => undefined);
    return result;
  }
  function readWorkspaceState() {
    return withWorkspaceState(readWorkspaceStateUnchecked);
  }
  function writeWorkspaceState(state) {
    return withWorkspaceState(() => writeWorkspaceStateUnchecked(state));
  }
  function mutateWorkspaceState(mutator) {
    return withWorkspaceState(async () => {
      const current = await readWorkspaceStateUnchecked();
      const next = await mutator({ ...current, workspaces: [...current.workspaces] });
      return writeWorkspaceStateUnchecked(next);
    });
  }

  async function listLocalWorkspacePaths() {
    return (await readWorkspaceState())
      .workspaces
      .filter((entry) => entry?.workspaceType !== "remote")
      .map((entry) => String(entry?.path ?? "").trim())
      .filter(Boolean);
  }

  function workspacePathKey(workspace) {
    return normalizeWorkspacePathKey(workspace.path);
  }

  async function setSelectedWorkspace(workspaceId) {
    return mutateWorkspaceState(async (state) => {
      // Projects created through the server must also survive a desktop restart.
      // Register the selected project without recreating its folder or metadata.
      if (workspaceId && !state.workspaces.some((entry) => entry.id === workspaceId)) {
        const created = (await recoverWorkspacesFromServerConfig()).find((entry) => entry.id === workspaceId);
        if (created) state.workspaces.unshift(created);
      }
      if (workspaceId && !state.workspaces.some((entry) => entry.id === workspaceId)) return state;
      state.selectedId = workspaceId;
      state.activeId = workspaceId || null;
      return state;
    });
  }

  async function setRuntimeActiveWorkspace(workspaceId) {
    return mutateWorkspaceState((state) => {
      state.watchedId = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId : null;
      return state;
    });
  }

  async function createWorkspace(input = {}) {
    const rawFolderPath = String(input.folderPath ?? "").trim();
    if (!rawFolderPath) throw new Error("folderPath is required");
    const folderPath = await normalizeLocalWorkspacePath(rawFolderPath);
    await mkdir(folderPath, { recursive: true });
    const preset = String(input.preset ?? "starter");
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(folderPath),
      name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      displayName: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      path: folderPath,
      preset,
      workspaceType: "local",
    });
    await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
    await writeWorkspaceLegalworkConfig(folderPath, defaultWorkspaceLegalworkConfig(folderPath, preset));

    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function updateWorkspaceDisplayName(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId ? { ...entry, displayName: input.displayName ?? null } : entry,
      );
      return state;
    });
  }

  async function forgetWorkspace(workspaceId) {
    if (!workspaceId) throw new Error("workspaceId is required");
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
      if (state.selectedId === workspaceId) state.selectedId = "";
      if (state.activeId === workspaceId) state.activeId = null;
      if (state.watchedId === workspaceId) state.watchedId = null;
      return state;
    });
  }

  async function addAuthorizedRoot(input = {}) {
    const workspacePath = String(input.workspacePath ?? "").trim();
    const authorizedRoot = String(input.folderPath ?? input.authorizedRoot ?? "").trim();
    if (!workspacePath || !authorizedRoot) {
      throw new Error("workspacePath and folderPath are required");
    }
    const config = await readWorkspaceLegalworkConfig(workspacePath);
    if (!Array.isArray(config.authorizedRoots)) {
      config.authorizedRoots = [];
    }
    if (!config.authorizedRoots.includes(authorizedRoot)) {
      config.authorizedRoots.push(authorizedRoot);
    }
    return writeWorkspaceLegalworkConfig(workspacePath, config);
  }

  async function exportConfig(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    const outputPath = String(input.outputPath ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!outputPath) throw new Error("outputPath is required");
    const state = await readWorkspaceState();
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Unknown workspaceId");
    return exportWorkspaceConfig({ workspace, outputPath });
  }

  async function importConfig(input = {}) {
    const archivePath = String(input.archivePath ?? "").trim();
    const targetDirRaw = String(input.targetDir ?? "").trim();
    if (!archivePath) throw new Error("archivePath is required");
    if (!targetDirRaw) throw new Error("targetDir is required");
    const targetDir = await normalizeLocalWorkspacePath(targetDirRaw);
    const imported = await importWorkspaceConfig({
      archivePath,
      targetDir,
      name: input.name ?? null,
    });
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(targetDir),
      name: imported.workspaceName,
      displayName: null,
      path: targetDir,
      preset: imported.preset,
      workspaceType: "local",
    });
    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function resetLegalworkState() {
    await rm(workspaceStatePath(), { force: true });
    await rm(desktopBootstrapPath(), { force: true });
    return undefined;
  }

  return {
    addAuthorizedRoot,
    createWorkspace,
    debugDesktopBootstrapConfig,
    defaultWorkspaceLegalworkConfig,
    exportConfig,
    forgetWorkspace,
    getDesktopBootstrapConfig,
    importConfig,
    listLocalWorkspacePaths,
    migrateLegacyElectronWorkspaceStateIfNeeded,
    readWorkspaceLegalworkConfig,
    readWorkspaceState,
    resetLegalworkState,
    setDesktopBootstrapConfig,
    setRuntimeActiveWorkspace,
    setSelectedWorkspace,
    updateWorkspaceDisplayName,
    writeWorkspaceLegalworkConfig,
    writeWorkspaceState,
  };
}
