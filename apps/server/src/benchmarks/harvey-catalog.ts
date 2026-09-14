/**
 * On-demand Harvey Legal Agent Benchmark catalog.
 *
 * The repo (~491MB) is never vendored or cloned. The index is built from the
 * git tree API (see `listBlobPaths` for how truncation is handled) and cached
 * per-sha in SQLite; task.json files hydrate lazily from
 * raw.githubusercontent.com (not API-rate-limited), and task documents download
 * only when a run actually needs them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { exists } from "../utils.js";
import type { BenchmarkStore } from "./store.js";
import {
  parseHarveyTaskJson,
  parseStoredTaskJson,
  verticalLabel,
  type BenchmarkTaskDefinition,
  type BenchmarkWorkType,
} from "./task-schema.js";

export type HarveyIndexEntry = {
  key: string;
  vertical: string;
  name: string;
  documents: string[];
};

export type HarveyIndex = {
  ref: string;
  fetchedAt: number;
  entries: HarveyIndexEntry[];
};

export type CatalogItem = {
  key: string;
  source: "harvey";
  vertical: string;
  verticalLabel: string;
  name: string;
  docCount: number;
  hydrated: boolean;
  title?: string;
  workType?: BenchmarkWorkType;
  tags?: string[];
  criteriaCount?: number;
  deliverables?: string[];
};

export type CatalogFilter = {
  verticals?: string[];
  workTypes?: BenchmarkWorkType[];
  search?: string;
};

const TASKS_DIR = "tasks";
const TASK_JSON_PATTERN = /^tasks\/([^/]+)\/([^/]+)\/task\.json$/;
const DOCUMENT_PATTERN = /^tasks\/([^/]+)\/([^/]+)\/documents\/(.+)$/;

function apiBase(): string {
  return (process.env.LEGALWORK_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

function rawBase(): string {
  return (process.env.LEGALWORK_GITHUB_RAW_BASE?.trim() || "https://raw.githubusercontent.com").replace(/\/+$/, "");
}

function benchmarkRepo(): string {
  return process.env.LEGALWORK_BENCHMARK_REPO?.trim() || "harveyai/harvey-labs";
}

function benchmarkRef(): string {
  return process.env.LEGALWORK_BENCHMARK_REF?.trim() || "main";
}

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, "User-Agent": "legalwork-server" };
  const token = process.env.LEGALWORK_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Indexing the catalog costs a handful of tree calls, and GitHub only allows 60
 * an hour unauthenticated — say so instead of surfacing a bare 403.
 */
async function githubError(res: Response, url: string): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const rateLimited =
    (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
  if (rateLimited) {
    return new ApiError(
      502,
      "github_rate_limited",
      "GitHub rate limit reached for the benchmark repo. Set LEGALWORK_GITHUB_TOKEN (or GITHUB_TOKEN) to raise it, or try again later.",
    );
  }
  return new ApiError(502, "github_fetch_failed", `Failed to read from GitHub (${res.status}): ${text || url}`);
}

async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: githubHeaders("application/vnd.github+json"),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await githubError(res, url);
  return res.json();
}

async function ghBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: githubHeaders("*/*"),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await githubError(res, url);
  return Buffer.from(await res.arrayBuffer());
}

