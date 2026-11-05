import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";

export const NATIVE_CONFIG_TABLE = "native_runtime_configs";
export const NATIVE_CONFIG_SCOPE_TABLE = "native_config_scopes";
const stateTable = "native_config_state", backupTable = "native_config_backups";
const tables = [NATIVE_CONFIG_TABLE, NATIVE_CONFIG_SCOPE_TABLE, stateTable, backupTable];
const markerSchema = z.object({ version: z.literal(2), profileID: z.string().uuid(), completed: z.literal(true),
  components: z.record(z.string(), z.enum(["pending", "complete"])).default({}),
}).strict();
type Marker = z.infer<typeof markerSchema>;
type ConfigurationRow = { configJson: string };
export type NativeConfigBackup = { sourceVersion: number; configJson: string; noticesJson: string; createdAt: number };
export type LegacyConfigurationImport = (workspaceId: string, source: string) => { configJson: string; sourceVersion: number; noticesJson: string };
export const nativeConfigStatePath = (databasePath: string) => `${databasePath}.native-config-state.json`;
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

export function nativeConfigStateError(reason: string, workspaceId?: string): ApiError {
  return new ApiError(409, "execution_settings_invalid", "Saved native settings could not be loaded safely. LegalWork has stopped this operation to avoid resetting your permissions. Restore or repair the original app profile before retrying.",
    { settingsScope: "application", reason, ...(workspaceId === undefined ? {} : { workspaceId }) });
}

async function readMarker(path: string): Promise<Marker | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw nativeConfigStateError("native_configuration_marker_invalid");
    return markerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) { if (absent(error)) return; throw nativeConfigStateError("native_configuration_marker_invalid"); }
}
function readMarkerSync(path: string): Marker | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid native marker");
    return markerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) { if (absent(error)) return; throw nativeConfigStateError("native_configuration_marker_invalid"); }
}


function syncMarkerDirectory(path: string) {
  let directory: number | undefined;
  try { directory = openSync(dirname(path), "r"); fsyncSync(directory); }
  catch (error) {
    // Windows does not expose directory fsync through Node's file API. The
    // complete marker file itself was synced before atomic publication.
    if (!(process.platform === "win32" && error instanceof Error && "code" in error && ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(String(error.code)))) throw error;
  } finally { if (directory !== undefined) closeSync(directory); }
}

function replaceMarker(path: string, marker: Marker) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    // Flush through the writing handle: Windows FlushFileBuffers requires
    // GENERIC_WRITE and rejects a file reopened read-only for fsync.
    const file = openSync(temporary, "wx", 0o600);
    try { writeFileSync(file, JSON.stringify(marker) + "\n"); fsyncSync(file); }
    finally { closeSync(file); }
    renameSync(temporary, path);
    syncMarkerDirectory(path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (!absent(error)) throw error; } }
}

