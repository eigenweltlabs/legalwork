import { watch, type FSWatcher } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { setImmediate } from "node:timers/promises";
import { compareLauncherResults, isLauncherInternalPath, type LauncherSort } from "@legalwork/types/launcher";

const SKIP_DIRECTORIES = new Set(["node_modules", "vendor", "dist", "build", "coverage", "__pycache__"]);
export type IndexedFile = { path: string; name: string; folded: string; mtimeMs: number; size: number; ext: string; directory?: boolean };
type Index = { root: string; entries: Map<string, IndexedFile>; builtAt: number; building: Promise<void> | null; complete: boolean; limited: boolean; watcher: FSWatcher | null; dirty: boolean; timer: ReturnType<typeof setTimeout> | null };
export type FileIndexState = "indexing" | "ready" | "limited" | "unavailable";
export type FileMatch = { entry: IndexedFile; match: "exact" | "prefix" | "word" | "substring" | "fuzzy" | "recent"; score: number };
const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Subsequence match with a bounded gap penalty: "mvtr" finds "Mietvertrag". */
function fuzzyScore(folded: string, term: string) {
  let index = 0, gaps = 0, last = -1;
  for (const char of term) {
    const next = folded.indexOf(char, index);
    if (next < 0) return null;
    if (last >= 0 && next > last + 1) gaps++;
    last = next; index = next + 1;
  }
  return gaps > Math.max(3, term.length) ? null : gaps;
}

/**
 * Incremental filename/path index per project. The first walk is bounded;
 * afterwards a keystroke searches memory, and changes mark the index dirty
 * through the platform watcher instead of rewalking on every query.
 */
