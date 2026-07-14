import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { EigenweltEntitlements } from "./eigenwelt-auth.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/**
 * Per-workspace record of the connected Eigenwelt firm. The `platformToken`
 * is a Bearer secret for the platform hub APIs (it rotates on every sign-in),
 * so it lives here in the server-side runtime DB and is NEVER returned to the
 * app — only entitlements + platformURL are exposed. Mirrors the storage
 * pattern of legalwork-workspace-config-store.ts (a separate table in the same
 * runtime.sqlite).
 */

const eigenweltConnections = sqliteTable("eigenwelt_connections", {
  workspaceId: text("workspace_id").primaryKey(),
  entitlementsJson: text("entitlements_json"),
  platformUrl: text("platform_url"),
  platformToken: text("platform_token"),
  updatedAt: integer("updated_at").notNull(),
});

type EigenweltConnectionRow = {
  entitlementsJson: string | null;
  platformUrl: string | null;
  platformToken: string | null;
};

type EigenweltConnectionDb = {
  get: (workspaceId: string) => EigenweltConnectionRow | undefined;
  upsert: (value: {
    workspaceId: string;
    entitlementsJson: string | null;
    platformUrl: string | null;
    platformToken: string | null;
    updatedAt: number;
  }) => void;
};

export type EigenweltConnection = {
  entitlements: EigenweltEntitlements | null;
  platformURL: string | null;
  platformToken: string | null;
};

/** App-safe view of a connection: entitlements + platformURL, never the token. */
export type EigenweltEntitlementsView = {
  entitlements: EigenweltEntitlements | null;
  platformURL: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS eigenwelt_connections (workspace_id TEXT PRIMARY KEY NOT NULL, entitlements_json TEXT, platform_url TEXT, platform_token TEXT, updated_at INTEGER NOT NULL)";

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.LEGALWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "runtime.sqlite");
}

async function openDb(path: string): Promise<EigenweltConnectionDb> {
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
          .from(eigenweltConnections)
          .where(eq(eigenweltConnections.workspaceId, workspaceId))
          .get(),
      upsert: ({ workspaceId, entitlementsJson, platformUrl, platformToken, updatedAt }) => {
        db
          .insert(eigenweltConnections)
          .values({ workspaceId, entitlementsJson, platformUrl, platformToken, updatedAt })
          .onConflictDoUpdate({
            target: eigenweltConnections.workspaceId,
            set: { entitlementsJson, platformUrl, platformToken, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec(CREATE_TABLE_SQL);
  const get = sqlite.prepare(
    "SELECT entitlements_json AS entitlementsJson, platform_url AS platformUrl, platform_token AS platformToken FROM eigenwelt_connections WHERE workspace_id = ?",
  );
  const upsert = sqlite.prepare(
    "INSERT INTO eigenwelt_connections (workspace_id, entitlements_json, platform_url, platform_token, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET entitlements_json = excluded.entitlements_json, platform_url = excluded.platform_url, platform_token = excluded.platform_token, updated_at = excluded.updated_at",
  );
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row)) return undefined;
      return {
        entitlementsJson: typeof row.entitlementsJson === "string" ? row.entitlementsJson : null,
        platformUrl: typeof row.platformUrl === "string" ? row.platformUrl : null,
        platformToken: typeof row.platformToken === "string" ? row.platformToken : null,
      };
    },
    upsert: ({ workspaceId, entitlementsJson, platformUrl, platformToken, updatedAt }) => {
      upsert.run(workspaceId, entitlementsJson, platformUrl, platformToken, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<EigenweltConnectionDb>>();

async function connectionDb(config: ServerConfig): Promise<EigenweltConnectionDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openDb(path);
  dbByPath.set(path, db);
  return db;
}

function decodeEntitlements(json: string | null): EigenweltEntitlements | null {
  if (!json) return null;
  try {
    return parseEigenweltEntitlements(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

/** Full connection incl. the secret token — server-side hub callers only. */
export async function readEigenweltConnection(
  config: ServerConfig,
  workspaceId: string,
): Promise<EigenweltConnection> {
  const db = await connectionDb(config);
  const row = db.get(workspaceId);
  if (!row) return { entitlements: null, platformURL: null, platformToken: null };
  return {
    entitlements: decodeEntitlements(row.entitlementsJson),
    platformURL: row.platformUrl,
    platformToken: row.platformToken,
  };
}

/** App-safe read: entitlements + platformURL, with the secret token stripped. */
export async function readEigenweltEntitlementsView(
  config: ServerConfig,
  workspaceId: string,
): Promise<EigenweltEntitlementsView> {
  const { entitlements, platformURL } = await readEigenweltConnection(config, workspaceId);
  return { entitlements, platformURL };
}

export type WriteEigenweltConnectionInput = {
  entitlements?: EigenweltEntitlements | null;
  platformURL?: string | null;
  platformToken?: string | null;
};

/**
 * Persist (upsert) the connection for a workspace. Only the fields supplied are
 * changed; passing `null` clears a field. The token rotates each sign-in, so
 * the app writes it on every successful connect.
 */
export async function writeEigenweltConnection(
  config: ServerConfig,
  workspaceId: string,
  input: WriteEigenweltConnectionInput,
): Promise<EigenweltEntitlementsView> {
  const db = await connectionDb(config);
  const current = db.get(workspaceId);

  const nextEntitlementsJson =
    input.entitlements === undefined
      ? current?.entitlementsJson ?? null
      : input.entitlements === null
        ? null
        : JSON.stringify(input.entitlements);
  const nextPlatformUrl =
    input.platformURL === undefined
      ? current?.platformUrl ?? null
      : input.platformURL
        ? input.platformURL.replace(/\/+$/, "")
        : null;
  const nextPlatformToken =
    input.platformToken === undefined
      ? current?.platformToken ?? null
      : input.platformToken || null;

  db.upsert({
    workspaceId,
    entitlementsJson: nextEntitlementsJson,
    platformUrl: nextPlatformUrl,
    platformToken: nextPlatformToken,
    updatedAt: Date.now(),
  });

  return {
    entitlements: decodeEntitlements(nextEntitlementsJson),
    platformURL: nextPlatformUrl,
  };
}
