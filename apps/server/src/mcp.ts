import { minimatch } from "minimatch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpItem, ServerConfig } from "./types.js";
import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
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
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const base = join(configHome, "opencode");
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

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  return mcp as Record<string, Record<string, unknown>>;
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
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>, { allowInvalid: true });

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
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config);
  const rows = await readMcpRows(serverConfig, workspaceId);
  const existed = hasOwn(rows.global, name) || hasOwn(rows.workspace, name);
  const rowId = scope === "global" ? GLOBAL_MCP_ID : workspaceId;
  await writeRuntimeOpencodeConfig(serverConfig, rowId, (current) => ({
    ...current,
    mcp: { ...runtimeMcpMap(current), [name]: config },
  }));
  // A workspace copy of the same name would shadow the shared entry in this
  // workspace's engine config.
  if (scope === "global" && hasOwn(rows.workspace, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, workspaceId, withoutMcp(name));
  }
  return { action: existed ? "updated" : "added" };
}

/**
 * Remove a runtime MCP wherever it is stored. Returns the scopes it was
 * removed from; empty means nothing was stored under that name. Removing from
 * both rows is deliberate: the user is disconnecting the app, not editing a
 * particular row, and a surviving copy in the other row would resurrect it.
 */
export async function removeMcp(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<McpScope[]> {
  const rows = await readMcpRows(serverConfig, workspaceId);
  const removed: McpScope[] = [];
  if (hasOwn(rows.workspace, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, workspaceId, withoutMcp(name));
    removed.push("workspace");
  }
  if (hasOwn(rows.global, name)) {
    await writeRuntimeOpencodeConfig(serverConfig, GLOBAL_MCP_ID, withoutMcp(name));
    removed.push("global");
  }
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
  const current = (rowId === workspaceId ? rows.workspace : rows.global)[name];
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  try {
    validateMcpConfig({ ...current, enabled });
  } catch {
    return false;
  }
  await writeRuntimeOpencodeConfig(serverConfig, rowId, (currentConfig) => ({
    ...currentConfig,
    mcp: { ...runtimeMcpMap(currentConfig), [name]: { ...current, enabled } },
  }));
  return true;
}
