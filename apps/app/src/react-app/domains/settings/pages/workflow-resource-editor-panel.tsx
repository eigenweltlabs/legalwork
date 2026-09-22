import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFrame } from "../../session/artifacts/artifact-frame";
import { ArtifactIcon } from "../../session/artifacts/artifact-icon";
import { OfficeEditorBoundary } from "../../session/artifacts/office-editor-boundary";
import { classifyOpenTarget, type Data } from "../../session/artifacts/open-target";
import { ImagePreview, PdfPreview, PreviewLoading, PreviewUnavailable } from "../../session/artifacts/preview";
import { MediaPreview } from "../../session/artifacts/media-preview";
import type { DocxEditorApi } from "../../session/artifacts/artifact-docx-editor";
import type { OfficeEditorApi } from "../../session/artifacts/office-editor-state";
import type { SpreadsheetEditorApi } from "../../session/artifacts/artifact-spreadsheet-editor";
import { useWorkflowEditorStore } from "../state/workflow-editor-store";
import { editWorkflowResource, reloadWorkflowResource, resourceBase64, resourceBuffer, resourceDirty, saveWorkflowResource, useWorkflowResourceStore, type WorkflowResourceDraft } from "../state/workflow-resource-store";
import { isEditableWorkflowResource, isTextWorkflowResource, workflowResourceMime, workflowResourceType } from "../state/workflow-resource-type";

const MarkdownEditor = lazy(() => import("../../session/artifacts/artifact-markdown-editor").then((module) => ({ default: module.ArtifactMarkdownEditor })));
const TextEditor = lazy(() => import("../../session/artifacts/artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })));
const DocxEditor = lazy(() => import("../../session/artifacts/artifact-docx-editor").then((module) => ({ default: module.ArtifactDocxEditor })));
const XlsxEditor = lazy(() => import("../../session/artifacts/artifact-xlsx-editor").then((module) => ({ default: module.ArtifactXlsxEditor })));
const PptxEditor = lazy(() => import("../../session/artifacts/artifact-pptx-editor").then((module) => ({ default: module.ArtifactPptxEditor })));
const SpreadsheetEditor = lazy(() => import("../../session/artifacts/artifact-spreadsheet-editor").then((module) => ({ default: module.ArtifactSpreadsheetEditor })));

export function WorkflowResourceEditorPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const draft = useWorkflowResourceStore((state) => state.drafts[id]);
  const services = useWorkflowEditorStore((state) => draft ? state.services[draft.workspaceId] : undefined);
  const docxApi = useRef<DocxEditorApi | null>(null);
  const officeApi = useRef<OfficeEditorApi | null>(null);
  const sheetApi = useRef<SpreadsheetEditorApi | null>(null);
  const [serializing, setSerializing] = useState(false);
  const onDirtyChange = useCallback((documentDirty: boolean) => editWorkflowResource(id, { documentDirty }), [id]);
  const saveContent = useCallback(async (payload: Data) => {
    editWorkflowResource(id, { content: payload.kind === "binary" ? resourceBase64(payload.data) : payload.data });
    if (!await saveWorkflowResource(id)) throw new Error(useWorkflowResourceStore.getState().drafts[id]?.error ?? t("skill_resources.save_failed"));
  }, [id]);
  if (!draft) return <div className="p-6 text-sm text-muted-foreground">{t("skill_resources.load_failed")}</div>;
  const type = workflowResourceType(draft.name);
  const editable = isEditableWorkflowResource(draft.name);
  const available = services && services.contextKey === draft.contextKey && services.currentContextKey() === draft.contextKey;
  const busy = draft.saving || serializing;
  const disabled = !available || !services.canEdit || services.busy || busy || draft.loading || !draft.loaded;
  // Keep permissions stable during Save: changing readOnly rebuilds the sheet
  // editor and would replace its live draft with its initial bytes.
  const readOnly = !available || !services.canEdit;
  const dirty = resourceDirty(draft);
  const save = async () => {
    if (disabled) return;
    setSerializing(true);
    try {
      if (type === "word") await docxApi.current?.save();
      else if (type === "xlsx" || type === "pptx") await officeApi.current?.save();
      else if (type === "csv") await sheetApi.current?.save();
      else await saveWorkflowResource(id);
    } catch (error) {
      editWorkflowResource(id, { error: error instanceof Error ? error.message : t("skill_resources.save_failed") });
    } finally { setSerializing(false); }
  };
  const download = () => {
    const bytes = isTextWorkflowResource(draft.name) ? new TextEncoder().encode(draft.baseline) : resourceBuffer(draft.baseline);
    const url = URL.createObjectURL(new Blob([bytes], { type: workflowResourceMime(draft.name) }));
    const link = document.createElement("a");
    link.href = url; link.download = draft.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="h-full min-h-0" onKeyDownCapture={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation();
      if (editable && !disabled) void save();
    }
  }}>
    <ArtifactFrame expandable title={draft.name} icon={<ArtifactIcon type={classifyOpenTarget(draft.name, "file")} />}
      meta={<span role="status">{editable ? busy ? t("common.saving") : dirty ? t("common.unsaved_changes") : t("common.saved") : t("artifact.read_only")}</span>}
      actions={<>
        {editable ? <Button size="sm" disabled={disabled || !dirty} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : null}{t("common.save")}</Button> : <Button variant="ghost" size="icon-sm" aria-label={t("artifact.download")} disabled={!draft.loaded} onClick={download}><Download /></Button>}
        <Button variant="ghost" size="icon-sm" aria-label={t("workflows.reload")} disabled={!available || busy || draft.loading} onClick={() => {
          if (dirty && !window.confirm(t("workflows.discard_file_changes"))) return;
          void reloadWorkflowResource(id);
        }}><RefreshCw /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("artifact.close")} disabled={busy} onClick={onClose}><X /></Button>
      </>}
    >
      {!available ? <p role="status" className="border-b border-border px-4 py-3 text-xs text-muted-foreground">{t("workflows.reopen_workspace")}</p> : null}
      {draft.error ? <p role="alert" className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">{draft.error}</p> : null}
      <div className="min-h-0 flex-1 overflow-hidden" inert={busy}>
        {draft.loading ? <PreviewLoading /> : !draft.loaded ? null : <OfficeEditorBoundary key={`${id}:${draft.revision}`}>
          <Suspense fallback={<PreviewLoading />}>
            <ResourceContent draft={draft} readOnly={readOnly} docxApi={docxApi} officeApi={officeApi} sheetApi={sheetApi} onSave={saveContent} onDirtyChange={onDirtyChange} />
          </Suspense>
        </OfficeEditorBoundary>}
      </div>
    </ArtifactFrame>
  </div>;
}