function rawUrl(ref: string, path: string): string {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `${rawBase()}/${benchmarkRepo()}/${encodeURIComponent(ref)}/${segments}`;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseIndexJson(raw: string): HarveyIndex | null {
  try {
    const value = JSON.parse(raw) as HarveyIndex;
    if (!value || typeof value.ref !== "string" || !Array.isArray(value.entries)) return null;
    return value;
  } catch {
    return null;
  }
}

function buildIndexEntries(paths: string[]): HarveyIndexEntry[] {
  const byKey = new Map<string, HarveyIndexEntry>();
  const pathSet = new Set(paths);
  for (const path of paths) {
    const taskMatch = TASK_JSON_PATTERN.exec(path);
    if (taskMatch) {
      const key = `tasks/${taskMatch[1]}/${taskMatch[2]}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { key, vertical: taskMatch[1]!, name: taskMatch[2]!, documents: [] });
      }
      continue;
    }
    const docMatch = DOCUMENT_PATTERN.exec(path);
    if (docMatch) {
      const key = `tasks/${docMatch[1]}/${docMatch[2]}`;
      const entry = byKey.get(key) ?? { key, vertical: docMatch[1]!, name: docMatch[2]!, documents: [] };
      entry.documents.push(docMatch[3]!);
      byKey.set(key, entry);
    }
  }
  // Entries discovered only through documents (no task.json) are not runnable.
  const entries = Array.from(byKey.values()).filter((entry) => pathSet.has(`${entry.key}/task.json`));
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function resolveHeadSha(): Promise<string> {
  const commit = await ghJson(`${apiBase()}/repos/${benchmarkRepo()}/commits/${encodeURIComponent(benchmarkRef())}`);
  const sha = typeof commit?.sha === "string" ? commit.sha.trim() : "";
  if (!sha) {
    throw new ApiError(502, "github_fetch_failed", "GitHub did not return a commit sha for the benchmark repo");
  }
  return sha;
}

type TreeNode = { path: string; type: string; sha: string };

async function fetchTree(sha: string, recursive: boolean): Promise<{ truncated: boolean; nodes: TreeNode[] }> {
  const url = `${apiBase()}/repos/${benchmarkRepo()}/git/trees/${encodeURIComponent(sha)}${recursive ? "?recursive=1" : ""}`;
  const tree = await ghJson(url);
  const raw = Array.isArray(tree?.tree) ? tree.tree : [];
  const nodes = raw.flatMap((node: any) =>
    node && typeof node.path === "string" && typeof node.sha === "string"
      ? [{ path: String(node.path), type: String(node.type), sha: String(node.sha) }]
      : [],
  );
  return { truncated: tree?.truncated === true, nodes };
}

/**
 * Every blob under the tree `sha`, as paths relative to it.
 *
 * One recursive call covers the whole subtree, but GitHub truncates that
 * response past ~100k entries / 7MB — which the Harvey repo exceeds inside a
 * single practice area (diligence alone carries >30k document blobs). When the
 * listing comes back truncated, walk the tree one level at a time and recurse
 * into each subtree instead: each piece is small enough to come back whole.
 *
 * Results are cached per tree sha. Tree shas are content-addressed, so an
 * unchanged directory is free on the next index build, and a walk cut short by
 * GitHub's hourly rate limit (~40 calls for the Harvey repo, against 60
 * unauthenticated) resumes instead of restarting.
 */
async function listBlobPaths(store: BenchmarkStore, sha: string): Promise<string[]> {
  const cached = store.getCachedTree(sha);
  if (cached) return cached;

  const paths = await fetchBlobPaths(store, sha);
  store.setCachedTree(sha, paths, Date.now());
  return paths;
}

async function fetchBlobPaths(store: BenchmarkStore, sha: string): Promise<string[]> {
  const recursive = await fetchTree(sha, true);
  if (!recursive.truncated) {
    return recursive.nodes.flatMap((node) => (node.type === "blob" ? [node.path] : []));
  }

  const shallow = await fetchTree(sha, false);
  if (shallow.truncated) {
    throw new ApiError(
      502,
      "github_tree_truncated",
      `GitHub truncated a directory listing in the benchmark repo (tree ${sha})`,
    );
  }
  const paths = shallow.nodes.flatMap((node) => (node.type === "blob" ? [node.path] : []));
  const subtrees = shallow.nodes.filter((node) => node.type === "tree");
  const nested = await mapWithConcurrency(subtrees, 4, async (node) =>
    (await listBlobPaths(store, node.sha)).map((path) => `${node.path}/${path}`),
  );
  return paths.concat(...nested);
}

async function fetchIndexAtRef(store: BenchmarkStore, ref: string): Promise<HarveyIndexEntry[]> {
  // Only `tasks/` feeds the index (both path patterns are rooted there), so
  // scope the walk to it rather than listing the whole repo.
  const root = await fetchTree(ref, false);
  const tasks = root.nodes.find((node) => node.type === "tree" && node.path === TASKS_DIR);
  if (!tasks) return [];
  const paths = await listBlobPaths(store, tasks.sha);
  return buildIndexEntries(paths.map((path) => `${TASKS_DIR}/${path}`));
}

export async function loadHarveyIndex(store: BenchmarkStore, options?: { refresh?: boolean }): Promise<HarveyIndex> {
  const head = store.getCatalogHead();
  if (head && !options?.refresh) {
    const cached = store.getCatalogIndex(head.ref);
    const parsed = cached ? parseIndexJson(cached) : null;
    if (parsed) return parsed;
  }

  const sha = await resolveHeadSha();
  const now = Date.now();
  if (sha === head?.ref) {
    const cached = store.getCatalogIndex(sha);
    const parsed = cached ? parseIndexJson(cached) : null;
    if (parsed) {
      store.setCatalogHead(sha, now);
      return parsed;
    }
  }

  const entries = await fetchIndexAtRef(store, sha);
  const index: HarveyIndex = { ref: sha, fetchedAt: now, entries };
  store.setCatalogIndex(sha, JSON.stringify(index), now);
  store.setCatalogHead(sha, now);
  return index;
}

export async function hydrateHarveyTasks(
  store: BenchmarkStore,
  ref: string,
  keys: string[],
  concurrency = 8,
): Promise<{ tasks: Map<string, BenchmarkTaskDefinition>; failed: Array<{ key: string; error: string }> }> {
  const tasks = new Map<string, BenchmarkTaskDefinition>();
  const failed: Array<{ key: string; error: string }> = [];
  const missing: string[] = [];

  for (const key of keys) {
    const cached = store.getCachedTask(ref, key);
    const parsed = cached ? parseStoredTaskJson(cached) : null;
    if (parsed) {
      tasks.set(key, parsed);
    } else {
      missing.push(key);
    }
  }

  await mapWithConcurrency(missing, concurrency, async (key) => {
    try {
      const buffer = await ghBuffer(rawUrl(ref, `${key}/task.json`));
      const result = parseHarveyTaskJson(JSON.parse(buffer.toString("utf8")));
      if (!result.ok) {
        failed.push({ key, error: result.error });
        return;
      }
      store.setCachedTask(ref, key, JSON.stringify(result.task), Date.now());
      tasks.set(key, result.task);
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { tasks, failed };
}

export async function getHarveyTask(
  store: BenchmarkStore,
  ref: string,
  key: string,
): Promise<BenchmarkTaskDefinition> {
  const { tasks, failed } = await hydrateHarveyTasks(store, ref, [key], 1);
  const task = tasks.get(key);
  if (!task) {
    const reason = failed[0]?.error ?? "task not found";
    throw new ApiError(404, "benchmark_task_not_found", `Could not load benchmark task ${key}: ${reason}`);
  }
  return task;
}

const hydrationInFlight = new Set<string>();

/** Fire-and-forget: hydrate every task.json for the given index in the background. */
export function startBackgroundHydration(store: BenchmarkStore, index: HarveyIndex): void {
  if (hydrationInFlight.has(index.ref)) return;
  if (store.countCachedTasks(index.ref) >= index.entries.length) return;
  hydrationInFlight.add(index.ref);
  const keys = index.entries.map((entry) => entry.key);
  void hydrateHarveyTasks(store, index.ref, keys, 4)
    .catch(() => undefined)
    .finally(() => {
      hydrationInFlight.delete(index.ref);
    });
}

export function hydrationStatus(store: BenchmarkStore, index: HarveyIndex): { hydrated: number; total: number } {
  return { hydrated: Math.min(store.countCachedTasks(index.ref), index.entries.length), total: index.entries.length };
}

export function benchmarksDataDir(config: Pick<ServerConfig, "configPath">): string {
  const override = process.env.LEGALWORK_BENCHMARKS_DIR?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "benchmarks");
}

function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new ApiError(400, "invalid_path", `Unsafe document path: ${path}`);
  }
}

/**
 * Download the task's input documents into the pinned per-sha cache and return
 * the local documents directory (null when the task has none).
 */
export async function ensureHarveyDocuments(
  config: Pick<ServerConfig, "configPath">,
  ref: string,
  entry: HarveyIndexEntry,
): Promise<string | null> {
  if (!entry.documents.length) return null;
  const documentsDir = join(benchmarksDataDir(config), "cache", "harvey", ref, entry.key, "documents");
  await mapWithConcurrency(entry.documents, 4, async (relativePath) => {
    assertSafeRelativePath(relativePath);
    const target = join(documentsDir, relativePath);
    if (await exists(target)) return;
    const buffer = await ghBuffer(rawUrl(ref, `${entry.key}/documents/${relativePath}`));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
  });
  return documentsDir;
}

export function buildCatalogItems(
  index: HarveyIndex,
  cachedTasks: Map<string, BenchmarkTaskDefinition>,
): CatalogItem[] {
  const labelByVertical = new Map<string, string>();
  for (const entry of index.entries) {
    if (labelByVertical.has(entry.vertical)) continue;
    const task = cachedTasks.get(entry.key);
    if (task?.tags[0]) labelByVertical.set(entry.vertical, task.tags[0]);
  }
  return index.entries.map((entry) => {
    const task = cachedTasks.get(entry.key) ?? null;
    const label = labelByVertical.get(entry.vertical) ?? verticalLabel(null, entry.vertical);
    const base: CatalogItem = {
      key: entry.key,
      source: "harvey",
      vertical: entry.vertical,
      verticalLabel: label,
      name: entry.name,
      docCount: entry.documents.length,
      hydrated: task !== null,
    };
    if (!task) return base;
    return {
      ...base,
      title: task.title,
      workType: task.workType,
      tags: task.tags,
      criteriaCount: task.criteria.length,
      deliverables: task.deliverables,
    };
  });
}

export function filterCatalogItems(items: CatalogItem[], filter: CatalogFilter): CatalogItem[] {
  const verticals = filter.verticals?.filter(Boolean) ?? [];
  const workTypes = filter.workTypes?.filter(Boolean) ?? [];
  const search = filter.search?.trim().toLowerCase() ?? "";
  return items.filter((item) => {
    if (verticals.length && !verticals.includes(item.vertical)) return false;
    if (workTypes.length && (!item.workType || !workTypes.includes(item.workType))) return false;
    if (search) {
      const haystack = `${item.title ?? ""} ${item.name} ${item.verticalLabel}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export function catalogVerticals(items: CatalogItem[]): Array<{ id: string; label: string; count: number }> {
  const byId = new Map<string, { id: string; label: string; count: number }>();
  for (const item of items) {
    const existing = byId.get(item.vertical);
    if (existing) {
      existing.count += 1;
    } else {
      byId.set(item.vertical, { id: item.vertical, label: item.verticalLabel, count: 1 });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
}
