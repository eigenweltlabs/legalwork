import type { LauncherSearchResult } from "@legalwork/types/launcher";

const KEY = "legalwork.launcher.pins.v1";
export type PinnedResult = Pick<LauncherSearchResult, "id" | "kind" | "workspaceId" | "sourceId" | "title" | "path" | "subtitle"> & { pinnedAt: number };
/** Pinned results are a per-viewer convenience; scope stays visible on every pin. */
export function readPins(): PinnedResult[] {
  try { const raw = window.localStorage.getItem(KEY); const parsed: unknown = raw ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed.filter((item): item is PinnedResult => Boolean(item && typeof item === "object" && "id" in item)) : []; } catch { return []; }
}
export function togglePin(result: LauncherSearchResult): PinnedResult[] {
  const key = `${result.kind}:${result.sourceId}:${result.id}`;
  const current = readPins();
  const next = current.some(pin => `${pin.kind}:${pin.sourceId}:${pin.id}` === key) ? current.filter(pin => `${pin.kind}:${pin.sourceId}:${pin.id}` !== key)
    : [{ id: result.id, kind: result.kind, workspaceId: result.workspaceId, sourceId: result.sourceId, title: result.title, path: result.path, subtitle: result.subtitle, pinnedAt: Date.now() }, ...current].slice(0, 30);
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  return next;
}
export function isPinned(pins: PinnedResult[], result: Pick<LauncherSearchResult, "id" | "kind" | "sourceId">) {
  return pins.some(pin => pin.id === result.id && pin.kind === result.kind && pin.sourceId === result.sourceId);
}