export class LauncherFileIndex {
  private indexes = new Map<string, Index>();
  constructor(private options: { maxEntries?: number; ttlMs?: number; debounceMs?: number; watch?: boolean } = {}) {}
  state(workspaceId: string): FileIndexState {
    const index = this.indexes.get(workspaceId);
    if (!index) return "unavailable";
    if (index.building && !index.complete) return "indexing";
    return index.limited ? "limited" : "ready";
  }
  private async build(workspaceId: string, index: Index) {
    const entries = new Map<string, IndexedFile>();
    // The first walk is immediately searchable; rebuilds keep the previous
    // complete snapshot until the replacement is ready.
    if (!index.complete) index.entries = entries;
    const max = this.options.maxEntries ?? 100_000;
    let limited = false, visited = 0;
    const visit = async (directory: string): Promise<void> => {
      let handle;
      try { handle = await opendir(directory); } catch { return; }
      for await (const entry of handle) {
        if (++visited % 500 === 0) await setImmediate();
        if (entries.size >= max) { limited = true; break; }
        if (isLauncherInternalPath(entry.name) || entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        const relativePath = relative(index.root, path).split("\\").join("/");
        entries.set(relativePath, { path: relativePath, name: entry.name, folded: fold(relativePath), mtimeMs: info.mtimeMs, size: info.size, ext: entry.isDirectory() ? "" : extname(entry.name).toLowerCase(), directory: entry.isDirectory() });
        if (entry.isDirectory()) await visit(path);
      }
    };
    index.dirty = false;
    await visit(index.root);
    if (this.indexes.get(workspaceId) !== index) return;
    index.entries = entries; index.builtAt = Date.now(); index.complete = true; index.limited = limited;
    // A change that arrived mid-walk is not in this snapshot: walk again.
    if (index.dirty) { index.building = null; void this.ensure(workspaceId, index.root).catch(() => this.invalidate(workspaceId)); }
  }
  private startWatching(workspaceId: string, index: Index) {
    if (index.watcher || this.options.watch === false) return;
    try {
      index.watcher = watch(index.root, { recursive: true, persistent: false }, () => {
        index.dirty = true;
        if (index.timer) clearTimeout(index.timer);
        index.timer = setTimeout(() => { index.timer = null; void this.ensure(workspaceId, index.root).catch(() => this.invalidate(workspaceId)); }, this.options.debounceMs ?? 1500);
        index.timer.unref?.();
      });
      index.watcher.on("error", () => { index.watcher?.close(); index.watcher = null; });
    } catch { index.watcher = null; }
  }
  /** Current entries for a project; starts or refreshes the index in the background when needed. */
  async ensure(workspaceId: string, path: string, wait = false) {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error("The document folder is unavailable.");
    let index = this.indexes.get(workspaceId);
    if (index && index.root !== root) { this.invalidate(workspaceId); index = undefined; }
    if (!index) {
      index = { root, entries: new Map(), builtAt: 0, building: null, complete: false, limited: false, watcher: null, dirty: true, timer: null };
      this.indexes.set(workspaceId, index);
      this.startWatching(workspaceId, index);
    }
    const stale = !index.watcher && Date.now() - index.builtAt > (this.options.ttlMs ?? 10 * 60_000);
    if (!index.building && (index.dirty || stale)) {
      const current = index;
      index.building = this.build(workspaceId, current).catch(() => { current.limited = true; }).finally(() => { if (current.building) current.building = null; });
    }
    if (wait && index.building) await index.building;
    return index;
  }
  search(workspaceId: string, query: string, limit = 50, filter: { types?: string[] | null; modifiedAfter?: number | null; browse?: boolean; sort?: LauncherSort } = {}): FileMatch[] {
    const index = this.indexes.get(workspaceId);
    const terms = fold(query).trim().split(/\s+/).filter(Boolean);
    const types = filter.types?.length ? new Set(filter.types.map(type => `.${type.toLowerCase().replace(/^\./, "")}`)) : null;
    const since = filter.modifiedAfter ?? null;
    if (!index || (!terms.length && !types && since === null && !filter.browse)) return [];
    const phrase = terms.join(" ");
    const matches: FileMatch[] = [];
    for (const entry of index.entries.values()) {
      if (types && !types.has(entry.ext)) continue;
      if (since !== null && entry.mtimeMs < since) continue;
      const name = fold(entry.name), stem = fold(basename(entry.name, extname(entry.name)));
      let match: FileMatch["match"] | null = null, score = 0;
      // A filter without words lists what it matches, newest first.
      if (!terms.length) { match = "recent"; score = 0; }
      else if (stem === phrase || name === phrase) { match = "exact"; score = 1000; }
      else if (name.startsWith(phrase)) { match = "prefix"; score = 800; }
      else if (terms.every(term => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(name))) { match = "word"; score = 650; }
      else if (terms.every(term => entry.folded.includes(term))) { match = "substring"; score = terms.every(term => name.includes(term)) ? 500 : 350; }
      else if (terms.length === 1 && terms[0].length >= 3) {
        const gaps = fuzzyScore(name, terms[0]);
        if (gaps !== null) { match = "fuzzy"; score = 200 - gaps * 20; }
      }
      if (!match) continue;
      // Recency and specificity break ties; they never outrank a better match.
      score += Math.min(40, Math.max(0, 40 - (Date.now() - entry.mtimeMs) / 86_400_000)) + Math.min(20, (phrase.length / Math.max(1, name.length)) * 20);
      matches.push({ entry, match, score });
    }
    return matches.sort((a, b) => filter.sort && filter.sort !== "relevance"
      ? compareLauncherResults({ id: a.entry.path, title: a.entry.name, updatedAt: a.entry.mtimeMs, score: a.score }, { id: b.entry.path, title: b.entry.name, updatedAt: b.entry.mtimeMs, score: b.score }, filter.sort)
      : b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs || a.entry.path.localeCompare(b.entry.path, "en")).slice(0, limit);
  }
  size(workspaceId: string) { return this.indexes.get(workspaceId)?.entries.size ?? 0; }
  invalidate(workspaceId: string) {
    const index = this.indexes.get(workspaceId);
    if (!index) return;
    index.watcher?.close(); if (index.timer) clearTimeout(index.timer);
    this.indexes.delete(workspaceId);
  }
  dispose() { for (const id of [...this.indexes.keys()]) this.invalidate(id); }
}
