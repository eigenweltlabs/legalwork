import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import type { PluginItem, ServerConfig } from "./types.js";
import { readJsoncFile } from "./jsonc.js";
import { globalOpencodeConfigDir, opencodeConfigPath, projectPluginsDir } from "./workspace-files.js";
import { exists } from "./utils.js";
import { validatePluginSpec } from "./validators.js";
import { readRuntimeOpencodeConfig, runtimePluginList, writeRuntimeOpencodeConfig, type RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

export function normalizePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("file:") || trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("git:")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function pluginListFromConfig(config: Record<string, unknown>): string[] {
  const plugin = config.plugins;
  if (Array.isArray(plugin)) return plugin.flatMap(item => typeof item === "string" ? [item] : item && typeof item === "object" && typeof Reflect.get(item, "package") === "string" ? [String(Reflect.get(item, "package"))] : []);
  return [];
}

function pluginSpec(plugin: NonNullable<RuntimeOpencodeConfig["plugins"]>[number]) { return typeof plugin === "string" ? plugin : plugin.package; }

async function listPluginFiles(dir: string, scope: "project" | "global", workspaceRoot?: string): Promise<PluginItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: PluginItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = workspaceRoot ? relative(workspaceRoot, absolutePath) : absolutePath;
    items.push({
      // pathToFileURL yields a well-formed file:// URL on every platform
      // (`file:///C:/…` on Windows); a bare `file://${absolutePath}` would
      // produce the malformed `file://C:\…` that OpenCode's import() rejects.
      spec: pathToFileURL(absolutePath).href,
      source: scope === "project" ? "dir.project" : "dir.global",
      scope,
      path: relativePath,
    });
  }
  return items;
}

export async function listPlugins(serverConfig: ServerConfig, workspaceId: string, workspaceRoot: string, includeGlobal: boolean): Promise<{ items: PluginItem[]; loadOrder: string[] }> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const pluginSpecs = pluginListFromConfig(config);
  const runtimeSpecs = runtimePluginList(await readRuntimeOpencodeConfig(serverConfig, workspaceId));
  const items: PluginItem[] = pluginSpecs.map((spec) => ({
    spec,
    source: "config",
    scope: "project",
  }));

  const seen = new Set(pluginSpecs.map((spec) => normalizePluginSpec(spec)));
  for (const plugin of runtimeSpecs) {
    const spec = pluginSpec(plugin);
    const normalized = normalizePluginSpec(spec);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({
      spec,
      source: "config",
      scope: "project",
    });
  }

  const projectDir = projectPluginsDir(workspaceRoot);
  items.push(...(await listPluginFiles(projectDir, "project", workspaceRoot)));

  if (includeGlobal) {
    const globalDir = join(globalOpencodeConfigDir(), "plugins");
    items.push(...(await listPluginFiles(globalDir, "global")));
  }

  return {
    items,
    loadOrder: ["config.global", "config.project", "dir.global", "dir.project"],
  };
}

export async function addPlugin(serverConfig: ServerConfig, workspaceId: string, spec: string): Promise<boolean> {
  validatePluginSpec(spec);
  const normalized = normalizePluginSpec(spec);
  let added = false;
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, current => {
    const plugins = runtimePluginList(current);
    if (plugins.some(item => normalizePluginSpec(pluginSpec(item)) === normalized)) return current;
    added = true;
    return { ...current, plugins: [...plugins, spec] };
  });
  return added;
}

export async function removePlugin(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const normalized = normalizePluginSpec(name);
  let removed = false;
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, current => {
    const plugins = runtimePluginList(current), filtered = plugins.filter(item => normalizePluginSpec(pluginSpec(item)) !== normalized);
    removed = filtered.length !== plugins.length;
    return removed ? { ...current, plugins: filtered } : current;
  });
  return removed;
}
