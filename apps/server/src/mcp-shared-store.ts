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
import { isDeepStrictEqual } from "node:util";
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
  // The current runtime file contains ephemeral local gateway capabilities,
  // not provider configuration. Never import it as a new upstream connector.
  if (entry.type === "remote" && typeof entry.url === "string") {
    try {
      const url = new URL(entry.url);
      if (["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.startsWith("/mcp/gateway/")) return false;
    } catch { /* The ordinary config validator reports malformed URLs. */ }
  }
  try {
    validateMcpName(name);
    validateMcpConfig(entry);
    return true;
  } catch {
    return false;
  }
}

/** Only retire LegalWork's bundled helper, not a custom MCP with the same name. */
function retiredComputerUse(name: string, entry: Record<string, unknown>): boolean {
  if (name !== "computer-use" || !Array.isArray(entry.command)) return false;
  return entry.command.some((part) => typeof part === "string" && (
    part === "@legalwork/handsfree" ||
    /(?:^|\/)packages\/handsfree\/bin\/legalwork-handsfree-computer-use\.mjs$/.test(part.replaceAll("\\", "/")) ||
    /(?:^|\/)LegalWork Computer Use\.app\/Contents\/MacOS\/ComputerUse$/.test(part.replaceAll("\\", "/")) ||
    /(?:^|\/)HandsFreeComputerUse$/.test(part.replaceAll("\\", "/"))
  ));
}

export async function importConnectorsIntoSharedRow(
  config: ServerConfig,
  sources: ConnectorImportSources,
): Promise<{ imported: string[] }> {
  if (config.readOnly) return { imported: [] };
  const shared: McpMap = { ...(await readGlobalMcpMap(config)) };
  const retiredShared = shared["computer-use"] && retiredComputerUse("computer-use", shared["computer-use"]);
  if (retiredShared) delete shared["computer-use"];
  const imported: string[] = [];
  const sourceEntries: Array<{ path: string; name: string }> = [];
  const workspaceEntries: Array<{ id: string; pluginOwned: Set<string>; overrides: Set<string> }> = [];
  const take = (name: string, entry: Record<string, unknown>) => {
    if (retiredComputerUse(name, entry) || Object.prototype.hasOwnProperty.call(shared, name) || !usable(name, entry)) return;
    shared[name] = entry;
    imported.push(name);
  };

  // Workspace rows first: they hold what the last connect wrote.
  for (const workspace of config.workspaces) {
    if (workspace.workspaceType === "remote") continue;
    const row = runtimeMcpMap(await readRuntimeOpencodeConfig(config, workspace.id));
    if (Object.keys(row).length === 0) continue;
    const pluginOwned = await installedCloudPluginMcpNames(config, workspace.id);
    const moving = Object.entries(row).filter(([name, entry]) => !entry.managedConnectionId && (!pluginOwned.has(name) || retiredComputerUse(name, entry)));
    if (moving.length === 0) continue;
    for (const [name, entry] of moving) take(name, entry);
    // Distinct existing workspace accounts are not stale copies of a shared
    // connection. Preserve those settings for the manager to own independently.
    // A managed shared descriptor hides its original settings. After an
    // interrupted reconciliation, a raw workspace row cannot be proven equal.
    const overrides = new Set(moving.filter(([name, entry]) => !retiredComputerUse(name, entry) && usable(name, entry) && shared[name] && !isDeepStrictEqual(shared[name], entry)).map(([name]) => name));
    workspaceEntries.push({ id: workspace.id, pluginOwned, overrides });
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

  if (imported.length > 0 || retiredShared) {
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, (current) => ({ ...current, mcp: shared }));
  }
  // Commit the destination first. An interrupted import must leave the original
  // workspace settings available for the next startup to retry.
  for (const { id, pluginOwned, overrides } of workspaceEntries) {
    await writeRuntimeOpencodeConfig(config, id, (current) => {
      const next = { ...current };
      const kept = Object.fromEntries(Object.entries(runtimeMcpMap(current)).filter(([name, entry]) => Boolean(entry.managedConnectionId) || overrides.has(name) || (pluginOwned.has(name) && !retiredComputerUse(name, entry))));
      if (Object.keys(kept).length) next.mcp = kept;
      else delete next.mcp;
      return next;
    });
  }
  for (const { path, name } of sourceEntries) {
    await updateJsoncPath(path, ["mcp", name], undefined);
  }
  return { imported };
}
