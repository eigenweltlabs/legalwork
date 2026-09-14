/**
 * Import of already-connected apps into the shared connector row.
 *
 * Desktop connectors are global: one list, every workspace. Builds before this
 * one spread a connected server over three places with different scopes and
 * readers — the runtime-DB row of whichever workspace was open, the runtime
 * config file the desktop merged into directly (rebuilt from the DB on every
 * write, so the merge was dropped), and the user's global opencode config
 * (read by the engine once per process). The app listed such a connector in
 * every workspace while the engine only had it in some.
 *
 * Every start folds those sources and legacy project files into the shared
 * row (GLOBAL_MCP_ID), which the engine config file and hot-add sync use, so every workspace
 * instance gets the same connectors from one place. Workspace rows are
 * LegalWork's own and are emptied — moved, not copied: a stale copy would
 * shadow the shared entry. The one exception is an MCP a plugin installed in
 * that workspace brought along: it belongs to the workspace like the plugin
 * does and stays. Imported entries are removed from their source files only
 * after the shared row is saved. Leaving a second source lets it override the
 * shared entry or resurrect a disconnected connector on an engine rebuild.
 * Other configuration and comments stay intact.
 */
import { dirname, join } from "node:path";
import { installedCloudPluginMcpNames } from "./cloud-plugins.js";
import { readJsoncFile, updateJsoncPath } from "./jsonc.js";
import { opencodeConfigPaths } from "./workspace-files.js";
import {
  GLOBAL_MCP_ID,
  readGlobalMcpMap,
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";

export type ConnectorImportSources = {
  /** The engine config file earlier desktop builds merged connectors into directly. */
  runtimeConfigFile: string;
  /** The user's global opencode config, which earlier desktop builds wrote connectors into. */
  globalOpencodeConfigFile: string;
};

type McpMap = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpMapOf(value: unknown): McpMap {
  if (!isRecord(value) || !isRecord(value.mcp)) return {};
  const map: McpMap = {};
  for (const [name, entry] of Object.entries(value.mcp)) {
    if (isRecord(entry)) map[name] = entry;
  }
  return map;
}

/** An entry the engine would refuse must not poison the shared row. */
function usable(name: string, entry: Record<string, unknown>): boolean {
  try {
    validateMcpName(name);
    validateMcpConfig(entry);
    return true;
  } catch {
    return false;
  }
}

export async function importConnectorsIntoSharedRow(
  config: ServerConfig,
  sources: ConnectorImportSources,
): Promise<{ imported: string[] }> {
  if (config.readOnly) return { imported: [] };
  const shared: McpMap = { ...(await readGlobalMcpMap(config)) };
  const imported: string[] = [];
  const sourceEntries: Array<{ path: string; name: string }> = [];
  const take = (name: string, entry: Record<string, unknown>) => {
    if (Object.prototype.hasOwnProperty.call(shared, name) || !usable(name, entry)) return;
    shared[name] = entry;
    imported.push(name);
  };

  // Workspace rows first: they hold what the last connect wrote.
  for (const workspace of config.workspaces) {
    if (workspace.workspaceType === "remote") continue;
    const row = runtimeMcpMap(await readRuntimeOpencodeConfig(config, workspace.id));
    if (Object.keys(row).length === 0) continue;
    const pluginOwned = await installedCloudPluginMcpNames(config, workspace.id);
    const moving = Object.entries(row).filter(([name]) => !pluginOwned.has(name));
    if (moving.length === 0) continue;
    for (const [name, entry] of moving) take(name, entry);
    await writeRuntimeOpencodeConfig(config, workspace.id, (current) => {
      const next = { ...current };
      const kept = Object.fromEntries(Object.entries(runtimeMcpMap(current)).filter(([name]) => pluginOwned.has(name)));
      if (Object.keys(kept).length) next.mcp = kept;
      else delete next.mcp;
      return next;
    });
  }

  const globalDirectory = dirname(sources.globalOpencodeConfigFile);
  const files = new Set([
    sources.runtimeConfigFile,
    sources.globalOpencodeConfigFile,
    join(globalDirectory, "opencode.jsonc"),
    join(globalDirectory, "opencode.json"),
    ...config.workspaces.filter((workspace) => workspace.workspaceType !== "remote")
      .flatMap((workspace) => opencodeConfigPaths(workspace.path)),
  ]);
  for (const path of files) {
    const { data } = await readJsoncFile<Record<string, unknown>>(path, {}, { allowInvalid: true });
    for (const [name, entry] of Object.entries(mcpMapOf(data))) {
      if (!usable(name, entry)) continue;
      take(name, entry);
      if (path !== sources.runtimeConfigFile) sourceEntries.push({ path, name });
    }
  }

  if (imported.length > 0) {
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, (current) => ({ ...current, mcp: shared }));
  }
  for (const { path, name } of sourceEntries) {
    await updateJsoncPath(path, ["mcp", name], undefined);
  }
  return { imported };
}
