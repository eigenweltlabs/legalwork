import { launcherResultActions, isLauncherInternalPath } from "./native-shared-values.js";
import { existingLauncherFiles } from "./launcher-file-visibility.js";
import { basename, extname } from "node:path";
import type { LauncherSearchResponse, LauncherSearchResult } from "@legalwork/types/launcher";
import type { LauncherFolders } from "./launcher-folders.js";
import type { LauncherFileIndex } from "./launcher-file-index.js";
import type { LauncherSearchInput } from "./launcher-search.js";
import type { ContentSearchResponse } from "./search-schema.js";

export async function searchFolderFiles(folders: LauncherFolders, index: LauncherFileIndex, input: LauncherSearchInput,
  content: (folder: { id: string; path: string }, signal: AbortSignal) => Promise<ContentSearchResponse>, signal: AbortSignal): Promise<LauncherSearchResponse> {
  const response: LauncherSearchResponse = { items: [], sources: [], unavailable: [] };
  if (!input.kinds.includes("files") || input.projectId || input.sourceKind && input.sourceKind !== "folder") return response;
  // Bound parallel folder reads and document preparation.
  const pending = [...folders.list()];
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let folder = pending.shift(); folder; folder = pending.shift()) {
      signal.throwIfAborted();
      const sourceId = `folder:${folder.id}`;
      try {
        await folders.root(folder.id);
        await index.ensure(sourceId, folder.path);
        const found: LauncherSearchResult[] = index.search(sourceId, input.query, input.limit, { types: input.fileTypes, modifiedAfter: input.modifiedAfter, browse: input.kinds.length === 1, sort: input.sort }).map(({ entry, match, score }) => ({
          id: entry.path, kind: "files", workspaceId: null, folderId: folder.id, sourceId, title: entry.name, subtitle: folder.name, sourceKind: "folder", path: entry.path,
          updatedAt: entry.mtimeMs, revision: `${entry.mtimeMs}:${entry.size}`, fileType: entry.directory ? "folder" : entry.ext.slice(1), size: entry.size, match, score, actions: [],
        }));
        let coverage: LauncherSearchResponse["sources"][number]["coverage"] = index.state(sourceId) === "indexing" ? "indexing" : "filename-only";
        let limited = index.state(sourceId) === "limited";
        if (input.content && input.query.length >= 2) {
          try {
            const result = await content(folder, AbortSignal.any([signal, AbortSignal.timeout(2500)]));
            limited ||= Boolean(result.limited);
            for (const item of result.items) {
              if (isLauncherInternalPath(item.id) || !item.sources?.length || found.some(existing => existing.id === item.id)) continue;
              if (input.fileTypes?.length && !input.fileTypes.includes(extname(item.id).slice(1).toLowerCase())) continue;
              if (input.modifiedAfter && item.updatedAt < input.modifiedAfter) continue;
              found.push({ id: item.id, kind: "files", workspaceId: null, folderId: folder.id, sourceId, title: basename(item.id), subtitle: folder.name, sourceKind: "folder", path: item.id,
                updatedAt: item.updatedAt, excerpt: item.sources[0].quote, match: "content", score: 300, actions: [], sources: item.sources, incomplete: item.incomplete });
            }
            coverage = result.preparing || coverage === "indexing" ? "indexing" : limited || result.skipped ? "partial" : "complete";
          } catch { /* Filename results remain useful when extraction is unavailable. */ }
        }
        const visible = await existingLauncherFiles(folder.path, found);
        response.items.push(...visible.map(item => ({ ...item, actions: launcherResultActions(item) })));
        response.sources.push({ id: sourceId, kind: "files", workspaceId: null, label: folder.name, coverage, count: visible.length, limited });
      } catch (error) {
        index.invalidate(sourceId);
        response.unavailable.push(sourceId);
        response.sources.push({ id: sourceId, kind: "files", workspaceId: null, label: folder.name, coverage: "unavailable", count: 0, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));
  return response;
}
