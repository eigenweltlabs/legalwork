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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ServerConfig } from "./types.js";
import { findExistingOpencodeDbPath } from "./opencode-db.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";

export const MANAGED_ENGINE_DB_FILENAME = "opencode-engine.db";

/**
 * Timestamp prefix of the newest migration bundled in the pinned engine
 * (constants.json opencodeVersion). A shared DB containing any migration
 * NEWER than this was written by a newer OpenCode and must not be adopted.
 * Update together with constants.json opencodeVersion (list the bundled
 * migrations by running `strings <opencode binary> | grep -oE
 * '20[0-9]{12}_[a-z0-9_]+'`).
 */
export const PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP = "20260622202450"; // opencode v1.17.18

export type SharedOpencodeDbCompatibility = "compatible" | "foreign" | "unreadable";

// Minimal read surface over bun:sqlite (bun runtime) or node:sqlite (Node /
// Electron). Same dual-driver approach as runtime-opencode-config-store.ts —
// better-sqlite3 is not loadable under bun.
type SqliteReader = {
  all: (sql: string) => Array<Record<string, unknown>>;
  run: (sql: string, params: string[]) => void;
  close: () => void;
};

async function openSqliteReadonly(path: string): Promise<SqliteReader> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return {
      all: (sql) => db.query(sql).all() as Array<Record<string, unknown>>,
      run: (sql, params) => {
        db.query(sql).run(...params);
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>,
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

async function seedPrivateDbFromShared(sharedPath: string, privatePath: string): Promise<boolean> {
  let db: SqliteReader | null = null;
  try {
    // VACUUM INTO takes a consistent snapshot (WAL included) even while the
    // user's own OpenCode has the shared DB open, and writes a compact copy.
    db = await openSqliteReadonly(sharedPath);
    db.run("VACUUM INTO ?", [privatePath]);
    return true;
  } catch {
    // Never leave a partial copy behind — the engine would try to open it.
    try {
      rmSync(privatePath, { force: true });
    } catch {
      // ignore
    }
    return false;
  } finally {
    db?.close();
  }
}

export type ManagedEngineDb = {
  /** Absolute path to pass to the engine as OPENCODE_DB. */
  path: string;
  /** Shared DB the private one was seeded from on this call, if any. */
  seededFrom: string | null;
  /** Why the shared DB was (not) adopted; null when the private DB already existed or no shared DB exists. */
  sharedDbCompatibility: SharedOpencodeDbCompatibility | null;
};

/**
 * Resolve (and on first use seed) the managed engine's private database.
 * Returns null when the caller should leave OPENCODE_DB handling untouched:
 * an explicit OPENCODE_DB override is set, dev mode already isolates the
 * whole OpenCode home, or preparation failed unexpectedly (status quo is
 * safer than blocking engine startup).
 */
export async function prepareManagedOpencodeEngineDb(config: ServerConfig): Promise<ManagedEngineDb | null> {
  try {
    if (process.env.OPENCODE_DB?.trim()) return null;
    if (process.env.LEGALWORK_DEV_MODE === "1") return null;

    const storageDir = runtimeStorageDir(config);
    mkdirSync(storageDir, { recursive: true });
    const privatePath = join(storageDir, MANAGED_ENGINE_DB_FILENAME);
    if (existsSync(privatePath)) {
      return { path: privatePath, seededFrom: null, sharedDbCompatibility: null };
    }

    const sharedPath = findExistingOpencodeDbPath();
    if (!sharedPath) {
      return { path: privatePath, seededFrom: null, sharedDbCompatibility: null };
    }

    const compatibility = await classifySharedOpencodeDb(sharedPath);
    const seeded = compatibility === "compatible" && (await seedPrivateDbFromShared(sharedPath, privatePath));
    return {
      path: privatePath,
      seededFrom: seeded ? sharedPath : null,
      sharedDbCompatibility: compatibility,
    };
  } catch {
    return null;
  }
}
