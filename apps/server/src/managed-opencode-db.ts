/**
 * Private SQLite database for the managed OpenCode engine.
 *
 * By default OpenCode keeps ONE global database (XDG data dir, e.g.
 * ~/.local/share/opencode/opencode.db — the same dotted path on Windows), so
 * a LegalWork-managed engine shares it with any OpenCode the user installed
 * separately. That standalone install is free to run a different release
 * (the auto-updating desktop app, a canary, an old CLI) and migrate the
 * shared DB to a schema the pinned sidecar engine has never seen. The pinned
 * engine then fails on that foreign schema — either at startup ("Database is
 * not empty and has no session table" -> the engine never comes up, every
 * task reports "OpenCode is unavailable for this workspace") or lazily on
 * each request (500 UnknownError "Unexpected server error" on provider
 * listing, MCP connect, session create). See issue #62.
 *
 * The fix: give the managed engine its own DB file under LegalWork's runtime
 * storage dir, passed via OPENCODE_DB (an absolute path there is used as-is
 * by the engine). To keep existing users' sessions, the private DB is seeded
 * once from the shared DB — but only when the shared DB is compatible with
 * the pinned engine (its migrations are all known to it); a foreign or
 * unreadable shared DB is left alone and the engine starts fresh.
 */
import { chmodSync, copyFileSync, constants as fsConstants, existsSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { ServerConfig } from "./types.js";
import { SessionV1 } from "@opencode/schema/session-v1";
import { Schema } from "effect";
import { findExistingOpencodeDbIn, findExistingOpencodeDbPath } from "./opencode-db.js";
import { engineStorageDir } from "./engine-storage.js";
import { ensureLegacyHistoryBackup, readLegacyHistoryBackup } from "./history-v1-backup.js";

export const MANAGED_ENGINE_DB_FILENAME = "opencode-engine-v2.db";
export const LEGACY_MANAGED_ENGINE_DB_FILENAME = "opencode-engine.db";

/**
 * Timestamp prefix of the newest migration bundled in the pinned engine
 * (constants.json opencodeVersion). A shared DB containing any migration
 * NEWER than this was written by a newer OpenCode and must not be adopted.
 * Update together with constants.json opencodeVersion (list the bundled
 * migrations by running `strings <opencode binary> | grep -oE
 * '20[0-9]{12}_[a-z0-9_]+'`).
 */
export const PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP = "20261010180456"; // Released OpenCode 2.1.4 migration.gen.ts.

export type SharedOpencodeDbCompatibility = "compatible" | "foreign" | "unreadable";

// Minimal read surface over bun:sqlite (bun runtime) or node:sqlite (Node /
// Electron). Same dual-driver approach as runtime-opencode-config-store.ts —
// better-sqlite3 is not loadable under bun.
type SqliteReader = {
  all: (sql: string, params?: string[]) => Array<Record<string, unknown>>;
  iterate: (sql: string, params?: string[]) => Iterable<Record<string, unknown>>;
  run: (sql: string, params: string[]) => void;
  close: () => void;
};

export async function openSqliteReadonly(path: string): Promise<SqliteReader> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return {
      all: (sql, params = []) => db.query(sql).all(...params) as Array<Record<string, unknown>>,
      // Bun finalizes an iterator's statement on early exit. Never reuse a
      // cached query statement for the next chat's streamed search.
      iterate: (sql, params = []) => db.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>,
      run: (sql, params) => {
        db.query(sql).run(...params);
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    iterate: (sql, params = []) => db.prepare(sql).iterate(...params),
    run: (sql, params) => {
      db.prepare(sql).run(...params);
    },
    close: () => db.close(),
  };
}

/**
 * Can the pinned engine safely open this DB? "compatible" means every
 * migration recorded in it is at or below the pinned engine's newest bundled
 * migration (or the DB predates the migration table entirely), so the engine
 * can migrate it forward. Anything newer or structurally unexpected is
 * "foreign".
 */
export async function classifySharedOpencodeDb(
  path: string,
  newestLocalMigrationTimestamp: string = PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP,
): Promise<SharedOpencodeDbCompatibility> {
  if (!existsSync(path)) return "unreadable";
  let db: SqliteReader | null = null;
  try {
    db = await openSqliteReadonly(path);
    const tables = new Set(
      db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name ?? "")),
    );
    // A brand-new/empty DB is fine — the engine initializes it from scratch.
    if (tables.size === 0) return "compatible";
    if (tables.has("migration")) {
      for (const row of db.all("SELECT id FROM migration")) {
        const id = String(row.id ?? "");
        const timestamp = /^(\d{14})/.exec(id)?.[1];
        if (!timestamp || timestamp > newestLocalMigrationTimestamp) return "foreign";
      }
      return "compatible";
    }
    // Pre-migration-table era DBs are upgraded in place by the engine, but it
    // refuses a non-empty DB without a session table ("Database is not empty
    // and has no session table").
    return tables.has("session") ? "compatible" : "foreign";
  } catch {
    return "unreadable";
  } finally {
    db?.close();
  }
}

