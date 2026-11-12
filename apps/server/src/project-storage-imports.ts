import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertPluginDestination, pluginNamespace, readInstalledCloudPlugins, resolveWorkspaceInstallPath, writeInstalledCloudPlugins, type CloudImportedPlugin } from "./cloud-plugins.js";
import { connectedMcpServer, relocatedProviderFiles, relocatedSupportReference, relocatedSupportValues } from "./connected-project-config.js";
import { decodeNativeRuntimeConfigRecord } from "./runtime-config-upgrade.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { withFileWriteLock } from "./file-write-lock.js";
import { ApiError } from "./errors.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { localProjectReferenceRoots } from "./project-storage.js";

const journalSchema = z.record(z.string(), z.object({ before: z.string(), after: z.string() }));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function atomicWrite(path: string, bytes: string | Uint8Array, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { mode }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Imported originals and rollback snapshots stay immutable. Only installed
 * bytes matching the importer's ownership hashes may be changed. */
export async function relocateImportedPlugin(workspace: WorkspaceInfo, plugin: CloudImportedPlugin): Promise<CloudImportedPlugin> {
  if (!workspace.previousPath) return plugin;
  workspace = await localProjectReferenceRoots(workspace);
  const journalPath = join(workspace.path, ".legalwork", "project-storage-imports.json");
  await mkdir(dirname(journalPath), { recursive: true });
  return withFileWriteLock(`${journalPath}.lock`, async () => {
    const journal: z.infer<typeof journalSchema> = await readFile(journalPath, "utf8").then(text => journalSchema.parse(JSON.parse(text)), error => { if (error.code === "ENOENT") return {}; throw error; });
    const fileHashes = { ...plugin.fileHashes };
    const visit = async (relative: string): Promise<void> => {
      await assertPluginDestination(workspace.path, relative, false);
      const path = resolveWorkspaceInstallPath(workspace.path, relative);
      const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isSymbolicLink()) throw new ApiError(409, "project_storage_plugin_modified", `The imported plugin ${plugin.name} contains a linked file. Its original files are preserved.`);
      if (info?.isDirectory()) { for (const entry of await readdir(path)) await visit(`${relative}/${entry}`); return; }
      if (!info?.isFile()) return;
      const bytes = await readFile(path), actual = digest(bytes), expected = plugin.fileHashes?.[relative];
      const key = JSON.stringify([plugin.pluginId, relative, expected]);
      if (expected && journal[key]?.before === expected && journal[key].after === actual) { fileHashes[relative] = actual; return; }
      const text = bytes.toString("utf8"), replacement = relocatedSupportReference(workspace, text);
      if (text === replacement) return;
      if (!expected || expected !== actual || !Buffer.from(text, "utf8").equals(bytes)) throw new ApiError(409, "project_storage_plugin_modified", `The imported plugin ${plugin.name} has modified files containing its former project address (${relative}). LegalWork preserved them; resolve those references before retrying the migration.`);
      const next = Buffer.from(replacement, "utf8");
      // Record the exact permitted result before publishing it, so an interrupted
      // file/registry update can be recognized without trusting changed bytes.
      journal[key] = { before: actual, after: digest(next) };
      await atomicWrite(journalPath, JSON.stringify(journal));
      await atomicWrite(path, next, info.mode & 0o777);
      fileHashes[relative] = journal[key].after;
    };
    const namespace = pluginNamespace(plugin.name, plugin.pluginId);
    for (const folder of ["skills", "agents", "commands", "imported-plugins"]) await visit(`.opencode/${folder}/${namespace}`);
    const connectorDefaults = plugin.connectorDefaults ? z.record(z.string(), z.record(z.string(), z.unknown())).parse(relocatedSupportValues(workspace, plugin.connectorDefaults)) : undefined;
    return { ...plugin, ...(plugin.fileHashes ? { fileHashes } : {}), ...(connectorDefaults ? { connectorDefaults } : {}) };
  });
}

export async function relocateProjectImports(config: ServerConfig, workspace: WorkspaceInfo): Promise<void> {
  workspace = await localProjectReferenceRoots(workspace);
  const installed = await readInstalledCloudPlugins(config, workspace.id);
  for (const plugin of Object.values(installed.plugins)) {
    const next = await relocateImportedPlugin(workspace, plugin);
    if (JSON.stringify(next) !== JSON.stringify(plugin)) await writeInstalledCloudPlugins(config, workspace.id, current => ({ ...current, plugins: { ...current.plugins, [plugin.pluginId]: next } }));
  }
  await writeRuntimeOpencodeConfig(config, workspace.id, current => {
    const next = { ...current,
      ...(current.mcp ? { mcp: { ...current.mcp, servers: Object.fromEntries(Object.entries(current.mcp.servers ?? {}).map(([name, server]) => [name, server.type === "local" ? { ...server, ...connectedMcpServer(workspace, server, false) } : relocatedSupportValues(workspace, server)])) } } : {}),
      ...(current.instructions ? { instructions: current.instructions.map(path => relocatedSupportReference(workspace, path)) } : {}),
      ...(current.plugins ? { plugins: relocatedSupportValues(workspace, current.plugins) } : {}),
      ...(current.providers ? { providers: relocatedProviderFiles(workspace, current.providers) } : {}),
    };
    return { ...current, ...decodeNativeRuntimeConfigRecord(next).configuration };
  });
}
