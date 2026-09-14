import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { EigenweltAccountIdentity, EigenweltEntitlements } from "./eigenwelt-auth.js";
import {
  eigenweltPlatformUrl,
  parseEigenweltAccountIdentity,
  parseEigenweltEntitlements,
  validateEigenweltPlatformUrl,
} from "./eigenwelt-auth.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

/**
 * The connected Eigenwelt firm account. Like the paid manifest it unlocks, it
 * is ONE record shared by every workspace: a sign-in from any workspace serves
 * all of them. The tokens are Bearer secrets for the platform APIs and NEVER
 * leave the server: `platformToken` is the short-lived access token;
 * `refreshToken` is the long-lived, rotating refresh token traded for fresh
 * access tokens (see eigenwelt-refresh.ts). Only entitlements + platformURL +
 * a `connected` flag are exposed to the app.
 */

/** The single row's key in the `workspace_id` column (never a workspace id). */
const ACCOUNT_ROW_ID = "eigenwelt-account";

const eigenweltConnections = sqliteTable("eigenwelt_connections", {
  workspaceId: text("workspace_id").primaryKey(),
  entitlementsJson: text("entitlements_json"),
  accountJson: text("account_json"),
  platformUrl: text("platform_url"),
  platformToken: text("platform_token"),
  refreshToken: text("refresh_token"),
  platformTokenExpiresAt: integer("platform_token_expires_at"),
  updatedAt: integer("updated_at").notNull(),
});

type EigenweltConnectionRow = {
  entitlementsJson: string | null;
  accountJson: string | null;
  platformUrl: string | null;
  platformToken: string | null;
  refreshToken: string | null;
  platformTokenExpiresAt: number | null;
};

type UpsertValue = {
  workspaceId: string;
  entitlementsJson: string | null;
  accountJson: string | null;
  platformUrl: string | null;
  platformToken: string | null;
  refreshToken: string | null;
  platformTokenExpiresAt: number | null;
  updatedAt: number;
};

type EigenweltConnectionDb = {
  get: (workspaceId: string) => EigenweltConnectionRow | undefined;
  upsert: (value: UpsertValue) => void;
};

export type EigenweltConnection = {
  entitlements: EigenweltEntitlements | null;
  account: EigenweltAccountIdentity | null;
  platformURL: string | null;
  platformToken: string | null;
  refreshToken: string | null;
  platformTokenExpiresAt: number | null;
};

