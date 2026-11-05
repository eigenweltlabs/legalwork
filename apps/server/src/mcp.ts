import { minimatch } from "minimatch";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { McpItem, ServerConfig, WorkspaceInfo } from "./types.js";
import { connectorConfigVariables, isCredentialHeader } from "./connector-config.js";
import type { ConnectorDisplayItem, ConnectorEditRemovals, ConnectorConfigEdit } from "@legalwork/types/connector-config";
import { z } from "zod";
import { ApiError, findApiError } from "./errors.js";
import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { engineProjectStatus } from "./engine-project.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { readJsoncFile } from "./jsonc.js";
import { globalOpencodeConfigDir, opencodeConfigPaths } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";
import {
  GLOBAL_MCP_ID,
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

/**
 * Where a runtime (LegalWork-owned) MCP entry lives. Connecting an app means
 * connecting it for every workspace, so "global" is the default everywhere;
 * "workspace" is for entries that belong to one workspace by construction,
 * such as the MCPs a plugin installed there brings along.
 */
export type McpScope = "workspace" | "global";

export function globalOpenCodeConfigPath(): string {
  // Respect XDG_CONFIG_HOME so we read the SAME global config the engine does. The
  // desktop dev harness points XDG_CONFIG_HOME at its own data dir; hardcoding
  // ~/.config here made the server read a different file than the engine, so global
  // MCPs silently disappeared (the sync clobbered them). Matches the precedent in
  // opencode-plugins/legalwork-extensions-preview.ts.
  const base = globalOpencodeConfigDir();
  const jsonc = join(base, "opencode.jsonc");
  const json = join(base, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc; // fall back to jsonc (readJsoncFile handles missing files gracefully)
}

function hasOwn(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

async function readMcpRows(serverConfig: ServerConfig, workspaceId: string) {
  const [globalRow, workspaceRow] = await Promise.all([
    readRuntimeOpencodeConfig(serverConfig, GLOBAL_MCP_ID),
    readRuntimeOpencodeConfig(serverConfig, workspaceId),
  ]);
  return { global: runtimeMcpMap(globalRow), workspace: runtimeMcpMap(workspaceRow) };
}

/**
 * The runtime MCPs a workspace's engine instance should carry: the shared
 * connectors, overridden by the workspace's own entries of the same name. This
 * is the map the engine config file is built from and the map hot-added into
 * a running instance, so the two can never disagree.
 */
export async function runtimeMcpMapForWorkspace(
  serverConfig: ServerConfig,
  workspaceId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await readMcpRows(serverConfig, workspaceId);
  return { ...rows.global, ...rows.workspace };
}

export async function existingMcpScope(config: ServerConfig, workspaceId: string, name: string): Promise<McpScope | null> {
  const rows = await readMcpRows(config, workspaceId);
  return hasOwn(rows.workspace, name) ? "workspace" : hasOwn(rows.global, name) ? "global" : null;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Native v2 nests definitions under servers. A legacy connector named
 * "servers" is still an ordinary definition when it has its own type. */
export function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!record(mcp)) return {};
  const servers = record(mcp.servers) && mcp.servers.type !== "local" && mcp.servers.type !== "remote" ? mcp.servers : mcp;
  return Object.fromEntries(Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] =>
    record(entry[1]) && (entry[1].type === "local" || entry[1].type === "remote")));
}

/** No saved executable string is a safe public field: URLs and commands can
 * contain credentials just as easily as a header or OAuth option can. */
