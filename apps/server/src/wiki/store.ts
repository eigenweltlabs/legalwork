import { captureWikiViews } from "./view-snapshots.js";
import { ViewInputSchema } from "../views/schema.js";
import type { WikiViewSnapshots } from "@legalwork/types/views";
import { lineChanges } from "./line-diff.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { chmod, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { WikiGraphResponse, WikiAsset, WikiCreateInput, WikiDocument, WikiEntry, WikiEntryOperation, WikiPage, WikiRegistration, WikiRevision, WikiSnapshot, WikiSyncStatus, WikiTrashEntry, WikiUpdateInput } from "@legalwork/types/wiki";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { workspaceIdForPath } from "../workspaces.js";
import { markdownData, markdownWithData, parseWikiPage, resolveWikiLinks } from "./markdown.js";
import { createWikiStarterFiles } from "./templates.js";
import { WikiGraphIndex } from "./graph.js";
import { patchWikiProperties, type WikiPropertiesPatch } from "./properties.js";
import { assertWikiFoldersIndependent, canonicalFolderPath } from "./workspace-safety.js";

export const WIKI_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const WIKI_MAX_ASSET_BYTES = 100 * 1024 * 1024;
const legacySyncSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096).refine(isWikiPath, "Use a dedicated relative folder path."),
});
export const wikiTeamSyncSchema = z.object({ kind: z.literal("team"), wikiId: z.string().uuid(), orgId: z.string().min(1).max(200) });
export const wikiSyncSchema = z.union([wikiTeamSyncSchema, legacySyncSchema]);
const registrationSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200), root: z.string().min(1),
  workspaceId: z.string().min(1), allowInProjects: z.boolean(), projectWorkspaceIds: z.array(z.string().min(1).max(200)).max(1000).nullable().optional(), sync: wikiSyncSchema.nullable(),
});
const deletedWikiSchema = z.object({ wiki: registrationSchema, deletedAt: z.number() });
const indexRowSchema = z.object({
  path: z.string(), content: z.string(), revision: z.string(), mtime: z.number(), ctime: z.number(),
  size: z.number(), updatedAt: z.number(), warning: z.string().nullable(),
});
const revisionRowSchema = z.object({ id: z.string(), path: z.string(), createdAt: z.number(), action: z.enum(["write", "delete", "restore"]), size: z.number() });
const snapshotMetadataSchema = z.record(z.string(), z.record(z.string(), ViewInputSchema.shape.datasets.unwrap().valueType.pick({ revision: true, asOf: true, nextCursor: true })));

/** Keep observation metadata per revision, while sharing unchanged programs and data rows. */
function snapshotStorage(snapshots: WikiViewSnapshots) {
  const payload: WikiViewSnapshots = {}, metadata: z.infer<typeof snapshotMetadataSchema> = {};
  for (const [key, input] of Object.entries(snapshots)) {
    payload[key] = { ...input };
    metadata[key] = {};
    if (!input.datasets) continue;
    payload[key].datasets = {};
    for (const [name, dataset] of Object.entries(input.datasets)) {
      const { revision, asOf, nextCursor, ...data } = dataset;
      payload[key].datasets[name] = { ...data, revision: "snapshot", asOf: 0 };
      metadata[key][name] = { revision, asOf, ...(nextCursor ? { nextCursor } : {}) };
    }
  }
  const content = JSON.stringify(payload), id = hash(content);
  return { content, metadata: JSON.stringify(metadata), id };
}
const trashSchema = z.object({ id: z.string().uuid(), path: z.string().refine(isWikiPath), kind: z.enum(["file", "folder"]), deletedAt: z.number() });
type IndexedPage = Omit<z.infer<typeof indexRowSchema>, "warning"> & ReturnType<typeof parseWikiPage>;
type GraphState = { index: WikiGraphIndex; watcher?: FSWatcher; changed: Set<string>; reconcile: boolean; dirty: boolean; lastScan: number; contentRevision: string; configuration: string };
type SqlValue = string | number | null;
type Sqlite = { run(sql: string, values?: SqlValue[]): void; all(sql: string, values?: SqlValue[]): unknown[]; close(): void; exec(sql: string): void };
const pending = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
function entryError(error: unknown): never {
  if (missing(error)) throw new ApiError(404, "wiki_entry_not_found", "This file or folder is unavailable. Refresh the wiki and try again.");
  if (error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"].includes(String(error.code))) throw new ApiError(409, "wiki_entry_exists", "A file or folder already exists at this destination. Choose another name or folder.");
  throw error;
}
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

export function isWikiPath(path: string): boolean {
  return Boolean(path) && path.length <= 4096 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
}
export function wikiPath(path: string): string {
  if (!isWikiPath(path)) throw new ApiError(400, "invalid_wiki_path", "Use a relative path without hidden files, traversal, or backslashes.");
  return path;
}
const isMarkdown = (path: string) => /\.md$/i.test(path);

async function openSqlite(path: string): Promise<Sqlite> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    return { run: (sql, values = []) => { db.query(sql).run(...values); }, all: (sql, values = []) => db.query(sql).all(...values), exec: (sql) => { db.exec(sql); }, close: () => db.close(true) };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return { run: (sql, values = []) => { db.prepare(sql).run(...values); }, all: (sql, values = []) => db.prepare(sql).all(...values), exec: (sql) => { db.exec(sql); }, close: () => db.close() };
}

