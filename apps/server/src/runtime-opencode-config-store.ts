import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type RuntimeOpencodeConfig = {
  default_agent?: string;
  plugin?: string[];
  disabled_providers?: string[];
  mcp?: Record<string, Record<string, unknown>>;
  permission?: {
    external_directory?: Record<string, unknown>;
    [key: string]: unknown;
  };
  provider?: Record<string, unknown>;
  agent?: Record<string, Record<string, unknown>>;
};

const runtimeOpencodeConfigs = sqliteTable("runtime_opencode_configs", {
  workspaceId: text("workspace_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type RuntimeOpencodeDb = {
  get: (workspaceId: string) => { configJson: string } | undefined;
  upsert: (value: { workspaceId: string; configJson: string; updatedAt: number }) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordRecordMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) entries[key] = item;
  }
  return Object.keys(entries).length ? entries : undefined;
}

function normalizeRuntimeOpencodeConfig(value: unknown): RuntimeOpencodeConfig {
  if (!isRecord(value)) return {};
  const defaultAgent = typeof value.default_agent === "string" ? value.default_agent : undefined;
  const plugin = Array.isArray(value.plugin) ? value.plugin.filter((item) => typeof item === "string") : undefined;
  const disabledProviders = Array.isArray(value.disabled_providers)
    ? value.disabled_providers.filter((item) => typeof item === "string")
    : undefined;
  const mcp = isRecord(value.mcp) ? value.mcp as Record<string, Record<string, unknown>> : undefined;
  const permission = isRecord(value.permission) && Object.keys(value.permission).length ? value.permission : undefined;
  const provider = isRecord(value.provider) ? value.provider : undefined;
  const agent = recordRecordMap(value.agent);
  return {
    ...(defaultAgent ? { default_agent: defaultAgent } : {}),
    ...(plugin ? { plugin } : {}),
    ...(disabledProviders ? { disabled_providers: disabledProviders } : {}),
    ...(mcp ? { mcp } : {}),
    ...(permission ? { permission } : {}),
    ...(provider ? { provider } : {}),
    ...(agent ? { agent } : {}),
  };
}

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.LEGALWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "runtime.sqlite");
}

/** Directory holding runtime state (the SQLite DB and derived files). */
export function runtimeStorageDir(config: ServerConfig): string {
  return dirname(runtimeDbPath(config));
}

export type RuntimeOpencodeConfigWriteListener = (config: ServerConfig, workspaceId: string) => void;

const writeListeners = new Set<RuntimeOpencodeConfigWriteListener>();

/**
 * Observe runtime config writes. Used to keep derived state (e.g. the
 * engine-visible runtime config file) in sync with the DB. Returns an
 * unsubscribe function. Listeners must not throw.
 */
