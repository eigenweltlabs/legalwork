import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { LauncherSearchFolderSchema, type LauncherSearchFolder } from "@legalwork/types/launcher";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import { ApiError } from "./errors.js";

/** Explicit read/search roots, never agent workspaces or execution targets. */
export class LauncherFolders {
  private constructor(private db: SqliteHandle) {}
  static async open(path: string) {
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS launcher_search_folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
    return new LauncherFolders(db);
  }
  list(): LauncherSearchFolder[] { return this.db.all("SELECT data FROM launcher_search_folders ORDER BY rowid").map(row => LauncherSearchFolderSchema.parse(JSON.parse(String(row.data)))); }
  get(id: string) {
    const folder = this.list().find(item => item.id === id);
    if (!folder) throw new ApiError(404, "search_folder_missing", "This search folder was removed.");
    return folder;
  }
  async add(path: string, name?: string) {
    if (!isAbsolute(path)) throw new ApiError(400, "search_folder_path", "Choose an absolute folder path on this server.");
    const canonical = await realpath(path).catch(() => null);
    if (!canonical || !(await stat(canonical)).isDirectory()) throw new ApiError(400, "search_folder_path", "Choose an available folder.");
    const existing = this.list().find(folder => folder.path === canonical);
    if (existing) return existing;
    if (this.list().length >= 32) throw new ApiError(400, "search_folder_limit", "Remove a search folder before adding another (maximum 32).");
    const folder: LauncherSearchFolder = { id: `folder_${randomUUID()}`, path: canonical, name: name?.trim() || basename(canonical) || canonical, createdAt: Date.now() };
    this.db.run("INSERT OR IGNORE INTO launcher_search_folders (id, path, data) VALUES (?, ?, ?)", [folder.id, canonical, JSON.stringify(folder)]);
    return this.list().find(item => item.path === canonical) ?? folder;
  }
  remove(id: string) { this.get(id); this.db.run("DELETE FROM launcher_search_folders WHERE id = ?", [id]); }
  async root(id: string) {
    const folder = this.get(id);
    const actual = await realpath(folder.path).catch(() => null);
    if (actual !== folder.path || !(await stat(folder.path).catch(() => null))?.isDirectory()) throw new ApiError(404, "search_folder_unavailable", "This search folder is unavailable or its location changed. Add it again to use the new location.");
    return folder;
  }
  async file(id: string, path: string) {
    const folder = await this.root(id);
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".")) throw new ApiError(400, "search_folder_file", "Choose a file inside the search folder.");
    const absolute = await realpath(resolve(folder.path, path)).catch(() => null);
    if (!absolute || !absolute.startsWith(folder.path.endsWith(sep) ? folder.path : folder.path + sep)) throw new ApiError(400, "search_folder_file", "The file is outside the search folder.");
    const info = await stat(absolute);
    if (!info.isFile()) throw new ApiError(404, "search_folder_file", "File not found.");
    return { folder, absolute, info };
  }
}
