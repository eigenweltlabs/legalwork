import { ApiError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertPluginDestination, installCloudPlugin, pluginNamespace, readInstalledCloudPlugins, resolveWorkspaceInstallPath, writeInstalledCloudPlugins } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import type { PluginImportPlan } from "./plugin-imports.js";

/** Replace complete package directories and restore files/config on failure. */
export async function installPluginImport(config: ServerConfig, workspaceId: string, workspaceRoot: string, plan: PluginImportPlan, global: boolean) {
  const registry = global ? GLOBAL_MCP_ID : workspaceId;
  const namespace = pluginNamespace(plan.resolved.plugin.name, plan.resolved.plugin.id);
  const locations = ["skills", "agents", "commands", "imported-plugins"].map(folder => `.opencode/${folder}/${namespace}`);
  for (const location of locations) await assertPluginDestination(workspaceRoot, location, global);
  const imports = await readInstalledCloudPlugins(config, registry);
  const previous = imports.plugins[plan.resolved.plugin.id];
  const previousMcp = (await readRuntimeOpencodeConfig(config, registry)).mcp ?? {};
  const backups: Array<{ path: string; backup: string | null }> = [];
  try {
    for (const location of locations) {
      const path = resolveWorkspaceInstallPath(workspaceRoot, location, global);
      await mkdir(dirname(path), { recursive: true });
      const info = await lstat(path).catch(() => null);
      if (info && !previous && (!info.isDirectory() || (await readdir(path)).length > 0)) throw new ApiError(409, "plugin_destination_exists", "The plugin destination already contains files that LegalWork does not own. Move them before importing.");
      const backupRoot = `.opencode/.legalwork-import-backups/${randomUUID()}`;
      await assertPluginDestination(workspaceRoot, backupRoot, global);
      const backup = info ? join(dirname(dirname(path)), ".legalwork-import-backups", basename(backupRoot)) : null;
      if (backup) { await mkdir(dirname(backup), { recursive: true }); await rename(path, backup); }
      backups.push({ path, backup });
    }
    const installed = await installCloudPlugin({ serverConfig: config, workspaceId: registry, workspaceRoot, marketplaceId: null, resolved: plan.resolved, global, resourceFiles: plan.resourceFiles, preserveSkillMetadata: true });
    for (const entry of backups) if (entry.backup) await rm(entry.backup, { recursive: true, force: true }).catch(() => undefined);
    return installed;
  } catch (error) {
    for (const entry of backups) {
      await rm(entry.path, { recursive: true, force: true });
      if (entry.backup) await rename(entry.backup, entry.path);
    }
    // Restore only this package's connectors; other connector changes survive.
    await writeRuntimeOpencodeConfig(config, registry, current => ({ ...current, mcp: {
      ...Object.fromEntries(Object.entries(current.mcp ?? {}).filter(([name]) => !name.startsWith(`${namespace}-`))),
      ...Object.fromEntries(Object.entries(previousMcp).filter(([name]) => name.startsWith(`${namespace}-`))),
    } }));
    await writeInstalledCloudPlugins(config, registry, current => {
      const plugins = { ...current.plugins };
      if (previous) plugins[plan.resolved.plugin.id] = previous;
      else delete plugins[plan.resolved.plugin.id];
      return { ...current, plugins };
    });
    throw error;
  }
}