export function onRuntimeOpencodeConfigWrite(listener: RuntimeOpencodeConfigWriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

async function openRuntimeDb(path: string): Promise<RuntimeOpencodeDb> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    sqlite.run("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) => db
        .select()
        .from(runtimeOpencodeConfigs)
        .where(eq(runtimeOpencodeConfigs.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, configJson, updatedAt }) => {
        db
          .insert(runtimeOpencodeConfigs)
          .values({ workspaceId, configJson, updatedAt })
          .onConflictDoUpdate({
            target: runtimeOpencodeConfigs.workspaceId,
            set: { configJson, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT config_json AS configJson FROM runtime_opencode_configs WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.configJson !== "string") return undefined;
      return { configJson: row.configJson };
    },
    upsert: ({ workspaceId, configJson, updatedAt }) => {
      upsert.run(workspaceId, configJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<RuntimeOpencodeDb>>();

async function runtimeDb(config: ServerConfig): Promise<RuntimeOpencodeDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openRuntimeDb(path);
  dbByPath.set(path, db);
  return db;
}

/**
 * Tool permissions are GLOBAL — one safety posture for every workspace this
 * server hosts. They live under a reserved runtime-DB row instead of per
 * workspace; only `permission.external_directory` (Authorized Folders) stays
 * workspace-scoped. The id can never collide with real workspaces (those are
 * `ws_<hash>`).
 */
export const GLOBAL_TOOL_PERMISSIONS_ID = "__global_tool_permissions__";

/** Read the global tool-permission map (never contains external_directory). */
export async function readGlobalToolPermissions(config: ServerConfig): Promise<Record<string, unknown>> {
  const globalConfig = await readRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID);
  const permission = isRecord(globalConfig.permission) ? { ...globalConfig.permission } : {};
  delete permission.external_directory;
  return permission;
}

/**
 * Effective permission map for a workspace: the global tool permissions plus
 * the workspace's own external_directory. Tool keys in the workspace row are
 * ignored (legacy rows from when permissions were workspace-scoped).
 */
export function applyGlobalToolPermissions(
  runtimeConfig: RuntimeOpencodeConfig,
  globalPermission: Record<string, unknown>,
): RuntimeOpencodeConfig {
  const workspacePermission = isRecord(runtimeConfig.permission) ? runtimeConfig.permission : {};
  const permission: Record<string, unknown> = { ...globalPermission };
  if (isRecord(workspacePermission.external_directory)) {
    permission.external_directory = workspacePermission.external_directory;
  }
  const next = { ...runtimeConfig };
  delete next.permission;
  return Object.keys(permission).length
    ? { ...next, permission: permission as RuntimeOpencodeConfig["permission"] }
    : next;
}

export function runtimePluginList(config: RuntimeOpencodeConfig): string[] {
  return Array.isArray(config.plugin) ? config.plugin.filter((item) => typeof item === "string") : [];
}

export function runtimeDisabledProviderList(config: RuntimeOpencodeConfig): string[] {
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((item) => typeof item === "string")
    : [];
}

export function runtimeMcpMap(config: RuntimeOpencodeConfig): Record<string, Record<string, unknown>> {
  return isRecord(config.mcp) ? config.mcp as Record<string, Record<string, unknown>> : {};
}

export function runtimeAgentMap(config: RuntimeOpencodeConfig): Record<string, Record<string, unknown>> {
  return recordRecordMap(config.agent) ?? {};
}

export function runtimeExternalDirectory(config: RuntimeOpencodeConfig): Record<string, unknown> {
  const permission = isRecord(config.permission) ? config.permission : null;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : null;
  return externalDirectory ?? {};
}

export async function readRuntimeOpencodeConfig(config: ServerConfig, workspaceId: string): Promise<RuntimeOpencodeConfig> {
  const db = await runtimeDb(config);
  const row = db.get(workspaceId);
  if (!row) return {};
  try {
    return normalizeRuntimeOpencodeConfig(JSON.parse(row.configJson));
  } catch {
    return {};
  }
}

export async function writeRuntimeOpencodeConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: RuntimeOpencodeConfig) => RuntimeOpencodeConfig,
): Promise<RuntimeOpencodeConfig> {
  const db = await runtimeDb(config);
  const next = normalizeRuntimeOpencodeConfig(updater(await readRuntimeOpencodeConfig(config, workspaceId)));
  const now = Date.now();
  const configJson = JSON.stringify(next);
  db.upsert({ workspaceId, configJson, updatedAt: now });
  for (const listener of writeListeners) listener(config, workspaceId);
  return next;
}

/**
 * Merge a provider patch into the current runtime provider map. A `null` value
 * in the patch removes that provider — patch payloads can't carry `undefined`
 * over JSON, so callers signal deletion with `null`. This is what lets a client
 * fully disconnect a custom/runtime provider (not just drop its credential).
 */
export function mergeRuntimeProviderPatch(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(isRecord(current) ? current : {}),
    ...update,
  };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) delete merged[key];
  }
  return merged;
}

export function mergeOpencodeConfigs(
  persisted: Record<string, unknown>,
  runtime: RuntimeOpencodeConfig,
): Record<string, unknown> {
  const persistedPermission = isRecord(persisted.permission) ? persisted.permission : {};
  const persistedExternalDirectory = isRecord(persistedPermission.external_directory)
    ? persistedPermission.external_directory
    : {};
  return {
    ...persisted,
    plugin: [
      ...(Array.isArray(persisted.plugin) ? persisted.plugin.filter((item) => typeof item === "string") : []),
      ...runtimePluginList(runtime),
    ],
    disabled_providers: [
      ...(Array.isArray(persisted.disabled_providers) ? persisted.disabled_providers.filter((item) => typeof item === "string") : []),
      ...runtimeDisabledProviderList(runtime),
    ].filter((item, index, list) => list.indexOf(item) === index),
    mcp: {
      ...(isRecord(persisted.mcp) ? persisted.mcp : {}),
      ...runtimeMcpMap(runtime),
    },
    permission: {
      ...persistedPermission,
      ...(isRecord(runtime.permission) ? runtime.permission : {}),
      external_directory: {
        ...persistedExternalDirectory,
        ...runtimeExternalDirectory(runtime),
      },
    },
    ...(runtime.provider ? { provider: { ...(isRecord(persisted.provider) ? persisted.provider : {}), ...runtime.provider } } : {}),
    ...(runtime.agent ? { agent: { ...(isRecord(persisted.agent) ? persisted.agent : {}), ...runtime.agent } } : {}),
    ...(runtime.default_agent ? { default_agent: runtime.default_agent } : {}),
  };
}
