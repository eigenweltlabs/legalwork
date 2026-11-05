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
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";
import { nativeMcpDefinition, type NativeMcpDefinition } from "./native-mcp-config.js";
import { upgradeRuntimeConfigRecord } from "./runtime-config-upgrade.js";
import { backupRuntimeConfigSource } from "./runtime-config-source-backup.js";

export type ConnectorImportSources = {
  /** The engine config file earlier desktop builds merged connectors into directly. */
  runtimeConfigFile: string;
  /** The user's global opencode config, which earlier desktop builds wrote connectors into. */
  globalOpencodeConfigFile: string;
};

type McpMap = Record<string, NativeMcpDefinition>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Source-file import boundary only; runtime rows already contain native settings. */
function mcpMapOf(value: unknown): { map: McpMap; native: boolean } {
  if (!isRecord(value) || !isRecord(value.mcp)) return { map: {}, native: false };
  const native = isRecord(value.mcp.servers) && !["local", "remote"].includes(String(value.mcp.servers.type));
  // Native authored documents and our generated projection are already owned
  // by their native loader. Only old LegalWork connector maps are imported.
  if (native) return { map: {}, native };
  const source = value.mcp;
  const map: McpMap = {};
  for (const [name, entry] of Object.entries(source)) {
    if (!isRecord(entry)) continue;
    try {
      const definition = upgradeRuntimeConfigRecord({ mcp: { [name]: entry } }).configuration.mcp?.servers?.[name];
      if (definition) map[name] = definition;
    } catch { /* The unimported source remains available for repair. */ }
  }
  return { map, native };
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
  const shared: McpMap = Object.fromEntries(Object.entries(await readGlobalMcpMap(config)).map(([name, entry]) => [name, nativeMcpDefinition(entry)]));
  const retiredShared = shared["computer-use"] && retiredComputerUse("computer-use", shared["computer-use"]);
  if (retiredShared) delete shared["computer-use"];
  const imported: string[] = [];
  const sourceEntries: Array<{ path: string; name: string; native: boolean }> = [];
  const workspaceMoves: Array<{ id: string; entries: McpMap }> = [];
  const take = (name: string, entry: NativeMcpDefinition) => {
    if (retiredComputerUse(name, entry) || Object.prototype.hasOwnProperty.call(shared, name) || !usable(name, entry)) return;
    shared[name] = entry;
    imported.push(name);
  };

  // Workspace rows first: they hold what the last connect wrote.
  for (const workspace of config.workspaces) {
    const row = (await readRuntimeOpencodeConfig(config, workspace.id)).mcp?.servers ?? {};
    if (Object.keys(row).length === 0) continue;
    const pluginOwned = await installedCloudPluginMcpNames(config, workspace.id);
    const moving = Object.entries(row).filter(([name, entry]) => !pluginOwned.has(name) || retiredComputerUse(name, entry));
    if (moving.length === 0) continue;
    for (const [name, entry] of moving) take(name, entry);
    workspaceMoves.push({ id: workspace.id, entries: Object.fromEntries(moving.map(([name, entry]) => [name, nativeMcpDefinition(entry)])) });
  }

  const globalDirectory = dirname(sources.globalOpencodeConfigFile);
  const files = new Set([
    sources.runtimeConfigFile,
    sources.globalOpencodeConfigFile,
    join(globalDirectory, "opencode.jsonc"),
    join(globalDirectory, "opencode.json"),
    ...config.workspaces
      .flatMap((workspace) => opencodeConfigPaths(workspace.path)),
  ]);
  for (const path of files) {
    const { data } = await readJsoncFile<Record<string, unknown>>(path, {}, { allowInvalid: true });
    const source = mcpMapOf(data);
    for (const [name, entry] of Object.entries(source.map)) {
      if (!usable(name, entry)) continue;
      take(name, entry);
      if (path !== sources.runtimeConfigFile) sourceEntries.push({ path, name, native: source.native });
    }
  }

  if (imported.length > 0 || retiredShared) {
    await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => ({ ...current, mcp: { ...current.mcp, servers: { ...shared, ...Object.fromEntries(Object.entries(current.mcp?.servers ?? {}).filter(([name, entry]) => !retiredComputerUse(name, entry))) } } }));
  }
  // Publish the destination before retiring a source. A crash can leave a
  // duplicate for the next import, but cannot remove the only saved definition.
  for (const moving of workspaceMoves) await writeRuntimeOpencodeConfig(config, moving.id, current => ({ ...current,
    mcp: { ...current.mcp, servers: Object.fromEntries(Object.entries(current.mcp?.servers ?? {}).filter(([name, entry]) => !Object.hasOwn(moving.entries, name) || JSON.stringify(entry) !== JSON.stringify(moving.entries[name]))) },
  }));
  for (const { path, name, native } of sourceEntries) {
    await backupRuntimeConfigSource(config, GLOBAL_MCP_ID, path);
    await updateJsoncPath(path, native ? ["mcp", "servers", name] : ["mcp", name], undefined);
  }
  return { imported };
}