export function mcpDisplayItem(item: McpItem): ConnectorDisplayItem {
  const value = item.config;
  const headers = record(value.headers) ? value.headers : {};
  const oauth = value.type === "remote" && value.oauth !== false
    && (record(value.oauth) || !Object.keys(headers).some(isCredentialHeader));
  const timeout = typeof value.timeout === "number" ? value.timeout
    : record(value.timeout) && typeof value.timeout.execution === "number" ? value.timeout.execution : undefined;
  return {
    name: item.name, source: item.source, editable: item.source === "config.remote",
    ...(item.disabledByTools ? { disabledByTools: true } : {}),
    config: { type: value.type === "local" ? "local" : "remote", enabled: value.enabled !== false && value.disabled !== true,
      ...(timeout === undefined ? {} : { timeout }), ...(value.type === "remote" ? { oauth: oauth ? {} : false } : {}) },
    configured: {
      url: typeof value.url === "string", command: Array.isArray(value.command), cwd: typeof value.cwd === "string",
      headers: Object.keys(headers), environment: record(value.environment) ? Object.keys(value.environment) : [],
      oauth: !!oauth, variables: connectorConfigVariables(value),
    },
  };
}

export const mcpEditRemovalsSchema = z.object({
  removeHeaders: z.array(z.string()).optional(), removeEnvironment: z.array(z.string()).optional(),
  resetFields: z.array(z.enum(["cwd", "timeout", "oauth"])).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  arguments: z.array(z.string()).optional(),
  executable: z.string().min(1).optional(),
});

function resolveSavedVariables(value: unknown, variables: Record<string, string>, path: string[] = []): unknown {
  if (typeof value === "string") return value.replace(/\$\{([^}]+)\}|\{env:([^}]+)\}/g, (_match, template: string | undefined, environment: string | undefined) => {
    const name = template ?? environment ?? "", answer = variables[name];
    if (!answer?.trim()) throw new ApiError(400, "connector_setup_required", `Complete the connector's ${name} setting.`);
    return path.at(-2) === "headers" && value === "Basic ${BASIC_AUTH_CREDENTIALS}" && name === "BASIC_AUTH_CREDENTIALS"
      ? Buffer.from(answer, "utf8").toString("base64") : answer;
  });
  if (Array.isArray(value)) return value.map((item, index) => resolveSavedVariables(item, variables, [...path, String(index)]));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSavedVariables(item, variables, [...path, key])]));
  return value;
}

/** A metadata-only edit must not erase values deliberately absent from reads. */
export function mergeMcpEdit(current: Record<string, unknown>, update: Record<string, unknown>, removals: ConnectorEditRemovals): Record<string, unknown> {
  if (update.type !== undefined && update.type !== current.type) return { ...update };
  const next = { ...current, ...update };
  for (const field of ["headers", "environment", "oauth"]) {
    if (record(current[field]) && record(update[field])) next[field] = { ...current[field], ...update[field] };
  }
  if (record(next.headers)) {
    const headers = { ...next.headers };
    // HTTP header names are case-insensitive. A replacement must not leave
    // a second differently-cased copy of the old credential behind.
    if (record(update.headers)) for (const name of Object.keys(update.headers)) {
      for (const saved of Object.keys(headers)) if (saved !== name && saved.toLowerCase() === name.toLowerCase()) delete headers[saved];
    }
    for (const name of removals.removeHeaders ?? []) for (const saved of Object.keys(headers)) {
      if (saved.toLowerCase() === name.toLowerCase()) delete headers[saved];
    }
    next.headers = headers;
  }
  if (record(next.environment)) {
    const environment = { ...next.environment };
    for (const name of removals.removeEnvironment ?? []) delete environment[name];
    next.environment = environment;
  }
  for (const field of removals.resetFields ?? []) delete next[field];
  return next;
}

function getDeniedToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!tools || typeof tools !== "object") return [];
  const deny = (tools as { deny?: unknown }).deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((item) => typeof item === "string") as string[];
}

function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const patterns = getDeniedToolPatterns(config);
  if (patterns.length === 0) return false;
  const candidates = [`mcp.${name}`, `mcp.${name}.*`, `mcp:${name}`, `mcp:${name}:*`, "mcp.*", "mcp:*"];
  return patterns.some((pattern) => candidates.some((candidate) => minimatch(candidate, pattern)));
}

