import { isLauncherInternalPath } from "@legalwork/types/launcher";
import { basename, extname } from "node:path";
import { matchesSearch, searchExcerpt, type ContentSearchResponse, type ContentSearchResult } from "./search-schema.js";
import { projectMatch } from "./assistant-project-search.js";
import type { LauncherFileIndex } from "./launcher-file-index.js";
import type { LauncherSearchKind, LauncherSearchResponse, LauncherSearchResult, LauncherSourceState } from "@legalwork/types/launcher";
import type { WorkspaceInfo } from "./types.js";

export type LauncherSearchInput = { query: string; kinds: LauncherSearchKind[]; projectId?: string; content: boolean; limit: number; fileTypes?: string[]; modifiedAfter?: number };
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
const FILE_ACTIONS: LauncherSearchResult["actions"] = ["open", "reveal", "open-external", "attach", "ask", "compare", "summarize", "copy-to-project", "move-to-project", "copy-path", "pin"];

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
        match: match.match === "exact" ? "exact" : match.match === "literal" ? "substring" : match.match === "approximate" ? "fuzzy" : "recent", score, actions: ["open", "ask"] });
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
          match: score.match, score: score.score - (task.completed ? 100 : 0), actions: task.completed ? ["open", "hand-to-assistant"] : ["open", "complete", "hand-to-assistant"] });
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
          match: score.match, score: score.score, actions: ["play", "open", "attach", "ask"] });
      }
      source({ id: "recordings", kind: "recordings", workspaceId: null, label: "Recordings", coverage: "complete", count: recordings.length });
    } catch (error) { source({ id: "recordings", kind: "recordings", workspaceId: null, label: "Recordings", coverage: timedOut(error) ? "partial" : "unavailable", count: 0, limited: timedOut(error), error: timedOut(error) ? TOO_SLOW : error instanceof Error ? error.message : String(error) }); }
  }
  if (kinds.has("files")) {
    await eachLimited(scoped, 4, async workspace => {
      const label = deps.projectName(workspace);
      try {
        const index = await deps.fileIndex.ensure(workspace.id, workspace.path, false);
        const seen = new Set<string>();
        const filter = { types: input.fileTypes ?? null, modifiedAfter: input.modifiedAfter ?? null, browse: input.kinds.length === 1 };
        const passes = (path: string, updatedAt: number) => (!filter.types?.length || filter.types.includes(extname(path).replace(/^\./, "").toLowerCase())) && (filter.modifiedAfter === null || updatedAt >= filter.modifiedAfter);
        if (query || filter.browse || filter.types?.length || filter.modifiedAfter !== null) for (const found of deps.fileIndex.search(workspace.id, query, 40, filter)) {
          seen.add(found.entry.path);
          items.push({ id: found.entry.path, kind: "files", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: found.entry.name, subtitle: label, path: found.entry.path, updatedAt: found.entry.mtimeMs,
            revision: `${found.entry.mtimeMs}:${found.entry.size}`, fileType: found.entry.directory ? "folder" : found.entry.ext.replace(/^\./, ""), size: found.entry.size, match: found.match, score: found.score, actions: found.entry.directory ? ["open"] : FILE_ACTIONS });
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
              items.push({ id: result.id, kind: "files", workspaceId: workspace.id, sourceId: `local:${workspace.id}`, title: basename(result.id), subtitle: label, path: result.id, excerpt: result.sources[0]?.quote, updatedAt: result.updatedAt,
                fileType: extname(result.id).replace(/^\./, "").toLowerCase(), match: "content", score: 300, incomplete: result.incomplete, actions: FILE_ACTIONS, sources: result.sources });
            }
            coverage = preparing ? "indexing" : coverage === "indexing" ? "indexing" : limited ? "partial" : "complete";
          } catch { coverage = coverage === "indexing" ? "indexing" : "filename-only"; }
        }
        source({ id: `files:${workspace.id}`, kind: "files", workspaceId: workspace.id, label, coverage, count: items.filter(item => item.kind === "files" && item.workspaceId === workspace.id).length, limited, preparing });
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
            match: score.match, score: score.score, actions: ["resume", "open", "ask"] });
        }
        source({ id: `chats:${workspace.id}`, kind: "chats", workspaceId: workspace.id, label, coverage: response.limited ? "partial" : "complete", count: response.items.length, limited: response.limited });
      } catch (error) { source({ id: `chats:${workspace.id}`, kind: "chats", workspaceId: workspace.id, label, coverage: signal.aborted ? "searching" : timedOut(error) ? "partial" : "unavailable", count: 0, limited: timedOut(error), error: timedOut(error) ? TOO_SLOW : error instanceof Error ? error.message : String(error) }); }
    });
  }
  for (const id of unavailable) source({ id: `unavailable:${id}`, kind: "projects", workspaceId: id, label: id, coverage: "unavailable", count: 0 });
  items.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id, "en"));
  // Projects are navigation targets without an activity timestamp. Keep their
  // name matches while applying the date constraint to dated content sources.
  return { items: items.filter(item => item.kind === "projects" || !input.modifiedAfter || item.updatedAt >= input.modifiedAfter).slice(0, input.limit), sources, unavailable };
}

/** Recording titles match like other titles; the library itself stays the authority on access. */
export function filterRecordings(recordings: LauncherRecording[], query: string) {
  return recordings.filter(recording => matchesSearch(recording.title, query));
}
export { searchExcerpt };