async function seedPrivateDbFromShared(sharedPath: string, privatePath: string, consistentSnapshot = false): Promise<boolean> {
  let db: SqliteReader | null = null;
  const staging = join(dirname(privatePath), `.opencode-v2-snapshot-${randomUUID()}`);
  try {
    // VACUUM INTO takes a consistent snapshot (WAL included) even while the
    // user's own OpenCode has the shared DB open, and writes a compact copy.
    // SQLite requires a missing destination. Its private parent prevents a
    // permissive umask exposing history before the final file is restricted.
    mkdirSync(staging, { mode: 0o700 });
    const snapshot = join(staging, "engine.db");
    if (consistentSnapshot) copyFileSync(sharedPath, snapshot, fsConstants.COPYFILE_EXCL);
    else {
      db = await openSqliteReadonly(sharedPath);
      db.run("VACUUM INTO ?", [snapshot]);
    }
    chmodSync(snapshot, 0o600);
    // Publish atomically without replacing a DB another process created.
    linkSync(snapshot, privatePath);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
    rmSync(staging, { recursive: true, force: true });
  }
}

export type ManagedEngineDb = {
  /** Absolute path to pass to the engine as OPENCODE_DB. */
  path: string;
  /** Shared DB the private one was seeded from on this call, if any. */
  seededFrom: string | null;
  /** Why the shared DB was (not) adopted; null when the private DB already existed or no shared DB exists. */
  sharedDbCompatibility: SharedOpencodeDbCompatibility | null;
  /** Private inventory of records upstream cannot carry over verbatim. */
  migrationReport?: string;
};

export type LegacyHistoryInventory = {
  source: string;
  destination: string;
  engineVersion: "2.1.4";
  createdAt: number;
  counts: Record<string, number>;
  issues: Array<{ reason: string; sessionID?: string; messageID?: string; partID?: string; uri?: string }>;
};

/** Inventory the immutable source, never model-facing output. No rows are
 * truncated. The released engine owns conversion; this report makes its
 * attachment/malformed-row/interrupted-tool limitations reviewable. */