function tableNames(db: SqliteHandle) { return new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name)); }
function state(db: SqliteHandle, unpublished = false): Marker {
  try {
    const row = db.get(`SELECT version,profile_id AS profileID,completed FROM ${stateTable} WHERE id=1`);
    return markerSchema.parse({ ...row, completed: row?.completed === 1 || unpublished && row?.completed === 0 });
  } catch { throw nativeConfigStateError("native_configuration_state_invalid"); }
}
function completeTables(db: SqliteHandle) {
  const existing = tableNames(db);
  if (tables.some(table => !existing.has(table))) throw nativeConfigStateError("native_configuration_table_missing");
}
function transaction<T>(db: SqliteHandle, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function original(db: SqliteHandle, workspaceId: string, source: string, sourceVersion: number, noticesJson: string, createdAt: number) {
  db.run(`INSERT OR IGNORE INTO ${backupTable}(workspace_id,source_hash,source_version,config_json,notices_json,created_at) VALUES(?,?,?,?,?,?)`, [workspaceId, hash(source), sourceVersion, source, noticesJson, createdAt]);
}
function nativeRow(db: SqliteHandle, workspaceId: string): ConfigurationRow | undefined {
  const row = db.get(`SELECT config_json AS configJson FROM ${NATIVE_CONFIG_TABLE} WHERE workspace_id=?`, [workspaceId]);
  if (!row) return;
  if (typeof row.configJson !== "string") throw nativeConfigStateError("native_configuration_row_invalid", workspaceId);
  return { configJson: row.configJson };
}
function scope(db: SqliteHandle, workspaceId: string) {
  const row = db.get(`SELECT status,source_hash AS sourceHash FROM ${NATIVE_CONFIG_SCOPE_TABLE} WHERE workspace_id=?`, [workspaceId]);
  if (row && row.status !== "ready" && row.status !== "blocked") throw nativeConfigStateError("native_configuration_scope_invalid", workspaceId);
  return row;
}
function save(db: SqliteHandle, workspaceId: string, configJson: string, updatedAt: number) {
  db.run(`INSERT INTO ${NATIVE_CONFIG_TABLE}(workspace_id,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`, [workspaceId, configJson, updatedAt]);
  db.run(`INSERT INTO ${NATIVE_CONFIG_SCOPE_TABLE}(workspace_id,status,source_hash) VALUES(?,'ready',NULL) ON CONFLICT(workspace_id) DO UPDATE SET status='ready',source_hash=NULL`, [workspaceId]);
}

/** Bootstrap is the only operation permitted to read retired settings. Normal
 * connections accept current state or initialize a genuinely fresh profile. */
export async function openNativeConfigState(databasePath: string, importLegacy?: LegacyConfigurationImport,
  repairNative?: (workspaceId: string, source: string) => ReturnType<LegacyConfigurationImport> | undefined) {
  const markerPath = nativeConfigStatePath(databasePath);
  let marker = await readMarker(markerPath);
  let file;
  try { file = await lstat(databasePath); }
  catch (error) { if (!absent(error)) throw error; }
  if (file && (!file.isFile() || file.isSymbolicLink())) throw nativeConfigStateError("native_configuration_database_invalid");
  if (marker && !file) throw nativeConfigStateError("native_configuration_database_missing");
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = await openSqlite(databasePath);
  try {
    if (!file) await chmod(databasePath, 0o600);
    // Match the other runtime.sqlite stores when two app processes save at
    // once. Completed-state readers do not acquire a writer lock at all.
    db.exec("PRAGMA busy_timeout=5000");
    const verifyCompleted = () => {
      completeTables(db);
      const saved = state(db, true);
      // Another process may have completed publication while this process
      // waited for the first bootstrap transaction.
      if (!marker) marker = readMarkerSync(markerPath);
      if (marker && saved.profileID !== marker.profileID) throw nativeConfigStateError("native_configuration_profile_mismatch");
      if (!marker && db.get(`SELECT completed FROM ${stateTable} WHERE id=1`)?.completed === 1) throw nativeConfigStateError("native_configuration_marker_missing");
    };
    if (tableNames(db).has(stateTable)) verifyCompleted();
    else transaction(db, () => {
      const existing = tableNames(db);
      if (existing.has(stateTable)) {
        verifyCompleted();
        return;
      }
      if (marker || tables.some(table => existing.has(table))) throw nativeConfigStateError("native_configuration_state_missing");
      if ((existing.has("runtime_opencode_configs") || existing.has("runtime_opencode_config_upgrade_backups")) && !importLegacy) throw nativeConfigStateError("legacy_configuration_import_required");
      if (existing.has("runtime_opencode_config_upgrade_backups") && !existing.has("runtime_opencode_configs")) throw nativeConfigStateError("legacy_configuration_source_missing");
      db.exec(`CREATE TABLE ${stateTable}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,profile_id TEXT NOT NULL,completed INTEGER NOT NULL);
        CREATE TABLE ${NATIVE_CONFIG_TABLE}(workspace_id TEXT PRIMARY KEY NOT NULL,config_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE ${NATIVE_CONFIG_SCOPE_TABLE}(workspace_id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL CHECK(status IN ('ready','blocked')),source_hash TEXT);
        CREATE TABLE ${backupTable}(workspace_id TEXT NOT NULL,source_hash TEXT NOT NULL,source_version INTEGER NOT NULL,config_json TEXT NOT NULL,notices_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,source_hash));`);
      if (existing.has("runtime_opencode_config_upgrade_backups")) {
        for (const row of db.all("SELECT workspace_id,source_version,config_json,notices_json,created_at FROM runtime_opencode_config_upgrade_backups")) {
          if (typeof row.workspace_id !== "string" || typeof row.source_version !== "number" || typeof row.config_json !== "string" || typeof row.notices_json !== "string" || typeof row.created_at !== "number") throw nativeConfigStateError("legacy_configuration_backup_invalid");
          original(db, row.workspace_id, row.config_json, row.source_version, row.notices_json, row.created_at);
        }
      }
      if (existing.has("runtime_opencode_configs")) for (const row of db.all("SELECT workspace_id,config_json,updated_at FROM runtime_opencode_configs")) {
        if (typeof row.workspace_id !== "string" || typeof row.config_json !== "string" || typeof row.updated_at !== "number" || !importLegacy) throw nativeConfigStateError("legacy_configuration_source_invalid");
        const now = Date.now();
        let imported;
        try { imported = importLegacy(row.workspace_id, row.config_json); }
        catch {
          original(db, row.workspace_id, row.config_json, -1, "[]", now);
          db.run(`INSERT INTO ${NATIVE_CONFIG_SCOPE_TABLE}(workspace_id,status,source_hash) VALUES(?,'blocked',?)`, [row.workspace_id, hash(row.config_json)]);
          continue;
        }
        original(db, row.workspace_id, row.config_json, imported.sourceVersion, imported.noticesJson, now);
        save(db, row.workspace_id, imported.configJson, row.updated_at);
      }
      db.run(`INSERT INTO ${stateTable}(id,version,profile_id,completed) VALUES(1,2,?,0)`, [randomUUID()]);
    });
    const saved = state(db, true);
    if (!marker || db.get(`SELECT completed FROM ${stateTable} WHERE id=1`)?.completed === 0) transaction(db, () => {
      const published = readMarkerSync(markerPath);
      if (published && published.profileID !== saved.profileID) throw nativeConfigStateError("native_configuration_profile_mismatch");
      if (!published) {
        if (db.get(`SELECT completed FROM ${stateTable} WHERE id=1`)?.completed !== 0) throw nativeConfigStateError("native_configuration_marker_missing");
        replaceMarker(markerPath, saved);
      }
      db.run(`UPDATE ${stateTable} SET completed=1 WHERE id=1`);
    });
    const identity = lstatSync(databasePath, { bigint: true });
    const assertCurrent = () => {
      let current;
      try { current = lstatSync(databasePath, { bigint: true }); }
      catch { throw nativeConfigStateError("native_configuration_database_missing"); }
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw nativeConfigStateError("native_configuration_database_replaced");
      completeTables(db);
      if (state(db).profileID !== saved.profileID) throw nativeConfigStateError("native_configuration_profile_mismatch");
    };
    const source = (workspaceId: string): ConfigurationRow | undefined => {
      assertCurrent();
      const selected = scope(db, workspaceId), row = nativeRow(db, workspaceId);
      if (selected?.status === "blocked") {
        if (row) throw nativeConfigStateError("native_configuration_scope_invalid", workspaceId);
        const backup = db.get(`SELECT config_json AS configJson FROM ${backupTable} WHERE workspace_id=? AND source_hash=?`, [workspaceId, String(selected.sourceHash)]);
        if (!backup || typeof backup.configJson !== "string") throw nativeConfigStateError("native_configuration_backup_missing", workspaceId);
        return { configJson: backup.configJson };
      }
      if (Boolean(selected) !== Boolean(row)) throw nativeConfigStateError("native_configuration_row_missing", workspaceId);
      return row;
    };
    const component = (id: string, complete: boolean): "new" | "pending" | "complete" => {
      if (!/^[a-z][a-z0-9.-]*$/.test(id)) throw new Error("A native storage component requires its registered identifier.");
      assertCurrent();
      // The short critical section uses synchronous file publication while a
      // SQLite writer transaction serializes both Node and Bun processes. No
      // event-loop await holds this lock or loses a sibling completion update.
      return transaction(db, () => {
        const current = readMarkerSync(markerPath);
        if (!current) throw nativeConfigStateError("native_configuration_marker_missing");
        if (current.profileID !== saved.profileID) throw nativeConfigStateError("native_configuration_profile_mismatch");
        const previous = current.components[id];
        if (complete && previous === undefined) throw nativeConfigStateError("native_configuration_component_not_begun");
        const next = complete ? "complete" : previous ?? "pending";
        if (next !== previous) replaceMarker(markerPath, { ...current, components: { ...current.components, [id]: next } });
        return previous ?? "new";
      });
    };
    // A previous migration build may have held a format it could not yet
    // import. Retry only those immutable private originals at explicit startup;
    // never replay a completed row or consult the retired mutable table.
    if (importLegacy) transaction(db, () => {
      assertCurrent();
      for (const row of db.all(`SELECT s.workspace_id AS workspaceId,b.config_json AS configJson FROM ${NATIVE_CONFIG_SCOPE_TABLE} s JOIN ${backupTable} b ON b.workspace_id=s.workspace_id AND b.source_hash=s.source_hash WHERE s.status='blocked'`)) {
        if (typeof row.workspaceId !== "string" || typeof row.configJson !== "string") throw nativeConfigStateError("native_configuration_backup_missing");
        let imported;
        try { imported = importLegacy(row.workspaceId, row.configJson); } catch { continue; }
        db.run(`UPDATE ${backupTable} SET source_version=?,notices_json=? WHERE workspace_id=? AND source_hash=?`, [imported.sourceVersion, imported.noticesJson, row.workspaceId, hash(row.configJson)]);
        save(db, row.workspaceId, imported.configJson, Date.now());
      }
    });
    // Repair only current rows at the explicit startup boundary. Preserve the
    // exact original and replacement in one transaction, without replaying any
    // retired settings or changing rows the narrow repair cannot validate.
    if (repairNative) transaction(db, () => {
      assertCurrent();
      for (const row of db.all(`SELECT c.workspace_id AS workspaceId,c.config_json AS configJson FROM ${NATIVE_CONFIG_TABLE} c JOIN ${NATIVE_CONFIG_SCOPE_TABLE} s ON s.workspace_id=c.workspace_id WHERE s.status='ready'`)) {
        if (typeof row.workspaceId !== "string" || typeof row.configJson !== "string") throw nativeConfigStateError("native_configuration_row_invalid");
        let repaired;
        try { repaired = repairNative(row.workspaceId, row.configJson); } catch { continue; }
        if (!repaired) continue;
        const now = Date.now();
        original(db, row.workspaceId, row.configJson, repaired.sourceVersion, repaired.noticesJson, now);
        save(db, row.workspaceId, repaired.configJson, now);
      }
    });
    return {
      close: () => db.close(),
      beginComponent: (id: string) => component(id, false),
      completeComponent: (id: string) => { component(id, true); },
      has: (workspaceId: string) => { assertCurrent(); return Boolean(scope(db, workspaceId)); },
      source,
      get: (workspaceId: string) => {
        const row = source(workspaceId);
        if (scope(db, workspaceId)?.status === "blocked") throw nativeConfigStateError("legacy_configuration_import_blocked", workspaceId);
        return row;
      },
      upsert: ({ workspaceId, configJson, updatedAt }: { workspaceId: string; configJson: string; updatedAt: number }) => {
        assertCurrent();
        transaction(db, () => { source(workspaceId); if (scope(db, workspaceId)?.status === "blocked") throw nativeConfigStateError("legacy_configuration_import_blocked", workspaceId); save(db, workspaceId, configJson, updatedAt); });
      },
      upgrade: ({ workspaceId, sourceJson, sourceVersion, configJson, noticesJson, updatedAt }: { workspaceId: string; sourceJson: string; sourceVersion: number; configJson: string; noticesJson: string; updatedAt: number }) => {
        assertCurrent();
        transaction(db, () => {
          if (source(workspaceId)?.configJson !== sourceJson) throw nativeConfigStateError("native_configuration_changed_during_repair", workspaceId);
          original(db, workspaceId, sourceJson, sourceVersion, noticesJson, updatedAt);
          const previous = db.get(`SELECT notices_json AS noticesJson FROM ${backupTable} WHERE workspace_id=? AND source_hash=?`, [workspaceId, hash(sourceJson)]);
          const notes = z.array(z.unknown()).parse(JSON.parse(String(previous?.noticesJson)));
          const additional = z.array(z.unknown()).parse(JSON.parse(noticesJson));
          const merged = [...new Set([...notes, ...additional].map(note => JSON.stringify(note)))].map(note => JSON.parse(note));
          db.run(`UPDATE ${backupTable} SET notices_json=? WHERE workspace_id=? AND source_hash=?`, [JSON.stringify(merged), workspaceId, hash(sourceJson)]);
          save(db, workspaceId, configJson, updatedAt);
        });
      },
      backups: (workspaceId: string): NativeConfigBackup[] => {
        assertCurrent();
        return db.all(`SELECT source_version AS sourceVersion,config_json AS configJson,notices_json AS noticesJson,created_at AS createdAt FROM ${backupTable} WHERE workspace_id=? ORDER BY created_at`, [workspaceId])
          .map(row => z.object({ sourceVersion: z.number(), configJson: z.string(), noticesJson: z.string(), createdAt: z.number() }).strict().parse(row));
      },
    };
  } catch (error) { db.close(); if (error instanceof ApiError) throw error; throw nativeConfigStateError("native_configuration_storage_unavailable"); }
}
