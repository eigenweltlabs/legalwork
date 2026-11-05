import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { canonicalFilePath, withFileWriteLock } from "./file-write-lock.js";
import { engineStorageDir } from "./engine-storage.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import { importLegacySessionPermissionRules } from "./session-history-permissions.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root: string, path: string) => { const suffix = relative(root, path); return !suffix || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`); };
const saved = z.object({ action: z.string().min(1), resource: z.string().min(1), createdAt: z.number().finite(), updatedAt: z.number().finite() });
const migrationSchema = z.object({
  version: z.literal(1), source: z.string(), sourceHash: z.string(), backup: z.string(), sourceRows: z.number().int().nonnegative(),
  imports: z.array(saved.extend({ id: z.string(), workspaceID: z.string() })),
  unresolved: z.array(z.object({ sourceRow: z.number().int().nonnegative(), reason: z.enum(["unknown_project", "shared_project", "global_project", "invalid_saved_policy", "non_allow_saved_policy"]) })),
}).strict();
export type SavedNativeApprovalMigration = z.infer<typeof migrationSchema>;
const receiptSchema = z.object({ version: z.literal(1), sourceHash: z.string(), backup: z.string(), imported: z.number().int().nonnegative(), reconfirm: z.number().int().nonnegative(), activatedAt: z.number() }).strict();
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const pendingPath = (prepared: SavedNativeApprovalMigration) => `${prepared.backup}.pending.json`;
const receiptPath = (prepared: SavedNativeApprovalMigration) => `${prepared.backup}.activated.json`;
async function atomicPrivateJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
async function originalArchived(prepared: SavedNativeApprovalMigration) {
  const archived: unknown = JSON.parse(await readFile(prepared.backup, "utf8"));
  if (!archived || typeof archived !== "object" || !("original" in archived) || !("source" in archived) || archived.source !== prepared.source
    || hash(archived.original) !== prepared.sourceHash) throw new Error("The exact original saved permissions are not safely archived.");
}
async function completed(prepared: SavedNativeApprovalMigration) {
  try {
    const receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath(prepared), "utf8")));
    if (receipt.sourceHash !== prepared.sourceHash || receipt.backup !== prepared.backup) throw new Error("Saved permission migration receipt does not match its original.");
    return receipt;
  } catch (error) { if (absent(error)) return; throw error; }
}
async function finish(prepared: SavedNativeApprovalMigration) {
  await atomicPrivateJson(receiptPath(prepared), { version: 1, sourceHash: prepared.sourceHash, backup: prepared.backup,
    imported: prepared.imports.length, reconfirm: prepared.unresolved.length, activatedAt: Date.now() });
  await rm(pendingPath(prepared), { force: true });
}


type Snapshot = { columns: string[]; rows: Array<Record<string, unknown>>; projects: Array<Record<string, unknown>>; directories: Array<Record<string, unknown>> };
async function snapshot(path: string): Promise<Snapshot> {
  const db = await openSqliteReadonly(path);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
    if (!tables.has("permission")) return { columns: [], rows: [], projects: [], directories: [] };
    const columns = db.all("PRAGMA table_info(permission)").map(row => String(row.name));
    if (!columns.includes("project_id") || !columns.includes("data") && !["id", "action", "resource", "time_created", "time_updated"].every(column => columns.includes(column))) throw new Error("The existing saved-permission database has an unsupported schema; it was not changed.");
    const directories = ["worktree", "project_directory"].flatMap(table => tables.has(table) ? db.all(`SELECT project_id,directory FROM ${table}`) : []);
    return { columns, rows: db.all("SELECT * FROM permission ORDER BY project_id"), projects: tables.has("project") ? db.all("SELECT id,worktree FROM project") : [], directories };
  } finally { db.close(); }
}

/** Read-only inventory and exact private archive. No engine or app grant is
 * changed until the caller explicitly activates the prepared migration. */
export async function prepareNativeSavedApprovalMigration(config: ServerConfig, path: string): Promise<SavedNativeApprovalMigration> {
  const source = await canonicalFilePath(path), original = await snapshot(source), sourceHash = hash(original);
  const directory = join(engineStorageDir(config), "saved-permission-originals"), backup = join(directory, `${hash(source)}-${sourceHash}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ version: 1, source, sourceHash, original }) + "\n";
  try {
    const file = await open(backup, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  if (await readFile(backup, "utf8") !== content) throw new Error("The saved-permission original archive failed verification.");
  const workspaces = await Promise.all(config.workspaces.map(async workspace => ({ id: workspace.id, directory: await canonicalFilePath(workspace.directory?.trim() || workspace.path) })));
  const result: SavedNativeApprovalMigration = { version: 1, source, sourceHash, backup, sourceRows: original.rows.length, imports: [], unresolved: [] };
  for (const [sourceRow, row] of original.rows.entries()) {
    const project = original.projects.find(project => project.id === row.project_id);
    if (row.project_id === "global" || project?.worktree === "/") { result.unresolved.push({ sourceRow, reason: "global_project" }); continue; }
    if (!project || typeof project.worktree !== "string") { result.unresolved.push({ sourceRow, reason: "unknown_project" }); continue; }
    const roots = [...new Set(await Promise.all([project.worktree, ...original.directories.filter(item => item.project_id === row.project_id).map(item => item.directory)]
      .filter((directory): directory is string => typeof directory === "string").map(canonicalFilePath)))];
    const candidates = workspaces.filter(workspace => roots.some(root => within(root, workspace.directory)));
    // A native Git project may contain more than one LegalWork project. Its old
    // grant contains no originating chat ID, so never guess a narrower owner.
    if (candidates.length !== 1 || !roots.every(root => root === candidates[0]?.directory)) {
      result.unresolved.push({ sourceRow, reason: candidates.length ? "shared_project" : "unknown_project" }); continue;
    }
    let records: Array<z.infer<typeof saved>>;
    try {
      if (original.columns.includes("data")) {
        const rules = importLegacySessionPermissionRules(JSON.parse(String(row.data)));
        if (rules.some(rule => rule.effect !== "allow")) { result.unresolved.push({ sourceRow, reason: "non_allow_saved_policy" }); continue; }
        records = rules.map(rule => saved.parse({ action: rule.action, resource: rule.resource, createdAt: row.time_created, updatedAt: row.time_updated }));
      } else records = [saved.parse({ action: row.action, resource: row.resource, createdAt: row.time_created, updatedAt: row.time_updated })];
    } catch { result.unresolved.push({ sourceRow, reason: "invalid_saved_policy" }); continue; }
    for (const record of records) result.imports.push({ ...record, workspaceID: candidates[0].id, id: `psv_${hash([source, row.project_id, row.id ?? row.data, record.action, record.resource])}` });
  }
  return result;
}

/** The engine must be stopped. Explicit reconfirmation is required for old
 * grants whose LegalWork owner cannot be proved; originals remain private. */
export async function activateNativeSavedApprovalMigration(config: ServerConfig, prepared: SavedNativeApprovalMigration,
  choice: { ambiguous: "hold" | "reconfirm" }): Promise<{ imported: number; reconfirm: number }> {
  return withFileWriteLock(`${prepared.source}.legalwork-saved-permissions.lock`, async () => {
    const original = await snapshot(prepared.source);
    if (hash(original) !== prepared.sourceHash) throw new Error("Saved permissions changed since review; prepare their migration again.");
    await originalArchived(prepared);
    if (prepared.unresolved.some(item => item.reason === "invalid_saved_policy" || item.reason === "non_allow_saved_policy")) throw new Error("An existing saved policy needs explicit resolution before the engine can start; its original is preserved.");
    if (prepared.unresolved.length && choice.ambiguous !== "reconfirm") throw new Error("Some older saved approvals have no unique LegalWork project; choose reconfirmation before starting the engine.");
    const imported = await prepareNativeSavedApprovalMigration(config, prepared.source);
    if (JSON.stringify(migrationSchema.parse(imported)) !== JSON.stringify(migrationSchema.parse(prepared))) throw new Error("The reviewed project ownership changed; prepare saved permissions again.");
    for (const workspaceID of new Set(prepared.imports.map(item => item.workspaceID))) {
      await writeRuntimeOpencodeConfig(config, workspaceID, current => ({ ...current,
        nativeSavedApprovalImportIDs: [...new Set([...current.nativeSavedApprovalImportIDs ?? [], ...prepared.imports.filter(item => item.workspaceID === workspaceID).map(item => item.id)])],
        projectPermissionApprovals: [
          ...current.projectPermissionApprovals ?? [],
          ...prepared.imports.filter(item => item.workspaceID === workspaceID && !current.nativeSavedApprovalImportIDs?.includes(item.id)
            && !(current.projectPermissionApprovals ?? []).some(record => record.id === item.id || record.action === item.action && record.resources.includes(item.resource)))
            .map(item => ({ id: item.id, action: item.action, resources: [item.resource], createdAt: item.createdAt, updatedAt: item.updatedAt })),
        ],
      }));
    }
    // The durable pending receipt is written only after every app-owned grant
    // is committed, before removing its native wider-scope counterpart.
    await atomicPrivateJson(pendingPath(prepared), prepared);
    if (original.rows.length) {
      if (typeof process.versions.bun === "string") {
        const { Database } = await import("bun:sqlite"); const db = new Database(prepared.source);
        try { db.transaction(() => { if (hash(db.query("SELECT * FROM permission ORDER BY project_id").all()) !== hash(original.rows)) throw new Error("Saved permissions changed during migration."); db.exec("DELETE FROM permission"); })(); }
        finally { db.close(); }
      } else {
        const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(prepared.source);
        try { db.exec("BEGIN IMMEDIATE"); if (hash(db.prepare("SELECT * FROM permission ORDER BY project_id").all()) !== hash(original.rows)) throw new Error("Saved permissions changed during migration."); db.exec("DELETE FROM permission; COMMIT"); }
        catch (error) { db.exec("ROLLBACK"); throw error; }
        finally { db.close(); }
      }
    }
    // This receipt is private and deliberately contains no paths or resources
    // in its user-facing count. A future grant asks normally in its project.
    await finish(prepared);
    return { imported: prepared.imports.length, reconfirm: prepared.unresolved.length };
  });
}

/** Lifecycle-only stopped phase. A completed migration is never replayed: later
 * project revocation and once-only chat decisions remain authoritative. */
export async function migrateStoppedNativeSavedApprovals(config: ServerConfig, path: string): Promise<{ changed: boolean; imported: number; reconfirm: number }> {
  try { if (!(await lstat(path)).isFile()) throw new Error("The managed engine database is not a regular file."); }
  catch (error) { if (absent(error)) return { changed: false, imported: 0, reconfirm: 0 }; throw error; }
  const source = await canonicalFilePath(path);
  return withFileWriteLock(`${source}.legalwork-saved-permissions-startup.lock`, async () => {
    let changed = false, imported = 0, reconfirm = 0;
    const directory = join(engineStorageDir(config), "saved-permission-originals"), prefix = `${hash(source)}-`;
    const files = await readdir(directory).catch(error => { if (absent(error)) return []; throw error; });
    for (const name of files.filter(name => name.startsWith(prefix) && name.endsWith(".json.pending.json")).sort()) {
      const prepared = migrationSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (prepared.source !== source || pendingPath(prepared) !== join(directory, name)) throw new Error("Interrupted saved permissions belong to a different engine database.");
      await originalArchived(prepared);
      if (await completed(prepared)) { await rm(pendingPath(prepared), { force: true }); continue; }
      const current = await snapshot(source);
      if (current.rows.length) {
        if (hash(current) !== prepared.sourceHash) throw new Error("Saved permissions changed during interrupted migration. Their originals are preserved; resolve this before restarting the engine.");
        await activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" });
      } else {
        // A crash after deletion must not re-grant anything. Verify that the
        // earlier durable application writes still exist, then finish only.
        for (const item of prepared.imports) {
          const settings = await readRuntimeOpencodeConfig(config, item.workspaceID);
          if (!settings.nativeSavedApprovalImportIDs?.includes(item.id))
            throw new Error("An imported project approval receipt is unavailable after interrupted migration. Its original is preserved; resolve it before restarting the engine.");
        }
        await finish(prepared);
      }
      changed = true; imported += prepared.imports.length; reconfirm += prepared.unresolved.length;
    }
    if ((await snapshot(source)).rows.length) {
      const prepared = await prepareNativeSavedApprovalMigration(config, source);
      const result = await activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" });
      changed = true; imported += result.imported; reconfirm += result.reconfirm;
    }
    if (reconfirm) {
      const message = "Some older saved approvals could not be matched to one LegalWork project. Their originals were preserved privately; LegalWork will ask before granting that access in a project.";
      config.workspaceWarnings = [...new Set([...config.workspaceWarnings ?? [], message])];
    }
    return { changed, imported, reconfirm };
  });
}