/** App-safe view of a connection: entitlements + platformURL, never a token. */
export type EigenweltEntitlementsView = {
  entitlements: EigenweltEntitlements | null;
  account: EigenweltAccountIdentity | null;
  platformURL: string | null;
  /**
   * Whether the firm is signed in with an Eigenwelt account — true when a
   * (secret) token is stored. This is the source of truth for "logged in",
   * INDEPENDENT of how many models the gateway serves, so the app can show the
   * connection even when the platform returns zero models.
   */
  connected: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS eigenwelt_connections (workspace_id TEXT PRIMARY KEY NOT NULL, entitlements_json TEXT, account_json TEXT, platform_url TEXT, platform_token TEXT, refresh_token TEXT, platform_token_expires_at INTEGER, updated_at INTEGER NOT NULL)";

// Columns added after the table's first release. SQLite has no ADD COLUMN IF
// NOT EXISTS, so each ALTER runs best-effort (throws "duplicate column" once the
// column exists — ignored).
const MIGRATION_COLUMNS = [
  "ALTER TABLE eigenwelt_connections ADD COLUMN refresh_token TEXT",
  "ALTER TABLE eigenwelt_connections ADD COLUMN platform_token_expires_at INTEGER",
  "ALTER TABLE eigenwelt_connections ADD COLUMN account_json TEXT",
];

// Earlier builds kept one connection per workspace, so the paid models came
// and went with the workspace that happened to be active. Keep the most
// recently written row (the latest sign-in, refresh or sign-out) as the
// account's, then drop the rest. The DELETE only runs once the copy succeeded.
const ACCOUNT_ROW_MIGRATION = [
  `INSERT OR IGNORE INTO eigenwelt_connections (workspace_id, entitlements_json, account_json, platform_url, platform_token, refresh_token, platform_token_expires_at, updated_at) SELECT '${ACCOUNT_ROW_ID}', entitlements_json, account_json, platform_url, platform_token, refresh_token, platform_token_expires_at, updated_at FROM eigenwelt_connections WHERE workspace_id <> '${ACCOUNT_ROW_ID}' ORDER BY updated_at DESC LIMIT 1`,
  `DELETE FROM eigenwelt_connections WHERE workspace_id <> '${ACCOUNT_ROW_ID}'`,
];

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
    for (const sql of MIGRATION_COLUMNS) {
      try {
        sqlite.run(sql);
      } catch {
        // column already exists
      }
    }
    try {
      for (const sql of ACCOUNT_ROW_MIGRATION) sqlite.run(sql);
    } catch {
      // copy failed: the legacy rows stay, and the next open retries
    }
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) =>
        db
          .select()
          .from(eigenweltConnections)
          .where(eq(eigenweltConnections.workspaceId, workspaceId))
          .get(),
      upsert: (value) => {
        const { workspaceId, updatedAt, ...set } = value;
        db
          .insert(eigenweltConnections)
          .values(value)
          .onConflictDoUpdate({
            target: eigenweltConnections.workspaceId,
            set: { ...set, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec(CREATE_TABLE_SQL);
  for (const sql of MIGRATION_COLUMNS) {
    try {
      sqlite.exec(sql);
    } catch {
      // column already exists
    }
  }
  try {
    for (const sql of ACCOUNT_ROW_MIGRATION) sqlite.exec(sql);
  } catch {
    // copy failed: the legacy rows stay, and the next open retries
  }
  const get = sqlite.prepare(
    "SELECT entitlements_json AS entitlementsJson, account_json AS accountJson, platform_url AS platformUrl, platform_token AS platformToken, refresh_token AS refreshToken, platform_token_expires_at AS platformTokenExpiresAt FROM eigenwelt_connections WHERE workspace_id = ?",
  );
  const upsert = sqlite.prepare(
    "INSERT INTO eigenwelt_connections (workspace_id, entitlements_json, account_json, platform_url, platform_token, refresh_token, platform_token_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET entitlements_json = excluded.entitlements_json, account_json = excluded.account_json, platform_url = excluded.platform_url, platform_token = excluded.platform_token, refresh_token = excluded.refresh_token, platform_token_expires_at = excluded.platform_token_expires_at, updated_at = excluded.updated_at",
  );
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row)) return undefined;
      return {
        entitlementsJson: typeof row.entitlementsJson === "string" ? row.entitlementsJson : null,
        accountJson: typeof row.accountJson === "string" ? row.accountJson : null,
        platformUrl: typeof row.platformUrl === "string" ? row.platformUrl : null,
        platformToken: typeof row.platformToken === "string" ? row.platformToken : null,
        refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : null,
        platformTokenExpiresAt:
          typeof row.platformTokenExpiresAt === "number" ? row.platformTokenExpiresAt : null,
      };
    },
    upsert: (value) => {
      upsert.run(
        value.workspaceId,
        value.entitlementsJson,
        value.accountJson,
        value.platformUrl,
        value.platformToken,
        value.refreshToken,
        value.platformTokenExpiresAt,
        value.updatedAt,
      );
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

function decodeAccount(json: string | null): EigenweltAccountIdentity | null {
  if (!json) return null;
  try {
    return parseEigenweltAccountIdentity(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

/** Full connection incl. the secret tokens — server-side callers only. */
export async function readEigenweltConnection(config: ServerConfig): Promise<EigenweltConnection> {
  const db = await connectionDb(config);
  const row = db.get(ACCOUNT_ROW_ID);
  if (!row) {
    return {
      entitlements: null,
      account: null,
      platformURL: null,
      platformToken: null,
      refreshToken: null,
      platformTokenExpiresAt: null,
    };
  }
  return {
    entitlements: decodeEntitlements(row.entitlementsJson),
    account: decodeAccount(row.accountJson),
    platformURL: row.platformUrl,
    platformToken: row.platformToken,
    refreshToken: row.refreshToken,
    platformTokenExpiresAt: row.platformTokenExpiresAt,
  };
}

/** App-safe read: entitlements + platformURL, with the secret tokens stripped. */
export async function readEigenweltEntitlementsView(config: ServerConfig): Promise<EigenweltEntitlementsView> {
  const { entitlements, account, platformURL, platformToken, refreshToken } = await readEigenweltConnection(config);
  // Fall back to the configured platform origin (EIGENWELT_PLATFORM_URL) so
  // billing / members / pricing links always point at the instance the app is
  // actually talking to — even before a connection is persisted — instead of
  // the hard-coded production URL. `connected` reflects the stored account, not
  // the model list: a token (access OR refresh) OR entitlements means signed in.
  let safePlatformURL = eigenweltPlatformUrl();
  if (platformURL) {
    try {
      safePlatformURL = validateEigenweltPlatformUrl(platformURL);
    } catch {
      // Ignore a legacy/tampered stored URL. Server-side traffic and public
      // billing/member links both remain pinned to the configured origin.
    }
  }
  return {
    entitlements,
    account,
    platformURL: safePlatformURL,
    connected: Boolean(platformToken) || Boolean(refreshToken) || entitlements !== null,
  };
}

export type WriteEigenweltConnectionInput = {
  entitlements?: EigenweltEntitlements | null;
  account?: EigenweltAccountIdentity | null;
  platformURL?: string | null;
  platformToken?: string | null;
  refreshToken?: string | null;
  /** Epoch millis when `platformToken` expires. */
  accessTokenExpiresAt?: number | null;
};

/**
 * Persist (upsert) the account connection. Only the fields supplied are
 * changed; passing `null` clears a field. Tokens rotate over the connection's
 * life (sign-in, then each refresh), so callers re-write them frequently.
 */
export async function writeEigenweltConnection(
  config: ServerConfig,
  input: WriteEigenweltConnectionInput,
): Promise<EigenweltEntitlementsView> {
  const db = await connectionDb(config);
  const current = db.get(ACCOUNT_ROW_ID);

  const nextEntitlementsJson =
    input.entitlements === undefined
      ? current?.entitlementsJson ?? null
      : input.entitlements === null
        ? null
        : JSON.stringify(input.entitlements);
  const nextAccountJson =
    input.account === undefined
      ? current?.accountJson ?? null
      : input.account === null
        ? null
        : JSON.stringify(input.account);
  const nextPlatformUrl =
    input.platformURL === undefined
      ? current?.platformUrl ?? null
      : input.platformURL
        ? validateEigenweltPlatformUrl(input.platformURL)
        : null;
  const nextPlatformToken =
    input.platformToken === undefined
      ? current?.platformToken ?? null
      : input.platformToken || null;
  const nextRefreshToken =
    input.refreshToken === undefined
      ? current?.refreshToken ?? null
      : input.refreshToken || null;
  const nextExpiresAt =
    input.accessTokenExpiresAt === undefined
      ? current?.platformTokenExpiresAt ?? null
      : input.accessTokenExpiresAt || null;

  db.upsert({
    workspaceId: ACCOUNT_ROW_ID,
    entitlementsJson: nextEntitlementsJson,
    accountJson: nextAccountJson,
    platformUrl: nextPlatformUrl,
    platformToken: nextPlatformToken,
    refreshToken: nextRefreshToken,
    platformTokenExpiresAt: nextExpiresAt,
    updatedAt: Date.now(),
  });

  const nextEntitlements = decodeEntitlements(nextEntitlementsJson);
  const nextAccount = decodeAccount(nextAccountJson);
  return {
    entitlements: nextEntitlements,
    account: nextAccount,
    platformURL: nextPlatformUrl,
    connected: Boolean(nextPlatformToken) || Boolean(nextRefreshToken) || nextEntitlements !== null,
  };
}