export async function listMcp(serverConfig: ServerConfig, workspaceId: string, workspaceRoot: string): Promise<McpItem[]> {
  const read = async (paths: string[]) => {
    let config: Record<string, unknown> = {}, servers: Record<string, Record<string, unknown>> = {};
    for (const path of paths) {
      const { data } = await readJsoncFile<Record<string, unknown>>(path, {}, { allowInvalid: true });
      config = { ...config, ...data };
      servers = { ...servers, ...getMcpConfig(data) };
    }
    return { ...config, mcp: { servers } };
  };
  const [config, globalConfig] = await Promise.all([
    read([...opencodeConfigPaths(workspaceRoot)].reverse()),
    read([join(globalOpencodeConfigDir(), "opencode.json"), join(globalOpencodeConfigDir(), "opencode.jsonc")]),
  ]);

  const projectMcpMap = getMcpConfig(config);
  const globalMcpMap = getMcpConfig(globalConfig);
  const runtimeMap = await runtimeMcpMapForWorkspace(serverConfig, workspaceId);

  const items: McpItem[] = [];

  // Global MCPs first; project-level entries override global ones with the
  // same name. A runtime entry of the same name wins too: earlier desktop
  // builds wrote every connector into the user's global opencode config, and
  // the startup migration imports those into the shared runtime row, so the
  // file copy must not show up as a second, read-only card.
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (hasOwn(projectMcpMap, name) || hasOwn(runtimeMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.global",
      disabledByTools:
        (isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(config, name)) || undefined,
    });
  }

  // Project MCPs (highest priority).
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    if (hasOwn(runtimeMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.project",
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  // LegalWork-owned MCPs are stored by the server and injected at runtime.
  for (const [name, entry] of Object.entries(runtimeMap)) {
    items.push({
      name,
      config: entry,
      source: "config.remote",
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  return items;
}

/** Once approved and connected, use OpenCode's actual ordered documents. It
 * owns ancestor discovery and variable expansion. Offline/unapproved display
 * reads literal definitions only and never starts project automation. */
export async function listMcpDisplay(config: ServerConfig, workspace: WorkspaceInfo): Promise<ConnectorDisplayItem[]> {
  const stored = await listMcp(config, workspace.id, workspace.path);
  const project = await engineProjectStatus(config, workspace);
  if (!resolveWorkspaceOpencodeConnection(config, workspace).baseUrl || project.state !== "ready") {
    return stored.map(mcpDisplayItem);
  }
  const entries = await createEngineClient(config, workspace).config.get({ location: workspaceEngineLocation(workspace) }).catch(error => {
    if (findApiError(error)?.code === "opencode_unavailable") return undefined;
    throw error;
  });
  if (!entries) return stored.map(mcpDisplayItem);
  const effective = new Map<string, McpItem>();
  const owned = new Set(Object.keys(await runtimeMcpMapForWorkspace(config, workspace.id)));
  let timeout: Record<string, unknown> = {};
  for (const entry of entries) if (entry.type === "document" && entry.info.mcp?.timeout) timeout = { ...timeout, ...entry.info.mcp.timeout };
  for (const entry of entries) {
    if (entry.type !== "document") continue;
    const globalRelative = entry.path ? relative(globalOpencodeConfigDir(), entry.path) : undefined;
    const global = globalRelative !== undefined && !isAbsolute(globalRelative) && globalRelative !== ".." && !globalRelative.startsWith("../") && !globalRelative.startsWith("..\\");
    for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {})) {
      effective.set(name, { name, config: { ...server, timeout: { ...timeout, ...server.timeout } },
        source: entry.path === project.projection.path && owned.has(name) ? "config.remote" : global ? "config.global" : "config.project" });
    }
  }
  // A managed definition may still be propagating through the native watcher.
  // Keep its saved setup/status visible rather than erasing the connection.
  for (const item of stored) if (owned.has(item.name) && !effective.has(item.name)) effective.set(item.name, item);
  return [...effective.values()].map(mcpDisplayItem);
}

function withoutMcp(name: string) {
  return (current: RuntimeOpencodeConfig): RuntimeOpencodeConfig => {
    const mcp = { ...runtimeMcpMap(current) };
    delete mcp[name];
    return { ...current, mcp };
  };
}

export async function addMcp(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  config: Record<string, unknown>,
  scope: McpScope = "global",
  edit?: ConnectorConfigEdit,
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  const rows = await readMcpRows(serverConfig, workspaceId);
  const existed = hasOwn(rows.global, name) || hasOwn(rows.workspace, name);
  const rowId = scope === "global" ? GLOBAL_MCP_ID : workspaceId;
  await writeRuntimeOpencodeConfig(serverConfig, rowId, row => {
    const map = runtimeMcpMap(row), current = map[name];
    if (edit && !current) throw new ApiError(404, "connector_not_found", "This app-owned connector is no longer available.");
    const merged = edit && current ? mergeMcpEdit(current, config, edit) : config;
    if (edit?.arguments !== undefined || edit?.executable !== undefined) {
      if (merged.type !== "local" || !Array.isArray(merged.command) || typeof merged.command[0] !== "string") {
        throw new ApiError(400, "invalid_mcp_config", "Command arguments require a saved local executable.");
      }
      merged.command = [edit.executable ?? merged.command[0], ...(edit.arguments ?? merged.command.slice(1))];
    }
    const definition = edit?.variables ? resolveSavedVariables(merged, edit.variables) : merged;
    if (!record(definition)) throw new ApiError(400, "invalid_mcp_config", "Connector configuration must be an object.");
    validateMcpConfig(definition);
    return { ...row, mcp: { ...map, [name]: definition } };
  });
  // A workspace copy of the same name would shadow the shared entry in this
  // workspace's engine config.
  if (scope === "global" && workspaceId !== GLOBAL_MCP_ID && hasOwn(rows.workspace, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, workspaceId, withoutMcp(name));
  }
  return { action: existed ? "updated" : "added" };
}

/**
 * Remove an MCP wherever it is stored. Returns the scopes it was
 * removed from; empty means nothing was stored under that name. Removing from
 * both rows is deliberate: the user is disconnecting the app, not editing a
 * particular row, and a surviving copy in the other row would resurrect it.
 */
export async function removeMcp(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<McpScope[]> {
  validateMcpName(name);
  const rows = await readMcpRows(serverConfig, workspaceId);
  const removed: McpScope[] = [];
  if (hasOwn(rows.workspace, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, workspaceId, withoutMcp(name));
  }
  if (hasOwn(rows.workspace, name)) removed.push("workspace");
  if (hasOwn(rows.global, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, GLOBAL_MCP_ID, withoutMcp(name));
  }
  if (hasOwn(rows.global, name)) removed.push("global");
  return removed;
}

// Flips `enabled` on a runtime MCP entry, in whichever row holds it (the
// workspace's own row shadows the shared one, so it is checked first).
// Returns false for "toggle does not apply": missing, non-object, or malformed
// enough that OpenCode would fail to load it. The HTTP layer maps false to
// 404. Entries from the user's own config files are out of scope by design.
export async function setMcpEnabled(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  validateMcpName(name);
  const rows = await readMcpRows(serverConfig, workspaceId);
  const rowId = hasOwn(rows.workspace, name) ? workspaceId : hasOwn(rows.global, name) ? GLOBAL_MCP_ID : null;
  if (!rowId) return false;
  let updated = false;
  await writeRuntimeOpencodeConfig(serverConfig, rowId, currentConfig => {
    const connectors = runtimeMcpMap(currentConfig);
    const current = connectors[name];
    if (!current || typeof current !== "object" || Array.isArray(current)) return currentConfig;
    try { validateMcpConfig({ ...current, enabled }); }
    catch { return currentConfig; }
    updated = true;
    return { ...currentConfig, mcp: { ...connectors, [name]: { ...current, enabled } } };
  });
  return updated;
}
