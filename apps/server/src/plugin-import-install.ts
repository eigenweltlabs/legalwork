import { ApiError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { nativeMcpDefinition } from "./native-mcp-config.js";
import { upgradeRuntimeConfigRecord } from "./runtime-config-upgrade.js";
import { assertPluginDestination, installCloudPlugin, pluginNamespace, readInstalledCloudPlugins, resolveWorkspaceInstallPath, writeInstalledCloudPlugins, readStoredPlugin, type CloudImportedPlugin } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import type { PluginImportPlan } from "./plugin-imports.js";
import type { PluginImportHistory } from "@legalwork/types/plugin-import";

function pluginLocations(plugin: Pick<CloudImportedPlugin, "name" | "pluginId">) {
  const namespace = pluginNamespace(plugin.name, plugin.pluginId);
  return ["skills", "agents", "commands", "imported-plugins"].map(folder => `.opencode/${folder}/${namespace}`);
}
async function hashes(root: string, locations: string[], global: boolean) {
  const values: Record<string, string> = {};
  const visit = async (relative: string) => {
    await assertPluginDestination(root, relative, global);
    const path = resolveWorkspaceInstallPath(root, relative, global);
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) throw new ApiError(409, "plugin_locally_changed", "This plugin contains a linked file. Keep a copy of your changes before updating.");
    if (info?.isDirectory()) for (const entry of await readdir(path)) await visit(`${relative}/${entry}`);
    else if (info?.isFile()) values[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
  };
  for (const location of locations) await visit(location);
  return values;
}
export async function assertPluginUnmodified(root: string, plugin: CloudImportedPlugin, global: boolean) {
  const actual = await hashes(root, pluginLocations(plugin), global);
  if (!plugin.fileHashes) return;
  const names = new Set([...Object.keys(actual), ...Object.keys(plugin.fileHashes)]);
  if ([...names].some(name => actual[name] !== plugin.fileHashes?.[name])) throw new ApiError(409, "plugin_locally_changed", "This plugin has local changes. Export or copy those changes before updating or rolling back; LegalWork will not overwrite them.");
}

/** Replace complete package directories and restore files/config on failure. */
export async function installPluginImport(config: ServerConfig, workspaceId: string, workspaceRoot: string, plan: PluginImportPlan, global: boolean) {
  const registry = global ? GLOBAL_MCP_ID : workspaceId;
  const unmet = plan.preview.requirements?.filter(item => item.required && item.status === "blocked");
  if (unmet?.length) throw new ApiError(400, "plugin_requirements_unmet", unmet.map(item => item.message).join(" "));
  const namespace = pluginNamespace(plan.resolved.plugin.name, plan.resolved.plugin.id);
  const locations = ["skills", "agents", "commands", "imported-plugins"].map(folder => `.opencode/${folder}/${namespace}`);
  for (const location of locations) await assertPluginDestination(workspaceRoot, location, global);
  const imports = await readInstalledCloudPlugins(config, registry);
  const previous = imports.plugins[plan.resolved.plugin.id];
  if (previous) await assertPluginUnmodified(workspaceRoot, previous, global);
  const previousMcp = (await readRuntimeOpencodeConfig(config, registry)).mcp?.servers ?? {};
  const snapshot = `.opencode/.legalwork-import-backups/${randomUUID()}`;
  await assertPluginDestination(workspaceRoot, snapshot, global);
  const backups: Array<{ path: string; backup: string | null; relative: string }> = [];
  try {
    for (const location of locations) {
      const path = resolveWorkspaceInstallPath(workspaceRoot, location, global);
      await mkdir(dirname(path), { recursive: true });
      const info = await lstat(path).catch(() => null);
      if (info && !previous && (!info.isDirectory() || (await readdir(path)).length > 0)) throw new ApiError(409, "plugin_destination_exists", "The plugin destination already contains files that LegalWork does not own. Move them before importing.");
      const backup = info ? resolveWorkspaceInstallPath(workspaceRoot, `${snapshot}/${backups.length}`, global) : null;
      if (backup) { await mkdir(dirname(backup), { recursive: true }); await cp(path, backup, { recursive: true }); }
      backups.push({ path, backup, relative: location });
      if (info) await rm(path, { recursive: true, force: true });
    }
    const installed = await installCloudPlugin({ serverConfig: config, workspaceId: registry, workspaceRoot, marketplaceId: null, resolved: plan.resolved, global, resourceFiles: plan.resourceFiles, preserveSkillMetadata: true, preserveConnectorSetup: true });
    for (const path of plan.dataPaths || []) { await assertPluginDestination(workspaceRoot, path, global); await mkdir(resolveWorkspaceInstallPath(workspaceRoot, path, global), { recursive: true }); }
    installed.fileHashes = await hashes(workspaceRoot, locations, global);
    installed.history = [...(previous?.history || []), { at: Date.now(), action: previous ? "updated" : "installed", digest: plan.preview.digest, version: plan.preview.version, revision: plan.preview.provenance?.revision } satisfies PluginImportHistory].slice(-50);
    installed.snapshots = [...(previous?.snapshots || []), ...(previous ? [snapshot] : [])].slice(-3);
    if (previous) {
      await mkdir(resolveWorkspaceInstallPath(workspaceRoot, snapshot, global), { recursive: true });
      await writeFile(resolveWorkspaceInstallPath(workspaceRoot, `${snapshot}/snapshot.json`, global), JSON.stringify({ configurationVersion: 2, plugin: previous, locations: backups.map((item, index) => ({ location: item.relative, backup: item.backup ? `${snapshot}/${index}` : null })), mcp: Object.fromEntries(Object.entries(previousMcp).filter(([name]) => name.startsWith(`${namespace}-`))) }), { mode: 0o600 });
    }
    await writeInstalledCloudPlugins(config, registry, current => ({ ...current, plugins: { ...current.plugins, [installed.pluginId]: installed } }));
    for (const old of previous?.snapshots || []) if (/^\.opencode\/\.legalwork-import-backups\/[a-f0-9-]+$/.test(old) && !installed.snapshots.includes(old)) await rm(resolveWorkspaceInstallPath(workspaceRoot, old, global), { recursive: true, force: true }).catch(() => undefined);
    if (!previous) await rm(resolveWorkspaceInstallPath(workspaceRoot, snapshot, global), { recursive: true, force: true });
    return installed;
  } catch (error) {
    for (const entry of backups) {
      await rm(entry.path, { recursive: true, force: true });
      if (entry.backup) await cp(entry.backup, entry.path, { recursive: true });
    }
    // Restore only this package's connectors; other connector changes survive.
    await writeRuntimeOpencodeConfig(config, registry, current => ({ ...current, mcp: { ...current.mcp, servers: {
      ...Object.fromEntries(Object.entries(current.mcp?.servers ?? {}).filter(([name]) => !name.startsWith(`${namespace}-`))),
      ...Object.fromEntries(Object.entries(previousMcp).filter(([name]) => name.startsWith(`${namespace}-`))),
    } } }));
    await writeInstalledCloudPlugins(config, registry, current => {
      const plugins = { ...current.plugins };
      if (previous) plugins[plan.resolved.plugin.id] = previous;
      else delete plugins[plan.resolved.plugin.id];
      return { ...current, plugins };
    });
    await rm(resolveWorkspaceInstallPath(workspaceRoot, snapshot, global), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const snapshotSchema = z.object({ configurationVersion: z.literal(2).optional(), plugin: z.unknown(), locations: z.array(z.object({ location: z.string(), backup: z.string().nullable() })), mcp: z.record(z.string(), z.record(z.string(), z.unknown())) });
export async function rollbackPluginImport(config: ServerConfig, workspaceId: string, root: string, pluginId: string, global: boolean) {
  const registry = global ? GLOBAL_MCP_ID : workspaceId;
  const installed = (await readInstalledCloudPlugins(config, registry)).plugins[pluginId];
  const snapshot = installed?.snapshots?.at(-1);
  if (!installed || !snapshot || !/^\.opencode\/\.legalwork-import-backups\/[a-f0-9-]+$/.test(snapshot)) throw new ApiError(404, "plugin_snapshot_missing", "No previous installed version is available.");
  await assertPluginUnmodified(root, installed, global);
  await assertPluginDestination(root, `${snapshot}/snapshot.json`, global);
  const value = snapshotSchema.parse(JSON.parse(await readFile(resolveWorkspaceInstallPath(root, `${snapshot}/snapshot.json`, global), "utf8")));
  const snapshotMcp = value.configurationVersion === 2 ? Object.fromEntries(Object.entries(value.mcp).map(([name, definition]) => [name, nativeMcpDefinition(definition)])) : upgradeRuntimeConfigRecord({ mcp: value.mcp }).configuration.mcp?.servers ?? {};
  const previous = readStoredPlugin(value.plugin);
  if (!previous || previous.pluginId !== pluginId) throw new ApiError(400, "plugin_snapshot_invalid", "This backup does not belong to the selected plugin.");
  const allowed = new Set(pluginLocations(installed));
  for (const item of value.locations) {
    if (!allowed.has(item.location) || item.backup && !item.backup.startsWith(`${snapshot}/`)) throw new ApiError(400, "plugin_snapshot_invalid", "Invalid plugin backup location.");
    await assertPluginDestination(root, item.location, global);
    if (item.backup) await assertPluginDestination(root, item.backup, global);
  }
  if (value.locations.length !== allowed.size || new Set(value.locations.map(item => item.location)).size !== allowed.size) throw new ApiError(400, "plugin_snapshot_invalid", "Incomplete plugin backup.");
  // Stage every recovery copy before touching any installed directory.
  const recovery = `${snapshot}/recovery`;
  const currentMcp = (await readRuntimeOpencodeConfig(config, registry)).mcp?.servers ?? {};
  const namespace = pluginNamespace(installed.name, pluginId);
  const originals: boolean[] = [];
  for (let index = 0; index < value.locations.length; index++) {
    const path = resolveWorkspaceInstallPath(root, value.locations[index].location, global);
    originals[index] = Boolean(await lstat(path).catch(() => null));
    if (originals[index]) { await mkdir(resolveWorkspaceInstallPath(root, recovery, global), { recursive: true }); await cp(path, resolveWorkspaceInstallPath(root, `${recovery}/${index}`, global), { recursive: true }); }
  }
  try {
    for (const item of value.locations) {
      const path = resolveWorkspaceInstallPath(root, item.location, global);
      await rm(path, { recursive: true, force: true });
      if (item.backup) await cp(resolveWorkspaceInstallPath(root, item.backup, global), path, { recursive: true });
    }
    await writeRuntimeOpencodeConfig(config, registry, current => ({ ...current, mcp: { ...current.mcp, servers: { ...Object.fromEntries(Object.entries(current.mcp?.servers ?? {}).filter(([name]) => !name.startsWith(`${namespace}-`))), ...snapshotMcp } } }));
    previous.history = [...(installed.history || []), { at: Date.now(), action: "rolled_back", digest: previous.provenance?.digest || "", version: previous.provenance?.version || null, revision: previous.provenance?.revision } satisfies PluginImportHistory].slice(-50);
    previous.snapshots = installed.snapshots?.slice(0, -1);
    await writeInstalledCloudPlugins(config, registry, current => ({ ...current, plugins: { ...current.plugins, [pluginId]: previous } }));
  } catch (error) {
    for (let index = 0; index < value.locations.length; index++) {
      const path = resolveWorkspaceInstallPath(root, value.locations[index].location, global);
      const backup = resolveWorkspaceInstallPath(root, `${recovery}/${index}`, global);
      await rm(path, { recursive: true, force: true });
      if (originals[index]) await cp(backup, path, { recursive: true });
    }
    await writeRuntimeOpencodeConfig(config, registry, current => ({ ...current, mcp: { ...current.mcp, servers: { ...Object.fromEntries(Object.entries(current.mcp?.servers ?? {}).filter(([name]) => !name.startsWith(`${namespace}-`))), ...Object.fromEntries(Object.entries(currentMcp).filter(([name]) => name.startsWith(`${namespace}-`))) } } }));
    throw error;
  }
  await rm(resolveWorkspaceInstallPath(root, snapshot, global), { recursive: true, force: true });
  return previous;
}