/** Portable authored files live in the wiki. Registration, cache and durable history stay on this host. */
export class WikiStore {
  readonly path: string;
  readonly baseDir: string;
  private readonly config: ServerConfig;
  private database: Promise<Sqlite> | undefined;
  private readonly indexes = new Map<string, Map<string, IndexedPage>>();
  private readonly graphs = new Map<string, GraphState>();
  private readonly inventoryRevisions = new Map<string, string>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.baseDir = config.configPath ? dirname(resolve(config.configPath)) : join(homedir(), ".config", "legalwork");
    this.path = join(this.baseDir, "wikis.md");
  }
  private async db(): Promise<Sqlite> {
    if (!this.database) this.database = (async () => {
      await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
      const databasePath = join(this.baseDir, "wiki-state.sqlite");
      const db = await openSqlite(databasePath);
      await chmod(databasePath, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS wiki_pages (wiki TEXT NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,revision TEXT NOT NULL,mtime REAL NOT NULL,ctime REAL NOT NULL,size INTEGER NOT NULL,updatedAt REAL NOT NULL,warning TEXT, PRIMARY KEY(wiki,path));
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_search USING fts5(wiki UNINDEXED,path UNINDEXED,title,body);
        CREATE TABLE IF NOT EXISTS wiki_history (id TEXT PRIMARY KEY,wiki TEXT NOT NULL,path TEXT NOT NULL,createdAt REAL NOT NULL,action TEXT NOT NULL,size INTEGER NOT NULL,content TEXT NOT NULL,revision TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wiki_history_views (historyId TEXT PRIMARY KEY,content TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wiki_view_snapshots (id TEXT PRIMARY KEY,content TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wiki_history_view_links (historyId TEXT PRIMARY KEY,snapshot TEXT NOT NULL,metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wiki_history_changes (historyId TEXT PRIMARY KEY,added INTEGER,removed INTEGER);
        CREATE TABLE IF NOT EXISTS wiki_folders (root TEXT PRIMARY KEY,id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS wiki_history_path ON wiki_history(wiki,path,createdAt DESC);`);
      return db;
    })();
    return this.database;
  }
  async close(): Promise<void> { if (this.database) (await this.database).close(); this.database = undefined; this.indexes.clear(); for (const state of this.graphs.values()) state.watcher?.close(); this.graphs.clear(); this.inventoryRevisions.clear(); }

  private registerWorkspace(wiki: WikiRegistration): void {
    if (!this.config.workspaces.some((workspace) => workspace.id === wiki.workspaceId)) {
      this.config.workspaces.push({ id: wiki.workspaceId, name: wiki.name, path: wiki.root, preset: "wiki", workspaceType: "local" });
    }
    if (!this.config.authorizedRoots.includes(wiki.root)) this.config.authorizedRoots.push(wiki.root);
  }
  async list(): Promise<WikiRegistration[]> {
    try {
      const content = await readFile(this.path, "utf8");
      const { data, warning } = markdownData(content);
      if (warning) throw new Error(warning);
      const items = z.array(registrationSchema).parse(data.wikis ?? []);
      await assertWikiFoldersIndependent(items, this.config.workspaces);
      for (const wiki of items) this.registerWorkspace(wiki);
      return items;
    } catch (error) {
      if (missing(error)) return [];
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "wiki_registry_unreadable", "The saved wiki registry could not be read. Check wikis.md in the LegalWork configuration folder.");
    }
  }
  async get(id: string): Promise<WikiRegistration> {
    const wiki = (await this.list()).find((item) => item.id === id);
    if (!wiki) throw new ApiError(404, "wiki_not_found", "This wiki is no longer registered on this server.");
    return wiki;
  }
  async deleted() {
    try {
      const { data, warning } = markdownData(await readFile(this.path, "utf8"));
      if (warning) throw new Error(warning);
      return z.array(deletedWikiSchema).parse(data.deleted ?? []);
    } catch (error) {
      if (missing(error)) return [];
      throw new ApiError(500, "wiki_registry_unreadable", "The saved wiki registry could not be read.");
    }
  }
  private async saveRegistrations(items: WikiRegistration[], deleted?: z.infer<typeof deletedWikiSchema>[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    let original = "# Wikis\n\nThis file registers wiki folders on this computer. The content remains in those folders.\n";
    try { original = await readFile(this.path, "utf8"); } catch (error) { if (!missing(error)) throw error; }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, markdownWithData(original, { wikis: items, ...(deleted ? { deleted } : {}) }), { mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  async create(input: WikiCreateInput): Promise<WikiRegistration> {
    return serial(this.path, async () => {
      const name = input.name.trim();
      if (!name || name.length > 200) throw new ApiError(400, "invalid_wiki_name", "Give the wiki a name of at most 200 characters.");
      const items = await this.list(), newId = randomUUID();
      const root = resolve(input.root?.trim() || join(this.baseDir, "wikis", newId));
      if (root === this.baseDir || this.baseDir.startsWith(`${root}${sep}`)) throw new ApiError(400, "invalid_wiki_root", "Choose a content folder outside the LegalWork configuration files.");
      if (items.some((wiki) => root === wiki.root || root.startsWith(`${wiki.root}${sep}`) || wiki.root.startsWith(`${root}${sep}`))) {
        throw new ApiError(409, "wiki_root_registered", "This folder, or a containing folder, is already a wiki.");
      }
      const pendingRoot = await canonicalFolderPath(root);
      if ((await this.deleted()).some(item => item.wiki.root === pendingRoot || pendingRoot.startsWith(`${item.wiki.root}${sep}`) || item.wiki.root.startsWith(`${pendingRoot}${sep}`)))
        throw new ApiError(409, "wiki_root_deleted", "Restore this wiki from Recently deleted before using its folder again.");
      await assertWikiFoldersIndependent([...items, { id: newId, name, root: pendingRoot, workspaceId: workspaceIdForPath(pendingRoot), allowInProjects: true, sync: input.sync ?? null }], this.config.workspaces);
      await mkdir(root, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new ApiError(403, "unsafe_wiki_path", "Wiki folders cannot be symbolic links.");
      const canonicalRoot = await realpath(root);
      await this.safeRoot(canonicalRoot);
      if (items.some((wiki) => canonicalRoot === wiki.root)) throw new ApiError(409, "wiki_root_registered", "This folder is already a wiki.");
      const db = await this.db();
      const knownFolder = z.object({ id: z.string().uuid() }).optional().parse(db.all("SELECT id FROM wiki_folders WHERE root=?", [canonicalRoot])[0]);
      const id = knownFolder?.id ?? newId;
      db.run("INSERT OR REPLACE INTO wiki_folders(root,id) VALUES(?,?)", [canonicalRoot, id]);
      const wiki: WikiRegistration = { id, name, root: canonicalRoot, workspaceId: workspaceIdForPath(canonicalRoot), allowInProjects: true, sync: input.sync ?? null };
      for (const [path, content] of Object.entries(input.attach ? {} : createWikiStarterFiles(input.template ?? "blank", name))) {
        const target = await this.safePath(wiki, path, true);
        try { await writeFile(target, path === "Wiki.md" ? markdownWithData(content, { name }) : content, { flag: "wx" }); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      }
      await this.saveRegistrations([...items, wiki]);
      this.registerWorkspace(wiki);
      return wiki;
    });
  }
  async update(id: string, input: WikiUpdateInput): Promise<WikiRegistration> {
    return serial(this.path, async () => {
      const items = await this.list(), current = items.find((item) => item.id === id);
      if (!current) throw new ApiError(404, "wiki_not_found", "This wiki is no longer registered.");
      const parsed = registrationSchema.safeParse({ ...current, ...input, name: input.name?.trim() ?? current.name });
      if (!parsed.success) throw new ApiError(400, "invalid_wiki_configuration", "Check the wiki name and sync settings.");
      const wiki = parsed.data;
      await this.saveRegistrations(items.map((item) => item.id === id ? wiki : item));
      const workspace = this.config.workspaces.find((item) => item.id === wiki.workspaceId);
      if (workspace?.preset === "wiki") workspace.name = wiki.name;
      return wiki;
    });
  }
  /** Forgetting a folder never deletes its content or its recovery history. */
  async forget(id: string): Promise<void> {
    await serial(this.path, async () => {
      const items = await this.list(), wiki = items.find((item) => item.id === id);
      if (!wiki) throw new ApiError(404, "wiki_not_found", "This wiki is no longer registered.");
      await this.saveRegistrations(items.filter((item) => item.id !== id));
      this.unregisterWorkspace(wiki);
    });
  }

  private unregisterWorkspace(wiki: WikiRegistration) {
    this.config.workspaces = this.config.workspaces.filter(item => item.id !== wiki.workspaceId || item.preset !== "wiki");
    this.indexes.delete(wiki.id);
    this.graphs.get(wiki.id)?.watcher?.close();
    this.graphs.delete(wiki.id);
    this.inventoryRevisions.delete(wiki.id);
  }

  /** Soft deletion retains the authored files, workspace identity and history for restoration. */
  async archive(id: string): Promise<void> {
    await serial(this.path, async () => {
      const items = await this.list(), deleted = await this.deleted();
      const wiki = items.find(item => item.id === id);
      if (!wiki) {
        if (deleted.some(item => item.wiki.id === id)) return;
        throw new ApiError(404, "wiki_not_found", "This wiki is no longer registered.");
      }
      await this.saveRegistrations(items.filter(item => item.id !== id), [...deleted, { wiki, deletedAt: Date.now() }]);
      this.unregisterWorkspace(wiki);
    });
  }

  async restoreWiki(id: string): Promise<WikiRegistration> {
    return serial(this.path, async () => {
      const items = await this.list(), deleted = await this.deleted();
      const entry = deleted.find(item => item.wiki.id === id);
      if (!entry) throw new ApiError(404, "wiki_not_found", "This wiki is no longer in Recently deleted.");
      await this.safeRoot(entry.wiki.root);
      if (items.some(wiki => wiki.id === id || wiki.root === entry.wiki.root || wiki.root.startsWith(`${entry.wiki.root}${sep}`) || entry.wiki.root.startsWith(`${wiki.root}${sep}`)))
        throw new ApiError(409, "wiki_root_registered", "This folder, or a containing folder, is already a wiki.");
      await assertWikiFoldersIndependent([...items, entry.wiki], this.config.workspaces);
      await this.saveRegistrations([...items, entry.wiki], deleted.filter(item => item.wiki.id !== id));
      this.registerWorkspace(entry.wiki);
      return entry.wiki;
    });
  }

  private async safeRoot(root: string): Promise<void> {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) throw new ApiError(403, "unsafe_wiki_path", "Wiki folders cannot follow symbolic links.");
  }
  private async safePath(wiki: WikiRegistration, path: string, createParents = false): Promise<string> {
    wikiPath(path);
    await this.safeRoot(wiki.root);
    let current = wiki.root;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new ApiError(403, "unsafe_wiki_path", "Wiki paths cannot follow symbolic links or files used as folders.");
      } catch (error) {
        if (!missing(error)) throw error;
        if (createParents && index < parts.length - 1) await mkdir(current, { recursive: false });
      }
    }
    const parent = await realpath(dirname(current)).catch((error: unknown) => { if (!missing(error)) throw error; return dirname(current); });
    if (parent !== wiki.root && !parent.startsWith(`${wiki.root}${sep}`)) throw new ApiError(403, "unsafe_wiki_path", "Wiki files must remain inside the wiki folder.");
    return current;
  }
  private async fileBytes(wiki: WikiRegistration, path: string, maximum: number): Promise<Buffer> {
    const target = await this.safePath(wiki, path);
    let file;
    try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) throw new ApiError(404, "wiki_file_not_found", "This wiki file no longer exists."); throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ApiError(400, "invalid_wiki_file", "Choose a file in the wiki.");
      if (info.size > maximum) throw new ApiError(413, "wiki_file_too_large", `This file exceeds the ${Math.floor(maximum / 1024 / 1024)} MB limit.`);
      return await file.readFile();
    } finally { await file.close(); }
  }
  private async inventory(wiki: WikiRegistration): Promise<{ files: WikiAsset[]; folders: string[]; warnings: string[] }> {
    await this.safeRoot(wiki.root);
    const files: WikiAsset[] = [], folders: string[] = [], warnings: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 32) { warnings.push("Folders deeper than 32 levels were skipped."); return; }
      const canonical = await realpath(directory);
      if (canonical !== directory || (canonical !== wiki.root && !canonical.startsWith(`${wiki.root}${sep}`))) throw new ApiError(403, "unsafe_wiki_path", "Wiki folders cannot follow symbolic links.");
      if (files.length + folders.length >= 250_000) throw new ApiError(413, "wiki_too_many_files", "A wiki can index up to 250,000 files and folders. Split this folder into smaller wikis.");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const absolute = join(directory, entry.name), path = relative(wiki.root, absolute).split(sep).join("/");
        if (entry.isSymbolicLink()) { warnings.push(`${path}: symbolic links are skipped.`); continue; }
        if (!isWikiPath(path)) { warnings.push(`${path}: unsupported filename.`); continue; }
        if (entry.isDirectory()) { folders.push(path); await walk(absolute, depth + 1); continue; }
        if (!entry.isFile()) continue;
        try {
          const info = await lstat(absolute);
          if (info.isSymbolicLink() || !info.isFile()) continue;
          if (files.length >= 250_000) throw new ApiError(413, "wiki_too_many_files", "A wiki can index up to 250,000 files.");
          files.push({ path, size: info.size, updatedAt: info.mtimeMs, changedAt: info.ctimeMs });
        } catch (error) { if (!missing(error)) throw error; }
      }
    };
    await walk(wiki.root, 0);
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), folders: folders.sort(), warnings };
  }
  async files(id: string): Promise<WikiAsset[]> { return (await this.inventory(await this.get(id))).files; }
  private async index(id: string): Promise<Map<string, IndexedPage>> {
    let index = this.indexes.get(id);
    if (!index) {
      index = new Map();
      const rows = await this.db();
      for (const raw of rows.all("SELECT path,content,revision,mtime,ctime,size,updatedAt,warning FROM wiki_pages WHERE wiki=?", [id])) {
        const row = indexRowSchema.parse(raw), parsed = parseWikiPage(row.path, row.content, row.revision, row.updatedAt);
        index.set(row.path, { ...row, ...parsed, warning: parsed.warning });
      }
      this.indexes.set(id, index);
    }
    return index;
  }
  private async record(id: string, path: string, content: string, action: WikiRevision["action"], knownFiles?: WikiAsset[], knownPages?: Map<string, WikiPage>): Promise<void> {
    const db = await this.db(), revision = hash(content);
    const latest = z.object({ action: z.string(), revision: z.string(), content: z.string() }).optional().parse(db.all("SELECT action,revision,content FROM wiki_history WHERE wiki=? AND path=? ORDER BY createdAt DESC,rowid DESC LIMIT 1", [id, path])[0]);
    if (latest?.revision === revision && (latest.action === action || (action === "write" && latest.action !== "delete"))) return;
    const historyId = randomUUID(), createdAt = Date.now();
    const wiki = await this.get(id);
    let inventory = knownFiles;
    const files = async () => inventory ??= (await this.inventory(wiki)).files;
    const snapshots = await captureWikiViews(content, { kind: "wiki", id }, {
      list: async () => (await files()).map(file => file.path),
      read: path => this.fileBytes(wiki, path, WIKI_MAX_PAGE_BYTES),
      write: async () => { throw new Error("Read only"); },
    }, async () => {
      const pages = [], index = await this.index(id);
      for (const file of await files()) {
        if (!isMarkdown(file.path) || file.size > WIKI_MAX_PAGE_BYTES) continue;
        if (file.path === path) {
          pages.push(parseWikiPage(path, content, revision, file.updatedAt).page);
          continue;
        }
        const staged = knownPages?.get(file.path);
        if (staged) { pages.push(staged); continue; }
        const cached = index.get(file.path);
        if (cached && cached.mtime === file.updatedAt && cached.ctime === file.changedAt && cached.size === file.size) {
          pages.push(cached.page);
          continue;
        }
        const bytes = await this.fileBytes(wiki, file.path, WIKI_MAX_PAGE_BYTES);
        pages.push(parseWikiPage(file.path, bytes.toString("utf8"), hash(bytes), file.updatedAt).page);
      }
      return pages;
    });
    const snapshot = Object.keys(snapshots).length ? snapshotStorage(snapshots) : undefined;
    const changes = lineChanges(latest?.action === "delete" ? "" : latest?.content ?? "", action === "delete" ? "" : content);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.run("INSERT INTO wiki_history(id,wiki,path,createdAt,action,size,content,revision) VALUES(?,?,?,?,?,?,?,?)", [historyId, id, path, createdAt, action, Buffer.byteLength(content), content, revision]);
      db.run("INSERT INTO wiki_history_changes(historyId,added,removed) VALUES(?,?,?)", [historyId, changes?.added ?? null, changes?.removed ?? null]);
      if (snapshot) {
        db.run("INSERT OR IGNORE INTO wiki_view_snapshots(id,content) VALUES(?,?)", [snapshot.id, snapshot.content]);
        db.run("INSERT INTO wiki_history_view_links(historyId,snapshot,metadata) VALUES(?,?,?)", [historyId, snapshot.id, snapshot.metadata]);
      }
      // Older builds can still read the page and show embeds as unavailable.
      db.run("INSERT INTO wiki_history_views(historyId,content) VALUES(?,?)", [historyId, "{}"]);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  private async remember(id: string, path: string, content: string, knownWiki?: WikiRegistration, knownFile?: WikiAsset): Promise<IndexedPage> {
    const wiki = knownWiki ?? await this.get(id);
    const info = knownFile ? { mtimeMs: knownFile.updatedAt, ctimeMs: knownFile.changedAt ?? knownFile.updatedAt, size: knownFile.size } : await stat(await this.safePath(wiki, path));
    const revision = hash(content), parsed = parseWikiPage(path, content, revision, info.mtimeMs);
    const row: IndexedPage = { path, content, revision, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, updatedAt: info.mtimeMs, ...parsed };
    const db = await this.db();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.run("INSERT OR REPLACE INTO wiki_pages(wiki,path,content,revision,mtime,ctime,size,updatedAt,warning) VALUES(?,?,?,?,?,?,?,?,?)", [id, path, content, revision, row.mtime, row.ctime, row.size, row.updatedAt, parsed.warning ?? null]);
      db.run("DELETE FROM wiki_search WHERE wiki=? AND path=?", [id, path]);
      db.run("INSERT INTO wiki_search(wiki,path,title,body) VALUES(?,?,?,?)", [id, path, parsed.page.title, content]);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const index = await this.index(id);
    if (index.get(path)?.revision !== revision) {
      const graph = this.graphs.get(id);
      if (graph) { graph.dirty = true; graph.contentRevision = randomUUID(); }
    }
    index.set(path, row);
    return row;
  }
  private async drop(id: string, path: string): Promise<void> {
    const db = await this.db();
    db.run("DELETE FROM wiki_pages WHERE wiki=? AND path=?", [id, path]);
    db.run("DELETE FROM wiki_search WHERE wiki=? AND path=?", [id, path]);
    if ((await this.index(id)).delete(path)) {
      const graph = this.graphs.get(id);
      if (graph) { graph.dirty = true; graph.contentRevision = randomUUID(); }
    }
  }
  private async refresh(id: string): Promise<{ files: WikiAsset[]; folders: string[]; warnings: string[] }> {
    const wiki = await this.get(id), inventory = await this.inventory(wiki), index = await this.index(id);
    const records: { path: string; content: string; action: WikiRevision["action"] }[] = [];
    const pages = new Map([...index].map(([path, row]) => [path, row.page]));
    const changed: { file: WikiAsset; content: string }[] = [], removed: string[] = [];
    const inventoryRevision = hash(JSON.stringify([inventory.files, inventory.folders]));
    if (this.inventoryRevisions.get(id) !== inventoryRevision) {
      this.inventoryRevisions.set(id, inventoryRevision);
      const graph = this.graphs.get(id);
      if (graph) graph.contentRevision = randomUUID();
    }
    const existing = new Set<string>();
    for (const file of inventory.files) {
      if (!isMarkdown(file.path)) continue;
      existing.add(file.path);
      if (file.size > WIKI_MAX_PAGE_BYTES) {
        inventory.warnings.push(`${file.path}: exceeds the 2 MB Markdown limit.`);
        if (index.has(file.path)) removed.push(file.path);
        pages.delete(file.path);
        continue;
      }
      const current = index.get(file.path);
      if (current && current.mtime === file.updatedAt && current.ctime === file.changedAt && current.size === file.size) continue;
      const content = (await this.fileBytes(wiki, file.path, WIKI_MAX_PAGE_BYTES)).toString("utf8");
      if (current && current.revision !== hash(content)) records.push({ path: file.path, content: current.content, action: "write" });
      records.push({ path: file.path, content, action: "write" });
      changed.push({ file, content });
      pages.set(file.path, parseWikiPage(file.path, content, hash(content), file.updatedAt).page);
    }
    for (const [path, cached] of index) if (!existing.has(path)) {
      records.push({ path, content: cached.content, action: "delete" });
      removed.push(path);
      pages.delete(path);
    }
    // Stage all changed pages before querying embeds; a batch import must not
    // reread the wiki for every history entry or depend on filename ordering.
    for (const record of records) await this.record(id, record.path, record.content, record.action, inventory.files, pages);
    for (const { file, content } of changed) await this.remember(id, file.path, content, wiki, file);
    for (const path of removed) await this.drop(id, path);
    return inventory;
  }
  /** Graph polling refreshes changed files, not full rich snapshots. Explicit snapshots still reconcile. */
  async graph(id: string, since?: string, revisionOnly = false): Promise<WikiGraphResponse> {
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id);
      await this.safeRoot(wiki.root);
      let state = this.graphs.get(id);
      if (!state) {
        const created: GraphState = { index: new WikiGraphIndex(), changed: new Set(), reconcile: true, dirty: true, lastScan: 0, contentRevision: randomUUID(), configuration: JSON.stringify(wiki) };
        this.graphs.set(id, created);
        try {
          created.watcher = watch(wiki.root, { recursive: true, persistent: false }, (_event, filename) => {
            if (!filename) { created.reconcile = true; return; }
            const path = String(filename).split(sep).join("/");
            if (path.split("/").some((part) => part.startsWith("."))) return;
            if (!isWikiPath(path)) { created.reconcile = true; return; }
            created.changed.add(path);
            created.contentRevision = randomUUID();
          });
          created.watcher.on("error", () => { created.watcher?.close(); created.watcher = undefined; created.reconcile = true; });
        } catch { /* Periodic reconciliation works on filesystems without recursive watching. */ }
        state = created;
      }
      const configuration = JSON.stringify(wiki);
      if (state.configuration !== configuration) { state.configuration = configuration; state.contentRevision = randomUUID(); }
      const scanInterval = state.watcher ? 60_000 : 5_000;
      if (state.reconcile || Date.now() - state.lastScan >= scanInterval) {
        state.reconcile = false;
        state.changed.clear();
        try { await this.refresh(id); state.lastScan = Date.now(); }
        catch (error) { state.reconcile = true; throw error; }
      } else if (state.changed.size) {
        const changed = [...state.changed];
        state.changed.clear();
        for (const path of changed) {
          let info;
          try { info = await lstat(await this.safePath(wiki, path)); }
          catch (error) {
            if (!missing(error)) { state.reconcile = true; continue; }
            if (isMarkdown(path)) {
              const previous = (await this.index(id)).get(path);
              if (previous) { await this.record(id, path, previous.content, "delete"); await this.drop(id, path); }
            } else state.reconcile = true;
            continue;
          }
          if (info.isDirectory()) { state.reconcile = true; continue; }
          if (!isMarkdown(path)) continue;
          if (!info.isFile() || info.size > WIKI_MAX_PAGE_BYTES) { await this.drop(id, path); continue; }
          const previous = (await this.index(id)).get(path);
          if (previous && previous.mtime === info.mtimeMs && previous.ctime === info.ctimeMs && previous.size === info.size) continue;
          try {
            const content = (await this.fileBytes(wiki, path, WIKI_MAX_PAGE_BYTES)).toString("utf8");
            if (previous && previous.revision !== hash(content)) await this.record(id, path, previous.content, "write");
            await this.record(id, path, content, "write");
            await this.remember(id, path, content, wiki, { path, size: info.size, updatedAt: info.mtimeMs, changedAt: info.ctimeMs });
          } catch (error) { state.reconcile = true; throw error; }
        }
        if (state.reconcile) {
          state.reconcile = false;
          try { await this.refresh(id); state.lastScan = Date.now(); }
          catch (error) { state.reconcile = true; throw error; }
        }
      }
      if (state.dirty) {
        state.index.update([...(await this.index(id)).values()].map((row) => row.page));
        state.dirty = false;
      }
      return revisionOnly ? { kind: "unchanged", revision: state.contentRevision } : state.index.response(since);
    });
  }
  async snapshot(id: string): Promise<WikiSnapshot> {
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id), { files, folders, warnings } = await this.refresh(id);
      const index = await this.index(id), pages = resolveWikiLinks([...index.values()].map((row) => row.page));
      for (const row of index.values()) if (row.warning) warnings.push(`${row.path}: ${row.warning}`);
      const syncStatus: WikiSyncStatus = { state: wiki.sync ? "idle" : "local", lastSyncedAt: null, error: null, conflicts: [] };
      const isDefaultLocation = wiki.root === await canonicalFolderPath(join(this.baseDir, "wikis", wiki.id));
      return { wiki: { ...wiki, isDefaultLocation, writable: !this.config.readOnly, pageCount: pages.length, totalBytes: files.reduce((total, file) => total + file.size, 0), syncStatus }, pages, assets: files.filter((file) => !isMarkdown(file.path)), folders, warnings };
    });
  }
  async indexedPages(id: string) {
    await this.graph(id, undefined, true);
    return [...(await this.index(id)).values()].map(row => row.page);
  }
  async search(id: string, query: string, type?: string, match: "all" | "any" = "all") {
    const snapshot = await this.snapshot(id);
    if (!query.trim()) return snapshot.pages.filter((page) => !type || page.type === type);
    // Quoted phrases stay together; other words match prefixes. Never execute raw FTS syntax.
    const tokens = query.match(/"[^"]+"|[\p{L}\p{N}_]+/gu)?.slice(0, 30) ?? [];
    const terms = tokens.map(term => term.startsWith('"') ? `"${term.slice(1, -1).replace(/"/g, '""')}"` : `"${term}"*`).join(match === "any" ? " OR " : " AND ");
    if (!terms) return [];
    const db = await this.db();
    const pages = new Map(snapshot.pages.filter(page => !type || page.type === type).map(page => [page.path, page]));
    return db.all("SELECT path, bm25(wiki_search, 0, 0, 8, 1) AS score, snippet(wiki_search, 3, '', '', ' … ', 48) AS excerpt FROM wiki_search WHERE wiki=? AND wiki_search MATCH ? ORDER BY score", [id, terms])
      .flatMap(row => {
        const hit = z.object({ path: z.string(), score: z.number(), excerpt: z.string() }).parse(row);
        const page = pages.get(hit.path);
        return page ? [{ ...page, score: hit.score, excerpt: hit.excerpt }] : [];
      }).slice(0, 500);
  }
  async read(id: string, path: string): Promise<WikiDocument> {
    wikiPath(path);
    if (!isMarkdown(path)) throw new ApiError(400, "invalid_wiki_page", "Wiki pages use the .md extension.");
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id), content = (await this.fileBytes(wiki, path, WIKI_MAX_PAGE_BYTES)).toString("utf8");
      const previous = (await this.index(id)).get(path);
      if (previous && previous.revision !== hash(content)) await this.record(id, path, previous.content, "write");
      await this.record(id, path, content, "write");
      const row = await this.remember(id, path, content);
      return { path, content, revision: row.revision, updatedAt: row.updatedAt };
    });
  }
  private conflict(baseRevision: string | undefined, current: string | null): void {
    if (baseRevision !== undefined && baseRevision !== (current ?? "")) throw new ApiError(409, "wiki_revision_conflict", "This file changed since you opened it. Reload it before saving.", { currentRevision: current });
  }
  private async atomicWrite(wiki: WikiRegistration, path: string, content: string | Buffer, expectedRevision?: string): Promise<void> {
    const target = await this.safePath(wiki, path, true), temporary = join(dirname(target), `.wiki-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await this.safePath(wiki, path);
      if (expectedRevision !== undefined) {
        let latest: Buffer | null = null;
        try { latest = await this.fileBytes(wiki, path, isMarkdown(path) ? WIKI_MAX_PAGE_BYTES : WIKI_MAX_ASSET_BYTES); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
        this.conflict(expectedRevision, latest === null ? null : hash(latest));
      }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  private async writePage(id: string, path: string, content: string, baseRevision: string | undefined, action: WikiRevision["action"]): Promise<WikiDocument> {
    wikiPath(path);
    if (!isMarkdown(path)) throw new ApiError(400, "invalid_wiki_page", "Wiki pages use the .md extension.");
    if (Buffer.byteLength(content) > WIKI_MAX_PAGE_BYTES) throw new ApiError(413, "wiki_file_too_large", "Markdown pages can contain up to 2 MB.");
    const wiki = await this.get(id);
    let previous: string | null = null;
    try { previous = (await this.fileBytes(wiki, path, WIKI_MAX_PAGE_BYTES)).toString("utf8"); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    this.conflict(baseRevision, previous === null ? null : hash(previous));
    if (previous !== null) await this.record(id, path, previous, "write");
    await this.atomicWrite(wiki, path, content, previous === null ? "" : hash(previous));
    await this.record(id, path, content, action);
    const row = await this.remember(id, path, content);
    return { path, content, revision: row.revision, updatedAt: row.updatedAt };
  }
  async write(id: string, path: string, content: string, baseRevision?: string): Promise<WikiDocument> {
    return serial(`${this.path}:${id}`, () => this.writePage(id, path, content, baseRevision, "write"));
  }
  async updateProperties(id: string, path: string, patch: WikiPropertiesPatch, baseRevision: string): Promise<WikiDocument> {
    wikiPath(path);
    if (!isMarkdown(path)) throw new ApiError(400, "invalid_wiki_page", "Properties belong to a Markdown page.");
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id), original = (await this.fileBytes(wiki, path, WIKI_MAX_PAGE_BYTES)).toString("utf8");
      this.conflict(baseRevision, hash(original));
      const content = patchWikiProperties(original, patch);
      if (content === original) {
        const row = await this.remember(id, path, original);
        return { path, content, revision: row.revision, updatedAt: row.updatedAt };
      }
      return this.writePage(id, path, content, baseRevision, "write");
    });
  }
  async remove(id: string, path: string, baseRevision: string): Promise<void> {
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id), bytes = await this.fileBytes(wiki, path, isMarkdown(path) ? WIKI_MAX_PAGE_BYTES : WIKI_MAX_ASSET_BYTES);
      this.conflict(baseRevision, hash(bytes));
      if (isMarkdown(path)) await this.record(id, path, bytes.toString("utf8"), "delete");
      await rm(await this.safePath(wiki, path));
      if (isMarkdown(path)) await this.drop(id, path);
    });
  }
  private async entryState(wiki: WikiRegistration, path: string): Promise<WikiEntry> {
    const source = await this.safePath(wiki, path), info = await lstat(source);
    if (!info.isFile() && !info.isDirectory()) throw new ApiError(400, "invalid_wiki_file", "Choose a regular file or folder.");
    const parts: string[] = [];
    const walk = async (target: string, depth: number): Promise<void> => {
      if (depth > 32 || parts.length >= 20_000) throw new ApiError(413, "wiki_too_many_files", "Split this folder before changing it.");
      const current = await lstat(target);
      if (current.isSymbolicLink()) throw new ApiError(403, "unsafe_wiki_path", "Folder actions cannot include symbolic links.");
      const name = relative(source, target);
      if (current.isDirectory()) {
        parts.push(`folder:${name}`);
        for (const entry of (await readdir(target)).sort()) await walk(join(target, entry), depth + 1);
      } else if (current.isFile()) {
        if (current.size > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "wiki_file_too_large", "This file exceeds the 100 MB limit.");
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { parts.push(`file:${name}:${hash(await file.readFile())}`); } finally { await file.close(); }
      } else throw new ApiError(400, "invalid_wiki_file", "Folder actions cannot include special files.");
    };
    await walk(source, 0);
    return { path, kind: info.isDirectory() ? "folder" : "file", revision: hash(JSON.stringify(parts)) };
  }
  async entry(id: string, path: string): Promise<WikiEntry> {
    return serial(`${this.path}:${id}`, async () => this.entryState(await this.get(id), path)).catch(entryError);
  }
  private async trashRoot(wiki: WikiRegistration, create = false): Promise<string> {
    await this.safeRoot(wiki.root);
    const root = join(wiki.root, ".legalwork-trash");
    if (create) await mkdir(root, { recursive: true });
    await this.safeRoot(root);
    return root;
  }
  async trash(id: string): Promise<WikiTrashEntry[]> {
    const wiki = await this.get(id);
    let root: string;
    try { root = await this.trashRoot(wiki); } catch (error) { if (missing(error)) return []; throw error; }
    const items: WikiTrashEntry[] = [];
    for (const name of await readdir(root)) {
      if (!z.string().uuid().safeParse(name).success) continue;
      const folder = join(root, name);
      await this.safeRoot(folder);
      const item = trashSchema.parse(markdownData(await readFile(join(folder, "Entry.md"), "utf8")).data);
      if (item.id !== name) throw new ApiError(500, "wiki_trash_invalid", "The saved trash entry is invalid.");
      items.push(item);
    }
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  }
  async changeEntry(id: string, operation: WikiEntryOperation): Promise<void> {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    return serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id);
      const graph = this.graphs.get(id);
      if (graph) { graph.reconcile = true; graph.contentRevision = randomUUID(); }
      if (operation.action === "restore") {
        const item = (await this.trash(id)).find((entry) => entry.id === operation.trashId);
        if (!item) throw new ApiError(404, "wiki_trash_not_found", "This trash entry is unavailable.");
        const folder = join(await this.trashRoot(wiki), item.id), source = join(folder, "Content");
        const destination = await this.safePath(wiki, item.path, true);
        await this.moveWithoutReplacing(source, destination, item.kind);
        await rm(folder, { recursive: true });
        return;
      }
      const source = await this.safePath(wiki, operation.path, operation.action === "create-folder");
      if (operation.action === "create-folder") { await mkdir(source); return; }
      const entry = await this.entryState(wiki, operation.path);
      this.conflict(operation.baseRevision, entry.revision);
      if (operation.action === "trash") {
        const item: WikiTrashEntry = { id: randomUUID(), path: operation.path, kind: entry.kind, deletedAt: Date.now() };
        const folder = join(await this.trashRoot(wiki, true), item.id);
        await mkdir(folder);
        try {
          await writeFile(join(folder, "Entry.md"), markdownWithData("# Deleted wiki entry\n", item), { flag: "wx", mode: 0o600 });
          await rename(source, join(folder, "Content"));
        } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
        return;
      }
      wikiPath(operation.destination);
      if (operation.destination === operation.path || operation.destination.startsWith(`${operation.path}/`)) throw new ApiError(400, "invalid_wiki_destination", "Choose a destination outside the source folder.");
      if (entry.kind === "file" && isMarkdown(operation.path) && !isMarkdown(operation.destination)) throw new ApiError(400, "invalid_wiki_page", "Markdown pages keep the .md extension.");
      const destination = await this.safePath(wiki, operation.destination, true);
      if (operation.action === "move") await this.moveWithoutReplacing(source, destination, entry.kind);
      else {
        // Reserving the destination prevents copies from merging into existing folders.
        if (entry.kind === "folder") await mkdir(destination);
        try {
          if (entry.kind === "folder") {
            // Copy children into our reservation; Bun rejects copying onto an existing root.
            for (const name of await readdir(source)) {
              await cp(join(source, name), join(destination, name), { recursive: true, errorOnExist: true, force: false });
            }
          } else await cp(source, destination, { errorOnExist: true, force: false });
        }
        catch (error) { if (entry.kind === "folder") await rm(destination, { recursive: true, force: true }); throw error; }
      }
    }).catch(entryError);
  }
  private async moveWithoutReplacing(source: string, destination: string, kind: WikiEntry["kind"]): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) throw new ApiError(403, "unsafe_wiki_path", "This entry is no longer a regular file or folder.");
    if (kind === "file") {
      // link fails if the destination exists, including dangling symbolic links.
      await link(source, destination);
      await unlink(source);
    } else {
      await mkdir(destination);
      try { await rename(source, destination); }
      catch (error) { await rmdir(destination).catch(() => undefined); throw error; }
    }
  }
  async history(id: string, path = ""): Promise<WikiRevision[]> {
    if (path) wikiPath(path);
    await this.snapshot(id);
    const db = await this.db();
    const sql = `SELECT h.id,h.path,h.createdAt,h.action,h.size,c.historyId AS counted,c.added,c.removed
      FROM wiki_history h LEFT JOIN wiki_history_changes c ON c.historyId=h.id
      WHERE h.wiki=?${path ? " AND h.path=?" : ""} ORDER BY h.createdAt DESC,h.rowid DESC LIMIT 200`;
    return db.all(sql, path ? [id, path] : [id]).map(raw => {
      const { counted, added, removed, ...row } = revisionRowSchema.extend({ counted: z.string().nullable(), added: z.number().nullable(), removed: z.number().nullable() }).parse(raw);
      if (counted) return { ...row, changes: added === null || removed === null ? null : { added, removed } };
      // Older databases are backfilled once, only for the revisions being shown.
      const contents = z.object({ content: z.string(), previous: z.string().nullable() }).parse(db.all(`SELECT h.content,
        (SELECT CASE WHEN p.action='delete' THEN '' ELSE p.content END FROM wiki_history p
         WHERE p.wiki=h.wiki AND p.path=h.path AND (p.createdAt<h.createdAt OR (p.createdAt=h.createdAt AND p.rowid<h.rowid))
         ORDER BY p.createdAt DESC,p.rowid DESC LIMIT 1) AS previous FROM wiki_history h WHERE h.id=?`, [row.id])[0]);
      const changes = lineChanges(contents.previous ?? "", row.action === "delete" ? "" : contents.content);
      db.run("INSERT OR IGNORE INTO wiki_history_changes(historyId,added,removed) VALUES(?,?,?)", [row.id, changes?.added ?? null, changes?.removed ?? null]);
      return { ...row, changes };
    });
  }
  async revision(id: string, path: string, revisionId: string): Promise<WikiDocument> {
    await this.get(id);
    const db = await this.db();
    const raw = db.all("SELECT path,content,revision,createdAt AS updatedAt FROM wiki_history WHERE id=? AND wiki=? AND path=?", [revisionId, id, wikiPath(path)])[0];
    if (!raw) throw new ApiError(404, "wiki_revision_not_found", "This revision is unavailable for this page.");
    const document = z.object({ path: z.string(), content: z.string(), revision: z.string(), updatedAt: z.number() }).parse(raw);
    const snapshot = z.object({ content: z.string() }).optional().parse(db.all("SELECT content FROM wiki_history_views WHERE historyId=?", [revisionId])[0]);
    const link = z.object({ snapshot: z.string(), metadata: z.string() }).optional().parse(db.all("SELECT snapshot,metadata FROM wiki_history_view_links WHERE historyId=?", [revisionId])[0]);
    if (!snapshot && !link) return document;
    const viewSnapshots: WikiViewSnapshots = {};
    try {
      const stored = link ? z.object({ content: z.string() }).optional().parse(db.all("SELECT content FROM wiki_view_snapshots WHERE id=?", [link.snapshot])[0]) : snapshot;
      const metadata = link ? snapshotMetadataSchema.parse(JSON.parse(link.metadata)) : undefined;
      const payload: unknown = stored ? JSON.parse(stored.content) : {};
      const entries = z.record(z.string(), z.unknown()).parse(payload);
      for (const [key, value] of Object.entries(entries)) {
        const legacy = z.object({ savedFrom: z.unknown().optional() }).passthrough().safeParse(value);
        if (!legacy.success) continue;
        const { savedFrom: _localReceipt, ...candidate } = legacy.data;
        const parsed = ViewInputSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const input = parsed.data;
        if (metadata && input.datasets) {
          const observation = metadata[key];
          if (Object.keys(input.datasets).some(name => !observation?.[name])) continue;
          for (const [name, dataset] of Object.entries(input.datasets)) input.datasets[name] = { ...dataset, ...observation[name] };
        }
        viewSnapshots[key] = input;
      }
    } catch { /* A damaged embed must not prevent reading or restoring the page. */ }
    return { ...document, viewSnapshots };
  }
  async restore(id: string, path: string, revisionId: string, baseRevision?: string): Promise<WikiDocument> {
    return serial(`${this.path}:${id}`, async () => {
      await this.get(id);
      const db = await this.db();
      const raw = db.all("SELECT content FROM wiki_history WHERE id=? AND wiki=? AND path=?", [revisionId, id, wikiPath(path)])[0];
      if (!raw) throw new ApiError(404, "wiki_revision_not_found", "This revision is unavailable for this page.");
      const row = z.object({ content: z.string() }).parse(raw);
      return this.writePage(id, path, row.content, baseRevision, "restore");
    });
  }
  async readAsset(id: string, path: string): Promise<Buffer> { return this.fileBytes(await this.get(id), path, WIKI_MAX_ASSET_BYTES); }
  async writeAsset(id: string, path: string, data: Buffer, baseRevision?: string): Promise<{ path: string }> {
    wikiPath(path);
    if (isMarkdown(path)) {
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new ApiError(400, "invalid_wiki_markdown", "Markdown files must contain UTF-8 text."); }
      await this.write(id, path, content, baseRevision);
      return { path };
    }
    if (data.length > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "wiki_file_too_large", "Attachments can contain up to 100 MB.");
    await serial(`${this.path}:${id}`, async () => {
      const wiki = await this.get(id);
      let previous: Buffer | null = null;
      try { previous = await this.fileBytes(wiki, path, WIKI_MAX_ASSET_BYTES); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      this.conflict(baseRevision, previous === null ? null : hash(previous));
      await this.atomicWrite(wiki, path, data, previous === null ? "" : hash(previous));
      const graph = this.graphs.get(id);
      if (graph) graph.contentRevision = randomUUID();
    });
    return { path };
  }
}

export function wikiAssetContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".html": return "text/html; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}
