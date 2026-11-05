import { randomBytes } from "node:crypto";
import { openSqlite, type Row, type SqliteHandle } from "./runtime-db.js";
import { ApiError } from "./errors.js";
import { SavedSearchInputSchema, type LauncherCatalogEntry, type SavedSearch, type SavedSearchInput } from "@legalwork/types/launcher";

/** Saved searches: a name over a query, an optional category and an optional project, shared by every entry point. */
export class SavedSearchStore {
  private constructor(private db: SqliteHandle) {}
  static async open(path: string) {
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS launcher_saved_searches (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, used_at INTEGER, uses INTEGER NOT NULL DEFAULT 0)");
    return new SavedSearchStore(db);
  }
  private item(row: Row): SavedSearch {
    return { ...SavedSearchInputSchema.parse(JSON.parse(String(row.data))), id: String(row.id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), usedAt: row.used_at === null || row.used_at === undefined ? null : Number(row.used_at), uses: Number(row.uses) };
  }
  list(): SavedSearch[] {
    return this.db.all("SELECT * FROM launcher_saved_searches ORDER BY used_at DESC NULLS LAST, updated_at DESC").map(row => this.item(row));
  }
  get(id: string): SavedSearch | null {
    const row = this.db.get("SELECT * FROM launcher_saved_searches WHERE id = ?", [id]);
    return row ? this.item(row) : null;
  }
  create(input: SavedSearchInput, now = Date.now()): SavedSearch {
    const parsed = SavedSearchInputSchema.parse(input);
    if (!parsed.query && !parsed.kind && !parsed.projectId) throw new ApiError(400, "saved_search_empty", "A saved search needs words, a category or a project.");
    // The same scope and words saved twice is one search.
    const existing = this.list().find(search => search.query === parsed.query && search.kind === parsed.kind && search.projectId === parsed.projectId
      && (search.sourceKind ?? null) === (parsed.sourceKind ?? null)
      && (search.modifiedAfter ?? null) === (parsed.modifiedAfter ?? null) && [...(search.fileTypes ?? [])].sort().join() === [...(parsed.fileTypes ?? [])].sort().join());
    if (existing) return existing;
    const id = `ss_${randomBytes(6).toString("hex")}`;
    this.db.run("INSERT INTO launcher_saved_searches (id, data, created_at, updated_at, used_at, uses) VALUES (?, ?, ?, ?, NULL, 0)", [id, JSON.stringify(parsed), now, now]);
    const saved = this.get(id);
    if (!saved) throw new ApiError(500, "saved_search_write", "The saved search could not be stored.");
    return saved;
  }
  remove(id: string) {
    if (!this.get(id)) throw new ApiError(404, "saved_search_not_found", "This saved search no longer exists.");
    this.db.run("DELETE FROM launcher_saved_searches WHERE id = ?", [id]);
  }
  recordUse(id: string, now = Date.now()) {
    this.db.run("UPDATE launcher_saved_searches SET used_at = ?, uses = uses + 1 WHERE id = ?", [now, id]);
    return this.get(id);
  }
}

/** Saved searches join the shared catalog as navigation with their scope spelled out in the description. */
export function savedSearchCatalogEntries(searches: SavedSearch[], projectName: (id: string) => string | null): LauncherCatalogEntry[] {
  return searches.map(search => ({
    id: `saved-search:${search.id}`, label: search.name, description: [search.kind ?? "all", search.projectId ? projectName(search.projectId) ?? search.projectId : null, search.query ? `“${search.query}”` : null].filter(Boolean).join(" · "),
    aliases: [], kind: "navigation", source: "saved-search", requires: [], target: "none", outputs: [], workspaceId: search.projectId, shortcut: null, favorite: false, usedAt: search.usedAt, command: null, quickAction: null, savedSearch: search,
  }));
}
