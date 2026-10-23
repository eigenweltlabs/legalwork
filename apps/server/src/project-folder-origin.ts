import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type ProjectFolderOrigin = "created_by_app" | "selected_existing";

async function withStore<T>(config: ServerConfig, run: (db: SqliteHandle) => T): Promise<T> {
  const path = runtimeDbPath(config);
  await mkdir(dirname(path), { recursive: true });
  const db = await openSqlite(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_folder_origins (
      workspace_id TEXT PRIMARY KEY, path TEXT NOT NULL, canonical TEXT NOT NULL,
      device TEXT NOT NULL, inode TEXT NOT NULL, birthtime REAL NOT NULL, origin TEXT NOT NULL
    )`);
    return run(db);
  } finally { db.close(); }
}

// Host-local evidence, not editable project metadata that can arrive through sync.
export async function recordProjectFolderOrigin(config: ServerConfig, workspace: Pick<WorkspaceInfo, "id" | "path">, origin: ProjectFolderOrigin) {
  const info = await lstat(workspace.path), canonical = await realpath(workspace.path);
  await withStore(config, db => db.run("INSERT OR REPLACE INTO project_folder_origins (workspace_id, path, canonical, device, inode, birthtime, origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [workspace.id, resolve(workspace.path), canonical, String(info.dev), String(info.ino), info.birthtimeMs, origin]));
}

export async function projectFolderOrigin(config: ServerConfig, workspace: Pick<WorkspaceInfo, "id" | "path">): Promise<ProjectFolderOrigin | "unknown" | "changed"> {
  const saved = await withStore(config, db => db.get("SELECT * FROM project_folder_origins WHERE workspace_id = ?", [workspace.id]));
  if (!saved) return "unknown";
  if (saved.path !== resolve(workspace.path)) return "changed";
  const info = await lstat(workspace.path).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  // A replaced folder is not legacy data: it must not inherit deletion rights
  // through the location-based fallback for projects without a record.
  if (!info?.isDirectory() || info.isSymbolicLink() || saved.canonical !== await realpath(workspace.path)
    || saved.device !== String(info.dev) || saved.inode !== String(info.ino) || saved.birthtime !== info.birthtimeMs) return "changed";
  return saved.origin === "created_by_app" || saved.origin === "selected_existing" ? saved.origin : "changed";
}
