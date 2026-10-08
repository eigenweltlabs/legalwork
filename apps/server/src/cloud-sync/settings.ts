import { existsSync } from "node:fs";
import { z } from "zod";
import { openSqliteReadonly } from "../managed-opencode-db.js";
import { runtimeDbPath } from "../runtime-db.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, GLOBAL_PERSONALIZATION_ID, writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { portableConfig, PORTABLE_CONFIG_FIELDS, remapPaths, safeFolderPermissions } from "./state.js";
import { ProjectSchema } from "./schema.js";
import { isConflict, type SyncObjects } from "./objects.js";

const ConfigSchema = z.object({
  default_agent: z.string().optional(), disabled_providers: z.array(z.string()).optional(),
  permission: z.record(z.string(), z.unknown()).optional(),
  agent: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  personalization: z.object({ customInstructions: z.string().max(12000), personality: z.enum(["default", "pragmatic", "professional", "friendly", "candid"]) }).optional(),
}).strict();
const SettingsSchema = z.object({ version: z.literal(1), updatedAt: z.number().int().nonnegative(),
  config: ConfigSchema, projects: z.array(ProjectSchema).max(5000) }).strict();

/** Safe preferences sync independently of the session execution owner.
 * Preserve original edit times when applying remotely to avoid echo loops. */
export async function syncPreferences(config: ServerConfig, store: SyncObjects) {
  const path = runtimeDbPath(config);
  const local = new Map<string, { config: RuntimeOpencodeConfig; updatedAt: number }>();
  if (existsSync(path)) {
    const db = await openSqliteReadonly(path);
    try {
      if (db.all("SELECT name FROM sqlite_master WHERE name = 'runtime_opencode_configs'").length) {
        for (const row of db.all("SELECT workspace_id, config_json, updated_at FROM runtime_opencode_configs")) {
          local.set(String(row.workspace_id), { config: ConfigSchema.parse(portableConfig(JSON.parse(String(row.config_json)))), updatedAt: Number(row.updated_at) });
        }
      }
    } finally { db.close(); }
  }
  const projects = config.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(workspace =>
    ProjectSchema.parse({ id: workspace.id, name: workspace.name, preset: workspace.preset, sourcePath: workspace.path }));
  const roots = new Map(config.workspaces.map(workspace => [workspace.id, workspace.path]));
  const ids = [GLOBAL_TOOL_PERMISSIONS_ID, GLOBAL_PERSONALIZATION_ID, ...projects.map(project => project.id)];
  for (const id of ids) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const object = await store.get(`settings/${id}.json`);
      const remote = object ? SettingsSchema.parse(JSON.parse(object.data.toString())) : null;
      const own = local.get(id);
      if (!remote || own && own.updatedAt > remote.updatedAt) {
        if (!own) break;
        const value = { version: 1, config: own.config, updatedAt: own.updatedAt, projects };
        try { await store.put(`settings/${id}.json`, Buffer.from(JSON.stringify(value)), object?.revision ?? null); break; }
        catch (error) { if (isConflict(error) && attempt < 3) continue; throw error; }
      }
      const mapped = ConfigSchema.parse(safeFolderPermissions(ConfigSchema.parse(remapPaths(remote.config, remote.projects, roots)), [...roots.values()]));
      if (!own || own.updatedAt < remote.updatedAt || JSON.stringify(own.config) !== JSON.stringify(mapped)) {
        await writeRuntimeOpencodeConfig(config, id, current => {
          const credentialFields = Object.fromEntries(Object.entries(current).filter(([key]) => !PORTABLE_CONFIG_FIELDS.has(key)));
          return { ...credentialFields, ...mapped };
        }, remote.updatedAt);
      }
      break;
    }
  }
}
