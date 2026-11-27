import { useQueries } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { LauncherSearchResultSchema, type LauncherSearchResult } from "@legalwork/types/launcher";

export type LauncherRecent = { result: LauncherSearchResult; openedAt: number; visits: number };
const key = (server: string) => `legalwork.launcher.recents.v1:${server}`;
const identity = (item: LauncherSearchResult) => `${item.kind}:${item.workspaceId}:${item.folderId ?? ""}:${item.path ?? item.sessionId ?? item.id}`;

export function readLauncherRecents(server: string): LauncherRecent[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key(server)) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.flatMap((item: unknown): LauncherRecent[] => {
      if (!item || typeof item !== "object" || !("result" in item) || !("openedAt" in item) || !("visits" in item)) return [];
      if (typeof item.openedAt !== "number" || !Number.isFinite(item.openedAt) || typeof item.visits !== "number" || !Number.isFinite(item.visits) || item.visits < 1) return [];
      const result = LauncherSearchResultSchema.safeParse(item.result);
      return result.success ? [{ result: result.data, openedAt: item.openedAt, visits: item.visits }] : [];
    }).slice(0, 40);
  }
  catch { return []; }
}

/** Record opens, never searches or automatic suggestions. Keep only display metadata. */
export function rememberLauncherOpen(server: string, result: LauncherSearchResult) {
  const previous = readLauncherRecents(server);
  const match = previous.find(item => identity(item.result) === identity(result));
  const { excerpt: _excerpt, sources: _sources, ...metadata } = result;
  const next = [{ result: metadata, openedAt: Date.now(), visits: (match?.visits ?? 0) + 1 }, ...previous.filter(item => identity(item.result) !== identity(result))].slice(0, 40);
  try { localStorage.setItem(key(server), JSON.stringify(next)); window.dispatchEvent(new Event("legalwork:launcher-recents")); } catch { /* Storage may be unavailable. */ }
}

/** File visibility also covers Wiki and linked folders, which can be absent from the project list. */
export function hasRecentSource(result: Pick<LauncherSearchResult, "kind" | "workspaceId" | "sourceId">, projects: readonly { id: string }[], visibleFile: boolean) {
  if (result.kind === "files") return visibleFile;
  return !result.workspaceId || result.sourceId === "assistant" || projects.some(project => project.id === result.workspaceId);
}

/** Old recents contain display metadata only. Check each project's chat IDs
 * together before ranking suggestions so empty rows cannot take a slot. */
export function useVisibleRecentChats(client: LegalworkServerClient, recents: LauncherRecent[], enabled: boolean) {
  const byWorkspace = new Map<string, Set<string>>();
  for (const { result } of recents) {
    if (result.kind !== "chats" || !result.workspaceId) continue;
    const ids = byWorkspace.get(result.workspaceId) ?? new Set<string>();
    ids.add(result.sessionId ?? result.id);
    byWorkspace.set(result.workspaceId, ids);
  }
  const groups = [...byWorkspace].map(([workspaceId, ids]) => ({ workspaceId, sessionIds: [...ids].sort() }));
  const queries = useQueries({ queries: groups.map(({ workspaceId, sessionIds }) => ({
    queryKey: ["launcher-visible-chats", client.baseUrl, client.draftProfile, workspaceId, sessionIds],
    queryFn: ({ signal }: { signal: AbortSignal }) => client.visibleLauncherChats(workspaceId, sessionIds, signal),
    enabled, retry: false,
  })) });
  const visible = new Map(groups.map(({ workspaceId }, index) => [workspaceId, new Set(queries[index]?.data?.sessionIds)]));
  return (result: LauncherSearchResult) => result.kind !== "chats" || visible.get(result.workspaceId ?? "")?.has(result.sessionId ?? result.id) === true;
}

/** Recent use wins; a related project and repeated use provide bounded boosts. */
export function suggestedRecents(items: LauncherRecent[], projectId: string | undefined, now = Date.now()) {
  const score = (item: LauncherRecent) => {
    const ageDays = Math.max(0, now - item.openedAt) / 86_400_000;
    return 10 / (1 + ageDays) + (projectId && item.result.workspaceId === projectId ? 3 : 0) + Math.min(2, Math.log2(item.visits));
  };
  return [...items].sort((a, b) => score(b) - score(a) || b.openedAt - a.openedAt).slice(0, 4);
}

/** Refresh display state without recording another open or changing recency. */
export function updateLauncherRecent(server: string, result: LauncherSearchResult) {
  const { excerpt: _excerpt, sources: _sources, ...metadata } = result;
  const items = readLauncherRecents(server).map(item => identity(item.result) === identity(result) ? { ...item, result: metadata } : item);
  try { localStorage.setItem(key(server), JSON.stringify(items)); window.dispatchEvent(new Event("legalwork:launcher-recents")); } catch { /* Storage may be unavailable. */ }
}
