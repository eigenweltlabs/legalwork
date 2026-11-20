import { type TranslationKey } from "./launcher-labels";
import type { LauncherCaptureResult, LauncherSelectionResult, AssistantContextItem, LauncherCapture, LauncherOrigin } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { launcherCaptureRegion, launcherCaptureWindow, launcherClipboardRead, launcherOriginSelection } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { t } from "@/i18n";

const captureErrorKeys = {
  denied: "launcher.capture.denied",
  unsupported: "launcher.capture.unsupported",
  failed: "launcher.capture.failed",
  cancelled: "launcher.capture.cancelled",
} satisfies Record<Extract<LauncherCaptureResult, { ok: false }>["reason"], TranslationKey>;

const selectionErrorKeys = {
  "no-origin": "launcher.capture.selection_no-origin",
  unsupported: "launcher.capture.selection_unsupported",
  empty: "launcher.capture.selection_empty",
  changed: "launcher.capture.selection_changed",
  denied: "launcher.capture.selection_denied",
  failed: "launcher.capture.selection_failed",
} satisfies Record<Extract<LauncherSelectionResult, { ok: false }>["reason"], TranslationKey>;

export type CaptureOutcome = { ok: true; item: AssistantContextItem } | { ok: false; message: string; cancelled?: boolean };
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;

/** Read the selection against the recorded origin. Unavailable context is reported, never replaced by LegalWork's own input. */
export async function captureSelection(origin: LauncherOrigin | null): Promise<CaptureOutcome> {
  if (!isDesktopRuntime()) return { ok: false, message: t("launcher.capture.desktop_only") };
  if (!origin) return { ok: false, message: t("launcher.capture.no_origin") };
  const result = await launcherOriginSelection(origin.id);
  if (!result.ok) return { ok: false, message: t(selectionErrorKeys[result.reason]) };
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
  const name = screenshotName(capture);
  const file = dataUrlToFile(capture.dataUrl, name);
  if (file.size > MAX_CAPTURE_BYTES) throw new Error(t("launcher.capture.image_too_large"));
  const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: `.legalwork/attachments/${crypto.randomUUID()}/${name}`, data: file, createOnly: true });
  if (!result.ok || !result.path) throw new Error(t("workspace.upload_incomplete"));
  return { id: id("img"), type: "image", workspaceId, name, capture: capture.capture, sourceApp: capture.sourceApp, sourceWindow: capture.sourceWindow, capturedAt: capture.capturedAt, path: result.path };
}
export function screenshotName(capture: LauncherCapture) {
  return `${capture.capture}-${new Date(capture.capturedAt).toISOString().replace(/[:.]/g, "-")}.png`;
}

export async function captureScreen(kind: "window" | "region"): Promise<LauncherCaptureResult> {
  return kind === "window" ? launcherCaptureWindow() : launcherCaptureRegion();
}

export function screenCaptureError(result: Extract<LauncherCaptureResult, { ok: false }>) {
  return result.reason === "failed" ? result.message || t(captureErrorKeys.failed) : t(captureErrorKeys[result.reason]);
}

/** The direct Fusion runner uses the same protected workspace download as Save image. */
export async function loadStagedCaptureParts(client: Pick<LegalworkServerClient, "downloadWorkspaceFile">, workspaceId: string, items: AssistantContextItem[]) {
  const parts: { type: "file"; mime: string; filename: string; url: string }[] = [];
  let remainingBytes = MAX_CAPTURE_BYTES;
  for (const image of items) {
    if (image.type !== "image" || image.capture === "file") continue;
    if (!image.path) throw new Error(t("launcher.chat.context_unavailable"));
    const { data } = await client.downloadWorkspaceFile(image.workspaceId ?? workspaceId, image.path);
    remainingBytes -= data.byteLength;
    if (remainingBytes < 0) throw new Error(t("launcher.capture.image_too_large"));
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("launcher.chat.context_unavailable")));
      reader.onerror = () => reject(new Error(t("launcher.chat.context_unavailable")));
      reader.readAsDataURL(new Blob([data], { type: "image/png" }));
    });
    parts.push({ type: "file", mime: "image/png", filename: image.name, url });
  }
  return parts;
}
export async function stageFiles(client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">, workspaceId: string, files: File[]): Promise<AssistantContextItem[]> {
  const items: AssistantContextItem[] = [];
  for (const file of files) {
    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
    const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: `.legalwork/attachments/${crypto.randomUUID()}/${filename}`, data: file, createOnly: true });
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
