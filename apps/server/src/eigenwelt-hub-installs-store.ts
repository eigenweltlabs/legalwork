import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { EigenweltHubKind } from "./eigenwelt-hub.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/**
 * Per-workspace record of which Firm Hub items are installed and at what
 * version. It powers "pull with update notifications": the Firm Hub compares the
 * recorded version against the firm's current `version` to surface an Update
 * affordance. Updates are NEVER applied silently — the user pulls.
 *
 * Storage mirrors legalwork-workspace-config-store.ts / eigenwelt-connection-
 * store.ts: a dedicated table in the same runtime.sqlite, one row per workspace
 * holding the id→record map as JSON.
 */

export type HubInstallRecord = {
  version: number;
  kind: EigenweltHubKind;
  name: string;
  installedAt: number;
};

export type HubInstallMap = Record<string, HubInstallRecord>;

const eigenweltHubInstalls = sqliteTable("eigenwelt_hub_installs", {
  workspaceId: text("workspace_id").primaryKey(),
  installsJson: text("installs_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type EigenweltHubInstallsDb = {
  get: (workspaceId: string) => { installsJson: string } | undefined;
  upsert: (value: { workspaceId: string; installsJson: string; updatedAt: number }) => void;
};

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS eigenwelt_hub_installs (workspace_id TEXT PRIMARY KEY NOT NULL, installs_json TEXT NOT NULL, updated_at INTEGER NOT NULL)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.LEGALWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "runtime.sqlite");
}

async function openDb(path: string): Promise<EigenweltHubInstallsDb> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    sqlite.run(CREATE_TABLE_SQL);
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) =>
        db
          .select()
          .from(eigenweltHubInstalls)
          .where(eq(eigenweltHubInstalls.workspaceId, workspaceId))
          .get(),
      upsert: ({ workspaceId, installsJson, updatedAt }) => {
        db
          .insert(eigenweltHubInstalls)
          .values({ workspaceId, installsJson, updatedAt })
          .onConflictDoUpdate({
            target: eigenweltHubInstalls.workspaceId,
            set: { installsJson, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec(CREATE_TABLE_SQL);
  const get = sqlite.prepare(
    "SELECT installs_json AS installsJson FROM eigenwelt_hub_installs WHERE workspace_id = ?",
  );
  const upsert = sqlite.prepare(
    "INSERT INTO eigenwelt_hub_installs (workspace_id, installs_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET installs_json = excluded.installs_json, updated_at = excluded.updated_at",
  );
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.installsJson !== "string") return undefined;
      return { installsJson: row.installsJson };
    },
    upsert: ({ workspaceId, installsJson, updatedAt }) => {
      upsert.run(workspaceId, installsJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<EigenweltHubInstallsDb>>();

async function installsDb(config: ServerConfig): Promise<EigenweltHubInstallsDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openDb(path);
  dbByPath.set(path, db);
  return db;
}

function normalizeRecord(value: unknown): HubInstallRecord | null {
  if (!isRecord(value)) return null;
  const version = typeof value.version === "number" ? value.version : Number(value.version);
  const kind = value.kind;
  if (!Number.isFinite(version)) return null;
  if (kind !== "workflow" && kind !== "integration" && kind !== "preset") return null;
  return {
    version,
    kind,
    name: typeof value.name === "string" ? value.name : "",
    installedAt: typeof value.installedAt === "number" ? value.installedAt : Date.now(),
  };
}

function normalizeMap(value: unknown): HubInstallMap {
  if (!isRecord(value)) return {};
  const out: HubInstallMap = {};
  for (const [id, record] of Object.entries(value)) {
    const normalized = normalizeRecord(record);
    if (normalized) out[id] = normalized;
  }
  return out;
}

/** Read the installed-item map for a workspace ({} when none recorded). */
export async function readHubInstalls(config: ServerConfig, workspaceId: string): Promise<HubInstallMap> {
  const db = await installsDb(config);
  const row = db.get(workspaceId);
  if (!row) return {};
  try {
    return normalizeMap(JSON.parse(row.installsJson));
  } catch {
    return {};
  }
}

/** Record (upsert) a single installed item's `{version, kind, name}` for a workspace. */
export async function recordHubInstall(
  config: ServerConfig,
  workspaceId: string,
  id: string,
  record: HubInstallRecord,
): Promise<HubInstallMap> {
  const db = await installsDb(config);
  const current = await readHubInstalls(config, workspaceId);
  const next: HubInstallMap = { ...current, [id]: record };
  db.upsert({ workspaceId, installsJson: JSON.stringify(next), updatedAt: Date.now() });
  return next;
}

/** Forget an installed item (e.g. after it's removed locally). */
export async function forgetHubInstall(
  config: ServerConfig,
  workspaceId: string,
  id: string,
): Promise<HubInstallMap> {
  const db = await installsDb(config);
  const current = await readHubInstalls(config, workspaceId);
  if (!(id in current)) return current;
  const next: HubInstallMap = { ...current };
  delete next[id];
  db.upsert({ workspaceId, installsJson: JSON.stringify(next), updatedAt: Date.now() });
  return next;
}
