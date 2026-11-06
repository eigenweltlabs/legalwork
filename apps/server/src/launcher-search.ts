import { launcherResultActions } from "@legalwork/types/launcher";
import { existingLauncherFiles } from "./launcher-file-visibility.js";
import { compareLauncherResults, isLauncherInternalPath } from "@legalwork/types/launcher";
import { basename, extname } from "node:path";
import { matchesSearch, searchExcerpt, type ContentSearchResponse, type ContentSearchResult } from "./search-schema.js";
import { projectMatch } from "./assistant-project-search.js";
import type { LauncherFileIndex } from "./launcher-file-index.js";
import type { LauncherSort, LauncherFileSourceKind, LauncherSearchKind, LauncherSearchResponse, LauncherSearchResult, LauncherSourceState } from "@legalwork/types/launcher";
import type { WorkspaceInfo } from "./types.js";

export type LauncherSearchInput = { query: string; kinds: LauncherSearchKind[]; projectId?: string; content: boolean; limit: number; fileTypes?: string[]; modifiedAfter?: number; sourceKind?: LauncherFileSourceKind; sort?: LauncherSort };
export type LauncherRecording = { id: string; title: string; createdAt: number; durationMs: number; projectIds?: string[]; status?: string };
export type LauncherSearchDeps = {
  workspaces: () => Promise<{ workspaces: WorkspaceInfo[]; unavailable: string[] }>;
  projectName: (workspace: WorkspaceInfo) => string;
  tasks: (query: string, workspaceId: string | undefined) => Promise<ContentSearchResult[]>;
  recordings: ((query: string) => Promise<LauncherRecording[]>) | null;
  fileIndex: LauncherFileIndex;
  sessionSearch: (workspace: WorkspaceInfo, query: string, signal: AbortSignal) => Promise<ContentSearchResponse>;
  fileContentSearch: (workspace: WorkspaceInfo, query: string, signal: AbortSignal) => Promise<ContentSearchResponse>;
  budgetMs?: number;
};

export function titleScore(title: string, query: string): { match: LauncherSearchResult["match"]; score: number } | null {
  const terms = query.normalize("NFC").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = terms.join(" "), value = title.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return { match: "recent", score: 0 };
  if (value === phrase) return { match: "exact", score: 1000 };
  if (value.startsWith(phrase)) return { match: "prefix", score: 800 };
  if (value.includes(phrase)) return { match: "substring", score: 550 };
  if (terms.every(term => value.includes(term))) return { match: "word", score: 450 };
  return null;
}
async function withBudget<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Search source timed out", "TimeoutError")), ms);
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) controller.abort(parent.reason);
  let rejectTimeout: () => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", rejectTimeout, { once: true }); if (controller.signal.aborted) rejectTimeout(); });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { clearTimeout(timer); parent.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectTimeout); }
}
const timedOut = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
const TOO_SLOW = "Took too long; results may be incomplete.";
async function eachLimited<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) { const item = queue.shift(); if (item) await work(item); } }));
}

/**
 * One search over every enabled source. Each source reports its own coverage,
 * so a slow or unavailable provider never turns into "nothing found".
 */