export async function inventoryLegacyHistory(source: string, destination: string): Promise<LegacyHistoryInventory> {
  const db = await openSqliteReadonly(source);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
    const report: LegacyHistoryInventory = { source, destination, engineVersion: "2.1.4", createdAt: Date.now(), counts: {}, issues: [] };
    for (const table of ["session", "message", "part", "event"]) {
      if (tables.has(table)) report.counts[table] = Number(db.all(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0);
    }
    if (!tables.has("part")) return report;
    const partRows = tables.has("message")
      ? "SELECT part.id, part.session_id, part.message_id, part.data, message.data AS message_data FROM part LEFT JOIN message ON message.id = part.message_id AND message.session_id = part.session_id"
      : "SELECT id, session_id, message_id, data, NULL AS message_data FROM part";
    const metadataKind = (metadata: unknown) => {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
      const keys = Object.keys(metadata);
      return keys.length ? keys.some(key => key.startsWith("legalwork")) ? "app" : "unconsumed" : null;
    };
    for (const row of db.iterate(partRows)) {
      const identity = { sessionID: String(row.session_id), messageID: String(row.message_id), partID: String(row.id) };
      let ownerRole: string | undefined;
      try {
        const owner: unknown = JSON.parse(String(row.message_data));
        if (owner && typeof owner === "object" && "role" in owner && typeof owner.role === "string") ownerRole = owner.role;
      } catch { /* A malformed owner is reported in the message inventory below. */ }
      let value: unknown;
      try { value = JSON.parse(String(row.data)); }
      catch { report.issues.push({ reason: "invalid-part-json", ...identity }); continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { report.issues.push({ reason: "invalid-part", ...identity }); continue; }
      if (!Schema.is(SessionV1.Part)({ ...value, id: row.id, sessionID: row.session_id, messageID: row.message_id })) {
        report.issues.push({ reason: "invalid-part", ...identity });
      }
      const metadata = "metadata" in value ? metadataKind(value.metadata) : null;
      if (metadata && "type" in value) {
        if (ownerRole === "assistant" && ["text", "reasoning", "tool"].includes(String(value.type))) {
          // Upstream retains these fields on content.native. This is a
          // location change, not missing model/UI data.
          report.issues.push({ reason: "assistant-part-metadata-relocated-to-native", ...identity });
        } else if (ownerRole === "user" && value.type === "text") {
          report.issues.push({ reason: `user-text-${metadata}-metadata-not-imported`, ...identity });
        }
      }
      // User file inputs are subject to the data:-only conversion rule.
      // Completed-tool attachments live inside state.attachments and are
      // retained as native URI content; never apply this rule to them.
      if ("type" in value && value.type === "file" && "url" in value && typeof value.url === "string" && ownerRole !== "assistant") {
        if (!value.url.startsWith("data:")) {
          report.issues.push({ reason: "non-inline-attachment", ...identity, uri: value.url });
        } else if ("source" in value && value.source && typeof value.source === "object" && "type" in value.source
          && (value.source.type === "file" || value.source.type === "symbol") && "path" in value.source && typeof value.source.path === "string") {
          report.issues.push({ reason: "file-source-navigation-not-imported", ...identity, uri: value.source.path });
        }
      }
      if ("type" in value && value.type === "tool" && "state" in value && value.state && typeof value.state === "object"
        && "status" in value.state && (value.state.status === "running" || value.state.status === "pending")) {
        report.issues.push({ reason: "interrupted-tool", ...identity });
      }
    }
    if (tables.has("message")) for (const row of db.iterate("SELECT id, session_id, data FROM message")) {
      try {
        const value: unknown = JSON.parse(String(row.data));
        const identity = { sessionID: String(row.session_id), messageID: String(row.id) };
        if (!value || typeof value !== "object" || Array.isArray(value) || !Schema.is(SessionV1.Info)({ ...value, id: row.id, sessionID: row.session_id })) {
          report.issues.push({ reason: "invalid-message", ...identity });
        }
        if (value && typeof value === "object" && "role" in value && (value.role === "user" || value.role === "assistant") && "metadata" in value) {
          const metadata = metadataKind(value.metadata);
          if (metadata) report.issues.push({ reason: `${value.role}-message-${metadata}-metadata-not-imported`, ...identity });
        }
      }
      catch { report.issues.push({ reason: "invalid-message-json", sessionID: String(row.session_id), messageID: String(row.id) }); }
    }
    if (tables.has("session") && db.all("PRAGMA table_info(session)").some(column => column.name === "revert")) {
      for (const row of db.iterate("SELECT id FROM session WHERE revert IS NOT NULL")) report.issues.push({ reason: "revert-state-not-imported", sessionID: String(row.id) });
    }
    return report;
  } finally { db.close(); }
}

/**
 * Resolve (and on first use seed) the managed engine's private database.
 * Returns null only for an explicit OPENCODE_DB override. Managed development
 * uses its own runtime DB without importing standalone OpenCode history.
 * A failed copy of existing managed history stops startup; silently starting
 * against another database would hide the user's chats.
 */
async function prepareManagedOpencodeEngineDbFiles(config: ServerConfig): Promise<ManagedEngineDb | null> {
    if (process.env.OPENCODE_DB?.trim()) return null;

    const storageDir = engineStorageDir(config);
    mkdirSync(storageDir, { recursive: true });
    const privatePath = join(storageDir, MANAGED_ENGINE_DB_FILENAME);
    if (existsSync(privatePath)) {
      // Earlier development migrations retained original v1 rows. Freeze
      // them before a future engine can clean up those tables.
      if (!existsSync(join(storageDir, "history-import-state.json")) && !(await readLegacyHistoryBackup(config))) {
        const db = await openSqliteReadonly(privatePath);
        try {
          const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
          if (["session", "message", "part"].every(table => tables.has(table))) {
            await ensureLegacyHistoryBackup(config, privatePath, async destination => { db.run("VACUUM INTO ?", [destination]); });
          }
        } finally { db.close(); }
      }
      return { path: privatePath, seededFrom: null, sharedDbCompatibility: null };
    }

    if (existsSync(join(storageDir, "history-import-state.json"))) throw new Error("The migrated engine history database is missing. Restore its private recovery copy before starting.");

    // A separate v2 file makes rollback safe: the old released app can still
    // open its untouched v1 history. Development only adopts its own explicit
    // profile directory, never the user's standalone or production history.
    const legacyPath = join(storageDir, LEGACY_MANAGED_ENGINE_DB_FILENAME);
    const development = process.env.LEGALWORK_DEV_MODE === "1";
    const devDataDirectory = process.env.LEGALWORK_DEV_OPENCODE_DATA_DIR?.trim();
    const sharedPath = existsSync(legacyPath) ? legacyPath
      : development ? (devDataDirectory ? findExistingOpencodeDbIn(devDataDirectory) : null)
      : findExistingOpencodeDbPath();
    if (!sharedPath) {
      return { path: privatePath, seededFrom: null, sharedDbCompatibility: null };
    }

    const compatibility = await classifySharedOpencodeDb(sharedPath);
    if ((existsSync(legacyPath) || development) && compatibility !== "compatible") throw new Error(`The existing LegalWork history cannot be migrated safely (${compatibility}): ${sharedPath}`);
    const backup = compatibility === "compatible" ? await ensureLegacyHistoryBackup(config, sharedPath, async destination => {
      const db = await openSqliteReadonly(sharedPath);
      try { db.run("VACUUM INTO ?", [destination]); } finally { db.close(); }
    }) : null;
    const seeded = backup !== null && (await seedPrivateDbFromShared(backup.path, privatePath, true));
    if (compatibility === "compatible" && !seeded) throw new Error(`Could not create a consistent v2 history copy. The source is unchanged: ${sharedPath}`);
    const inventory = seeded ? { ...await inventoryLegacyHistory(privatePath, privatePath), source: sharedPath } : undefined;
    const migrationReport = seeded && inventory ? join(storageDir, "opencode-v2-history-migration.json") : undefined;
    if (migrationReport && inventory) {
      const temporary = `${migrationReport}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(inventory, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, migrationReport); }
      finally { rmSync(temporary, { force: true }); }
      chmodSync(privatePath, 0o600);
    }
    return {
      path: privatePath,
      seededFrom: seeded ? sharedPath : null,
      sharedDbCompatibility: compatibility,
      ...(migrationReport ? { migrationReport } : {}),
    };
}

/** Import application-owned history metadata once, before the engine can resume work. */
export async function prepareManagedOpencodeEngineDb(config: ServerConfig): Promise<ManagedEngineDb | null> {
  const result = await prepareManagedOpencodeEngineDbFiles(config);
  if (result) {
    const { readCurrentHistory } = await import("./current-history-state.js");
    await readCurrentHistory(config);
  }
  return result;
}
