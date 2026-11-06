import type { AssistantContextItem, LauncherCapture, LauncherOrigin } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { launcherCaptureRegion, launcherCaptureWindow, launcherClipboardRead, launcherOriginSelection } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { t } from "@/i18n";

export type CaptureOutcome = { ok: true; item: AssistantContextItem } | { ok: false; message: string; cancelled?: boolean };
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;

/** Read the selection against the recorded origin. Unavailable context is reported, never replaced by LegalWork's own input. */
export async function captureSelection(origin: LauncherOrigin | null): Promise<CaptureOutcome> {
  if (!isDesktopRuntime()) return { ok: false, message: t("launcher.capture.desktop_only") };
  if (!origin) return { ok: false, message: t("launcher.capture.no_origin") };
  const result = await launcherOriginSelection(origin.id);
  if (!result.ok) return { ok: false, message: result.message || t(`launcher.capture.selection_${result.reason}`) };
  if (!result.text.trim()) return { ok: false, message: t("launcher.capture.selection_empty") };
  return { ok: true, item: { id: id("sel"), type: "selection", text: result.text, sourceApp: result.origin.app, sourceWindow: result.origin.window, capturedAt: Date.now() } };
}
export async function captureClipboard(): Promise<CaptureOutcome> {
  let text = "", capturedAt = Date.now();
  if (isDesktopRuntime()) ({ text, capturedAt } = await launcherClipboardRead());
  else { try { text = await navigator.clipboard.readText(); } catch { return { ok: false, message: t("launcher.capture.clipboard_denied") }; } }
  if (!text.trim()) return { ok: false, message: t("launcher.capture.clipboard_empty") };
  return { ok: true, item: { id: id("clip"), type: "clipboard", text, capturedAt } };
}
function dataUrlToFile(dataUrl: string, name: string) {
  const [header, payload] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(header ?? "")?.[1] ?? "image/png";
  const bytes = Uint8Array.from(atob(payload ?? ""), char => char.charCodeAt(0));
  return new File([bytes], name, { type: mime });
}
/** Captures are saved into the Assistant project so the model reads a real file; the preview keeps its provenance. */
export async function stageCapture(client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">, workspaceId: string, capture: LauncherCapture): Promise<AssistantContextItem> {
  const name = `${capture.capture}-${new Date(capture.capturedAt).toISOString().replace(/[:.]/g, "-")}.png`;
  const file = dataUrlToFile(capture.dataUrl, name);
  const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: `.legalwork/attachments/${crypto.randomUUID()}/${name}`, data: await file.arrayBuffer() });
  if (!result.ok || !result.path) throw new Error(t("workspace.upload_incomplete"));
  return { id: id("img"), type: "image", workspaceId, name, capture: capture.capture, sourceApp: capture.sourceApp, sourceWindow: capture.sourceWindow, capturedAt: capture.capturedAt, path: result.path };
}
export async function captureScreen(kind: "window" | "region", client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">, workspaceId: string): Promise<CaptureOutcome & { preview?: string }> {
  if (!isDesktopRuntime()) return { ok: false, message: t("launcher.capture.desktop_only") };
  const result = kind === "window" ? await launcherCaptureWindow() : await launcherCaptureRegion();
  if (!result.ok) return { ok: false, cancelled: result.reason === "cancelled", message: result.reason === "cancelled" ? t("launcher.capture.cancelled") : result.message || t(`launcher.capture.${result.reason}`) };
  try { return { ok: true, item: await stageCapture(client, workspaceId, result.capture), preview: result.capture.dataUrl }; }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}
export async function stageFiles(client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">, workspaceId: string, files: File[]): Promise<AssistantContextItem[]> {
  const items: AssistantContextItem[] = [];
  for (const file of files) {
    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: `.legalwork/attachments/${crypto.randomUUID()}/${filename}`, data: await file.arrayBuffer() });
    if (!result.ok || !result.path) throw new Error(t("workspace.upload_incomplete"));
    items.push({ id: id("file"), type: "file", workspaceId, path: result.path, name: file.name, revision: `${file.lastModified}:${file.size}`, sourceLabel: null });
  }
  return items;
}
/** A search result becomes a removable file reference with its source project kept visible. */
export function fileReferenceItem(result: { id: string; workspaceId: string | null; title: string; path?: string; revision?: string; subtitle?: string }): AssistantContextItem {
  return { id: id("ref"), type: "file", workspaceId: result.workspaceId, path: result.path ?? result.id, name: result.title, revision: result.revision ?? null, sourceLabel: result.subtitle ?? null };
}
export function taskReferenceItem(result: { id: string; workspaceId: string | null; title: string }): AssistantContextItem {
  return { id: `task_${result.id}`, type: "task", taskId: result.id, workspaceId: result.workspaceId, title: result.title };
}
export function contextItemLabel(item: AssistantContextItem) {
  switch (item.type) {
    case "task": return item.title;
    case "selection": return item.sourceApp ? t("launcher.context.selection_from", { app: item.sourceApp }) : t("launcher.context.selection");
    case "clipboard": return t("launcher.context.clipboard");
    case "file": return item.name;
    case "image": return item.capture === "region" ? t("launcher.context.region") : t("launcher.context.window");
  }
}
export function contextItemDetail(item: AssistantContextItem) {
  switch (item.type) {
    case "task": return t("tasks.column_title");
    case "selection": return item.sourceWindow ?? item.text.slice(0, 80);
    case "clipboard": return item.text.slice(0, 80);
    case "file": return item.sourceLabel ?? item.path;
    case "image": return [item.sourceApp, item.sourceWindow].filter(Boolean).join(" · ") || item.name;
  }
}