export async function searchLauncher(deps: LauncherSearchDeps, input: LauncherSearchInput, signal: AbortSignal): Promise<LauncherSearchResponse> {
  const query = input.query.trim();
  const kinds = new Set(input.kinds);
  const items: LauncherSearchResult[] = [];
  const sources: LauncherSourceState[] = [];
  const budget = deps.budgetMs ?? 2500;
  const { workspaces, unavailable } = await deps.workspaces();
  const scoped = input.projectId ? workspaces.filter(workspace => workspace.id === input.projectId) : workspaces;
  if (input.projectId && !scoped.length) unavailable.push(input.projectId);
  const source = (state: LauncherSourceState) => { sources.push(state); };
  if (kinds.has("projects")) {
    let count = 0;
    for (const workspace of scoped) {
      if (workspace.preset === "wiki") continue;
      const match = projectMatch({ id: workspace.id, name: deps.projectName(workspace), path: workspace.path }, query);
      if (!match) continue;
      const score = match.match === "exact" ? 1000 : match.match === "literal" ? 700 - match.score * 50 : match.match === "all" ? 0 : 150 - match.score * 10;
      items.push({ id: workspace.id, kind: "projects", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: deps.projectName(workspace), subtitle: workspace.path, updatedAt: 0,
        match: match.match === "exact" ? "exact" : match.match === "literal" ? "substring" : match.match === "approximate" ? "fuzzy" : "recent", score, actions: [] });
      count++;
    }
    source({ id: "projects", kind: "projects", workspaceId: null, label: "Projects", coverage: unavailable.length ? "partial" : "complete", count });
  }
  if (kinds.has("tasks")) {
    try {
      const tasks = await withBudget(() => deps.tasks(query, input.projectId), budget, signal);
      for (const task of tasks) {
        const score = titleScore(task.title, query) ?? { match: "content" as const, score: 300 };
        items.push({ id: task.id, kind: "tasks", workspaceId: task.workspaceId || null, sourceId: "tasks", title: task.title, excerpt: task.excerpt || undefined, updatedAt: task.updatedAt, completed: task.completed,
          match: score.match, score: score.score - (task.completed ? 100 : 0), actions: [] });
      }
      source({ id: "tasks", kind: "tasks", workspaceId: null, label: "Tasks", coverage: tasks.length > 60 ? "partial" : "complete", count: tasks.length, limited: tasks.length > 60 });
    } catch (error) { source({ id: "tasks", kind: "tasks", workspaceId: null, label: "Tasks", coverage: timedOut(error) ? "partial" : "unavailable", count: 0, limited: timedOut(error), error: timedOut(error) ? TOO_SLOW : error instanceof Error ? error.message : String(error) }); }
  }
  if (kinds.has("recordings")) {
    if (!deps.recordings) source({ id: "recordings", kind: "recordings", workspaceId: null, label: "Recordings", coverage: "unavailable", count: 0, error: "The recording library is only available in the desktop app." });
    else try {
      const recordings = await withBudget(() => deps.recordings!(query), budget, signal);
      for (const recording of recordings) {
        if (input.projectId && !recording.projectIds?.includes(input.projectId)) continue;
        const score = titleScore(recording.title, query) ?? { match: "content" as const, score: 300 };
        items.push({ id: recording.id, kind: "recordings", workspaceId: recording.projectIds?.[0] ?? null, sourceId: "recordings", title: recording.title, updatedAt: recording.createdAt, durationMs: recording.durationMs, status: recording.status,
          match: score.match, score: score.score, actions: [] });
      }
      source({ id: "recordings", kind: "recordings", workspaceId: null, label: "Recordings", coverage: "complete", count: recordings.length });
    } catch (error) { source({ id: "recordings", kind: "recordings", workspaceId: null, label: "Recordings", coverage: timedOut(error) ? "partial" : "unavailable", count: 0, limited: timedOut(error), error: timedOut(error) ? TOO_SLOW : error instanceof Error ? error.message : String(error) }); }
  }
  if (kinds.has("files")) {
    const fileWorkspaces = scoped.filter(workspace => !input.sourceKind || input.sourceKind === (workspace.preset === "wiki" ? "wiki" : "project"));
    await eachLimited(fileWorkspaces, 4, async workspace => {
      const label = deps.projectName(workspace);
      try {
        const fileItems: LauncherSearchResult[] = [];
        const index = await deps.fileIndex.ensure(workspace.id, workspace.path, false);
        const seen = new Set<string>();
        const filter = { types: input.fileTypes ?? null, modifiedAfter: input.modifiedAfter ?? null, browse: input.kinds.length === 1, sort: input.sort };
        const passes = (path: string, updatedAt: number) => (!filter.types?.length || filter.types.includes(extname(path).replace(/^\./, "").toLowerCase())) && (filter.modifiedAfter === null || updatedAt >= filter.modifiedAfter);
        if (query || filter.browse || filter.types?.length || filter.modifiedAfter !== null) for (const found of deps.fileIndex.search(workspace.id, query, input.sort && input.sort !== "relevance" ? input.limit : 40, filter)) {
          seen.add(found.entry.path);
          fileItems.push({ id: found.entry.path, kind: "files", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: found.entry.name, subtitle: label, sourceKind: workspace.preset === "wiki" ? "wiki" : "project", path: found.entry.path, updatedAt: found.entry.mtimeMs,
            revision: `${found.entry.mtimeMs}:${found.entry.size}`, fileType: found.entry.directory ? "folder" : found.entry.ext.replace(/^\./, ""), size: found.entry.size, match: found.match, score: found.score, actions: [] });
        }
        const state = deps.fileIndex.state(workspace.id);
        let coverage: LauncherSourceState["coverage"] = state === "indexing" || (index.building && !index.complete) ? "indexing" : "filename-only";
        let preparing = 0, limited = state === "limited";
        if (input.content && query.length >= 2) {
          try {
            const response = await withBudget(inner => deps.fileContentSearch(workspace, query, inner), budget, signal);
            preparing = response.preparing ?? 0; limited ||= Boolean(response.limited);
            for (const result of response.items) {
              if (isLauncherInternalPath(result.id) || seen.has(result.id) || !result.sources?.length || !passes(result.id, result.updatedAt)) continue;
              fileItems.push({ id: result.id, kind: "files", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: basename(result.id), subtitle: label, sourceKind: workspace.preset === "wiki" ? "wiki" : "project", path: result.id, excerpt: result.sources[0]?.quote, updatedAt: result.updatedAt,
                fileType: extname(result.id).replace(/^\./, "").toLowerCase(), match: "content", score: 300, incomplete: result.incomplete, actions: [], sources: result.sources });
            }
            coverage = preparing ? "indexing" : coverage === "indexing" ? "indexing" : limited ? "partial" : "complete";
          } catch { coverage = coverage === "indexing" ? "indexing" : "filename-only"; }
        }
        const visible = await existingLauncherFiles(workspace.path, fileItems);
        items.push(...visible);
        source({ id: `files:${workspace.id}`, kind: "files", workspaceId: workspace.id, label, coverage, count: visible.length, limited, preparing });
      } catch (error) { source({ id: `files:${workspace.id}`, kind: "files", workspaceId: workspace.id, label, coverage: "unavailable", count: 0, error: error instanceof Error ? error.message : String(error) }); }
    });
  }
  if (kinds.has("chats") && (query.length >= 2 || !query && input.kinds.length === 1)) {
    await eachLimited(scoped, 3, async workspace => {
      const label = deps.projectName(workspace);
      try {
        const response = await withBudget(inner => deps.sessionSearch(workspace, query, inner), budget, signal);
        for (const result of response.items) {
          const score = titleScore(result.title, query) ?? { match: "content" as const, score: 300 };
          items.push({ id: result.id, kind: "chats", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: result.title, subtitle: label, excerpt: result.excerpt || undefined, updatedAt: result.updatedAt, sessionId: result.id, messageId: result.messageId,
            match: score.match, score: score.score, actions: [] });
        }
        source({ id: `chats:${workspace.id}`, kind: "chats", workspaceId: workspace.id, label, coverage: response.limited ? "partial" : "complete", count: response.items.length, limited: response.limited });
      } catch (error) { source({ id: `chats:${workspace.id}`, kind: "chats", workspaceId: workspace.id, label, coverage: signal.aborted ? "searching" : timedOut(error) ? "partial" : "unavailable", count: 0, limited: timedOut(error), error: timedOut(error) ? TOO_SLOW : error instanceof Error ? error.message : String(error) }); }
    });
  }
  for (const id of unavailable) source({ id: `unavailable:${id}`, kind: "projects", workspaceId: id, label: id, coverage: "unavailable", count: 0 });
  for (const item of items) {
    if (item.kind === "projects" || !item.workspaceId) continue;
    const workspace = workspaces.find(workspace => workspace.id === item.workspaceId);
    if (!workspace) continue;
    item.subtitle ??= deps.projectName(workspace);
    item.sourceKind = workspace.preset === "wiki" ? "wiki" : "project";
  }
  for (const item of items) item.actions = launcherResultActions(item);
  items.sort((a, b) => compareLauncherResults(a, b, input.sort));
  // Projects are navigation targets without an activity timestamp. Keep their
  // name matches while applying the date constraint to dated content sources.
  return { items: items.filter(item => item.kind === "projects" || !input.modifiedAfter || item.updatedAt >= input.modifiedAfter).slice(0, input.limit), sources, unavailable };
}

/** Recording titles match like other titles; the library itself stays the authority on access. */
export function filterRecordings(recordings: LauncherRecording[], query: string) {
  return recordings.filter(recording => matchesSearch(recording.title, query));
}
export { searchExcerpt };
