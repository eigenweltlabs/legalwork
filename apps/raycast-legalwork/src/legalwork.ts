import { getSelectedText, open, showToast, Toast } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { raycastHandoffUrl, readPairing, type Pairing } from "./pairing";
export { readPairing, type Pairing } from "./pairing";
import type { AssistantContextItem, AssistantWorkItem, LauncherInvocation, LauncherSearchResult, LauncherSourceState } from "@legalwork/types/launcher";
import { canonicalResultFile } from "./result-files";

/**
 * Transport contract shared with the desktop app:
 *  - A launch URL (`legalwork://assistant/...`) starts or focuses the app and carries identifiers only.
 *  - The pairing file written by LegalWork (Settings, Assistant launcher, Raycast) holds the local server
 *    URL and a per-session token, readable only by this user account. Content goes over that loopback
 *    connection, never into a URL.
 */
export type SearchKind = "files" | "projects" | "chats" | "tasks" | "recordings";
export type SearchResult = LauncherSearchResult;
export type SourceState = LauncherSourceState;
export type CatalogEntry = { id: string; label: string; description: string | null; kind: string; source: string; requires: string[]; favorite: boolean; quickAction: { id: string } | null };
export type WorkItem = AssistantWorkItem;
export type ContextItem = AssistantContextItem;

export async function request<T>(pairing: Pairing, route: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${pairing.serverUrl}${route}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, redirect: "error" });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (response.status === 401) throw new Error("LegalWork rejected this pairing. Refresh the list or reopen the Raycast command and try again.");
  if (!response.ok) throw new Error(typeof json?.message === "string" ? json.message : `LegalWork request failed (${response.status})`);
  return json as T;
}
type RaycastCommand = Pick<LauncherInvocation, "query" | "conversationId" | "projectId" | "actionId" | "contextId" | "result" | "resultAction"> & {
  action: "open" | "resume" | "ask" | "quick-action";
};
export async function launch(command: RaycastCommand, paired?: Pairing) {
  const resumeCurrent = command.action === "resume" && !command.conversationId;
  const pairing = paired ?? (resumeCurrent ? await readPairing() : await requirePairing());
  if (!pairing) {
    await open(resumeCurrent ? "legalwork://assistant/resume" : "legalwork://assistant/open");
    return;
  }
  const { id } = await request<{ id: string }>(pairing, "/launcher/raycast/handoff", {
    method: "POST", body: { ...command, id: randomUUID(), source: "raycast" },
  });
  await open(raycastHandoffUrl(pairing.scheme, id));
}
export async function stageSelection(pairing: Pairing): Promise<{ id: string } | null> {
  let text = "";
  try { text = await getSelectedText(); } catch { return null; }
  if (!text.trim()) return null;
  if (text.length > 200_000) throw new Error("The selection exceeds 200,000 characters. Select a shorter passage and retry.");
  const item: ContextItem = { id: `sel_${Date.now().toString(36)}`, type: "selection", text, sourceApp: null, sourceWindow: null, capturedAt: Date.now() };
  return request<{ id: string }>(pairing, "/launcher/context", { method: "POST", body: { items: [item], source: "raycast", ttlMs: 5 * 60_000 } });
}
/** Pairing is local-only. Both the server and filesystem must still recognize the selected source. */
export async function localResultPath(pairing: Pairing, item: SearchResult): Promise<string> {
  if (item.kind !== "files" || !item.folderId && !item.workspaceId) throw new Error("This result is not a local file.");
  const { excerpt: _excerpt, sources: _sources, ...reference } = item;
  const visible = await request<{ items: SearchResult[] }>(pairing, "/launcher/files/visible", { method: "POST", body: { items: [reference] } });
  if (!visible.items.some(found => found.kind === item.kind && found.id === item.id && found.sourceId === item.sourceId)) throw new Error("This file or its source is no longer available. Search again.");
  let root: string | undefined;
  if (item.folderId) {
    const response = await request<{ folders: { id: string; path: string }[] }>(pairing, "/launcher/folders");
    root = response.folders.find(folder => folder.id === item.folderId)?.path;
  } else {
    const response = await request<{ items?: { id: string; path: string; contentPath?: string | null }[]; workspaces?: { id: string; path: string; contentPath?: string | null }[] }>(pairing, "/workspaces");
    const workspace = (response.items ?? response.workspaces ?? []).find(workspace => workspace.id === item.workspaceId);
    root = workspace?.contentPath || workspace?.path;
  }
  if (!root) throw new Error("The file's source is no longer available.");
  return canonicalResultFile(root, item.path ?? item.id, item.fileType === "folder");
}
export async function requirePairing(): Promise<Pairing | null> {
  const pairing = await readPairing();
  if (!pairing) await showToast({ style: Toast.Style.Failure, title: "LegalWork is not paired", message: "Enable Raycast pairing in LegalWork Settings, Assistant launcher." });
  return pairing;
}