function ResourceContent({ draft, readOnly, docxApi, officeApi, sheetApi, onSave, onDirtyChange }: {
  draft: WorkflowResourceDraft;
  readOnly: boolean;
  docxApi: RefObject<DocxEditorApi | null>;
  officeApi: RefObject<OfficeEditorApi | null>;
  sheetApi: RefObject<SpreadsheetEditorApi | null>;
  onSave: (payload: Data) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const type = workflowResourceType(draft.name);
  const [initial] = useState(draft.content);
  const buffer = useMemo(() => isTextWorkflowResource(draft.name) ? null : resourceBuffer(initial), [draft.name, initial]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!buffer || isEditableWorkflowResource(draft.name)) return;
    const next = URL.createObjectURL(new Blob([buffer], { type: workflowResourceMime(draft.name) }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [buffer, draft.name]);
  const saveBuffer = useCallback((data: ArrayBuffer) => onSave({ kind: "binary", data }), [onSave]);
  const imageUpload = useCallback((file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("workflows.image_failed")));
    reader.onerror = () => reject(new Error(t("workflows.image_failed")));
    reader.readAsDataURL(file);
  }), []);
  const imagePreview = useCallback(async (source: string) => source, []);
  if (type === "word" && buffer) return <DocxEditor name={draft.name} content={buffer} readOnly={readOnly} onSave={saveBuffer} onDirtyChange={onDirtyChange} apiRef={docxApi} />;
  if (type === "xlsx" && buffer) return <XlsxEditor name={draft.name} content={buffer} readOnly={readOnly} onSave={saveBuffer} onDirtyChange={onDirtyChange} apiRef={officeApi} />;
  if (type === "pptx" && buffer) return <PptxEditor name={draft.name} content={buffer} readOnly={readOnly} onSave={saveBuffer} onDirtyChange={onDirtyChange} apiRef={officeApi} />;
  if (type === "csv") return <SpreadsheetEditor name={draft.name} content={{ kind: "text", data: initial }} readOnly={readOnly} onSave={onSave} onDirtyChange={onDirtyChange} apiRef={sheetApi} hideSave />;
  if (type === "markdown") return <MarkdownEditor value={draft.content} baseline={draft.baseline} readOnly={readOnly} onChange={(content) => editWorkflowResource(draft.id, { content })} imageUpload={imageUpload} imagePreview={imagePreview} />;
  if (isTextWorkflowResource(draft.name)) return <TextEditor value={draft.content} language="text" readOnly={readOnly} onChange={(content) => editWorkflowResource(draft.id, { content })} />;
  if (!url) return <PreviewLoading />;
  if (type === "pdf") return <PdfPreview url={url} title={draft.name} />;
  if (type === "image") return <ImagePreview src={url} alt={draft.name} />;
  if (type === "audio" || type === "video") return <MediaPreview kind={type} src={url} title={draft.name} />;
  return <PreviewUnavailable />;
}
