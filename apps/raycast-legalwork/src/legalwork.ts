import { getSelectedText, open, showToast, Toast } from "@raycast/api";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AssistantContextItem, LauncherSearchResult } from "@legalwork/types/launcher";

/**
 * Transport contract shared with the desktop app:
 *  - A launch URL (`legalwork://assistant/...`) starts or focuses the app and carries identifiers only.
 *  - The pairing file written by LegalWork (Settings, Assistant launcher, Raycast) holds the local server
 *    URL and a per-session token, readable only by this user account. Content goes over that loopback
 *    connection, never into a URL.
 */
export type Pairing = { serverUrl: string; token: string; scheme: string };
export type SearchKind = "files" | "projects" | "chats" | "tasks" | "recordings";
export type SearchResult = LauncherSearchResult;
export type SourceState = { id: string; kind: SearchKind; label: string; coverage: string; count: number };
export type CatalogEntry = { id: string; label: string; description: string | null; kind: string; source: string; requires: string[]; favorite: boolean; quickAction: { id: string } | null };
export type WorkItem = { id: string; workspaceId: string; sessionId: string; projectName: string; title: string; status: string; pendingAttention: number; originConversationId: string | null; result: { outcome: string; preview: string } | null };
export type ContextItem = AssistantContextItem;

function pairingCandidates() {
  const home = homedir();
  const names = ["LegalWork", "LegalWork Dev"];
  const roots = process.platform === "darwin" ? names.map(name => path.join(home, "Library", "Application Support", name))
    : process.platform === "win32" ? names.map(name => path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), name))
    : names.map(name => path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), name));
  return roots.map(root => path.join(root, "launcher-pairing.json"));
}
export async function readPairing(): Promise<Pairing | null> {
  for (const candidate of pairingCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      if (parsed?.enabled === true && typeof parsed.serverUrl === "string" && typeof parsed.token === "string") return { serverUrl: parsed.serverUrl.replace(/\/+$/, ""), token: parsed.token, scheme: typeof parsed.scheme === "string" ? parsed.scheme : "legalwork" };
    } catch { /* try the next profile */ }
  }
  return null;
}
export async function request<T>(pairing: Pairing, route: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`${pairing.serverUrl}${route}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal ?? AbortSignal.timeout(20_000) });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(typeof json?.message === "string" ? json.message : `LegalWork request failed (${response.status})`);
  return json as T;
}
export function invocationId() { return `raycast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
export function assistantLink(scheme: string, action: string, params: Record<string, string | undefined>) {
  const url = new URL(`${scheme}://assistant/${action}`);
  url.searchParams.set("invocation", invocationId());
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}
/** Cold start is an ordinary launch URL; the app shows its own progress and delivers the invocation when the panel is ready. */
export async function launch(action: string, params: Record<string, string | undefined> = {}) {
  const pairing = await readPairing();
  await open(assistantLink(pairing?.scheme ?? "legalwork", action, params));
}
export async function stageSelection(pairing: Pairing): Promise<{ id: string } | null> {
  let text = "";
  try { text = (await getSelectedText()).trim(); } catch { text = ""; }
  if (!text) return null;
  const item: ContextItem = { id: `sel_${Date.now().toString(36)}`, type: "selection", text: text.slice(0, 200_000), sourceApp: null, sourceWindow: null, capturedAt: Date.now() };
  return request<{ id: string }>(pairing, "/launcher/context", { method: "POST", body: { items: [item], source: "raycast", ttlMs: 5 * 60_000 } });
}
/** A file result travels as a staged file reference, never as content and never in the URL. */
export async function stageFile(pairing: Pairing, item: SearchResult): Promise<{ id: string } | null> {
  if (item.kind !== "files" || !item.path) return null;
  const file: ContextItem = item.folderId ? (await request<{ item: ContextItem }>(pairing, `/launcher/folders/${encodeURIComponent(item.folderId)}/attach`, { method: "POST", body: { path: item.path } })).item
    : { id: `file_${Date.now().toString(36)}`, type: "file", workspaceId: item.workspaceId, path: item.path, name: item.title, revision: item.revision ?? null, sourceLabel: item.subtitle ?? null };
  return request<{ id: string }>(pairing, "/launcher/context", { method: "POST", body: { items: [file], source: "raycast", ttlMs: 5 * 60_000 } });
}
export async function requirePairing(): Promise<Pairing | null> {
  const pairing = await readPairing();
  if (!pairing) await showToast({ style: Toast.Style.Failure, title: "LegalWork is not paired", message: "Enable Raycast pairing in LegalWork Settings, Assistant launcher." });
  return pairing;
}
