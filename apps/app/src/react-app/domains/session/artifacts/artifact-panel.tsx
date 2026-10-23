import { documentNavigationSchema } from "@legalwork/types/office-editor";
import { suggestionIdFromFile } from "@legalwork/types/wiki-suggestions";
import { PersistentArtifactPanel, useDocumentAgentControl, useDocumentRuntimeEntry, useDocumentTaskActive } from "./document-runtime";
import { executeWordCopy } from "./docx-agent-copy";
import { isDocumentReadTool } from "./document-agent-read";
import { useDocumentControlSessions } from "../../../shell/control/document-control-sessions";
import { ProjectFilePanel } from "../../workspace/project-file-panel";
import { keepHandoffCopy } from "./document-handoff-copy";
import { binaryMatchesStat, retainBinaryContent } from "./binary-content";
import { flushSync } from "react-dom";
/** @jsxImportSource react */
import { type ReactNode, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FolderOpen, X } from "lucide-react";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { getDesktopFileIcon, openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatFileSize } from "@/lib/utils";
import { useControlAction, useControlSurface, type LegalworkControlAction, type LegalworkControlSurface } from "@/react-app/shell/control/control-provider";
import { OfficeEditorBoundary } from "./office-editor-boundary";
import { ArtifactFrame } from "./artifact-frame";
import { ArtifactIcon } from "./artifact-icon";
import type { OfficeEditorApi } from "./office-editor-state";
import type { SpreadsheetEditorApi } from "./artifact-spreadsheet-editor";
import type { DocxEditorApi } from "./artifact-docx-editor";
import { artifactDocumentKey, reconcileDocxSnapshot, registerUnsavedDocument, savedDocxSnapshot, publishedDocxSnapshot, type DocxSnapshot } from "./docx-document-state";
import { drainDocxRecovery } from "./docx-recovery";
import { type ArtifactPanelTab, usePanelTabStore } from "../panel/panel-tab-store";
import { isCollectibleArtifactTarget, type BinaryData, type Data, type OpenTarget, type TextData } from "./open-target";
import { MediaPreview } from "./media-preview";
import { type PdfPreviewApi, HTMLPreview, ImagePreview, MarkdownPreview, PdfPreview, PlainText, PreviewError, PreviewLoading, PreviewUnavailable } from "./preview";
import { t } from "@/i18n";
import { Switch } from "@/components/ui/switch";
import { DocumentAccessBanner, useDocumentOwnership } from "./use-document-ownership";
import { FileCopyPanel } from "../../workspace/file-copy-job";
import { useDocumentPreferences } from "./document-preferences";
import { loadMarkdownDraft, savedMarkdownDraft, type MarkdownDraft } from "./markdown-draft";
import { useTextAutosave } from "./use-text-autosave";

const ArtifactTextEditor = lazy(() =>
  import("./artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })),
);
const ArtifactSpreadsheetEditor = lazy(() =>
  import("./artifact-spreadsheet-editor").then((module) => ({ default: module.ArtifactSpreadsheetEditor })),
);
const ArtifactDocxEditor = lazy(() =>
  import("./artifact-docx-editor").then((module) => ({ default: module.ArtifactDocxEditor })),
);

const ArtifactPptxEditor = lazy(() => import("./artifact-pptx-editor").then((module) => ({ default: module.ArtifactPptxEditor })));
const ArtifactXlsxEditor = lazy(() => import("./artifact-xlsx-editor").then((module) => ({ default: module.ArtifactXlsxEditor })));

const ArtifactMarkdownPanel = lazy(() => import("./artifact-markdown-panel").then((module) => ({ default: module.ArtifactMarkdownPanel })));
const WikiSuggestionPanel = lazy(() => import("../../wiki/wiki-suggestion-panel").then(module => ({ default: module.WikiSuggestionPanel })));
const ViewFilePanel = lazy(() => import("../../views/view-file-panel").then(module => ({ default: module.ViewFilePanel })));

const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];
const StorageFilePanel = lazy(() => import("../panel/storage-file-panel").then((module) => ({ default: module.StorageFilePanel })));
const SearchSourcePanel = lazy(() => import("../../../shell/search-source-panel").then(module => ({ default: module.SearchSourcePanel })));
const ReviewSourcePanel = lazy(() => import("../../reviews/review-source-panel").then(module => ({ default: module.ReviewSourcePanel })));
const ReviewRecognitionPanel = lazy(() => import("../../reviews/review-recognition-panel").then(module => ({ default: module.ReviewRecognitionPanel })));

export type ArtifactPanelProps = {
  sessionId: string;
  tab: ArtifactPanelTab;
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  localReadOnly?: boolean;
  onClose: () => void;
};

type ArtifactPanelViewProps = {
  sessionId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  sourcePage?: number;
  localReadOnly?: boolean;
  saveActions?: (persist: () => Promise<boolean>, busy: boolean) => ReactNode;
  onClose: () => void;
};

type ArtifactQueryState =
  | (TextData & { updatedAt: number | null })
  | (BinaryData & { contentType: string | null; updatedAt: number | null; downloadedUpdatedAt?: number | null; revision: number });

type SaveArtifactInput = Data & { baseUpdatedAt: number | null; baseContent?: string };

let fallbackBinaryRevision = 0;

function nextBinaryRevision(updatedAt: number | null) {
  if (updatedAt !== null) return updatedAt;
  fallbackBinaryRevision += 1;
  return fallbackBinaryRevision;
}

function absoluteWorkspacePath(root: string, path: string) {
  const cleanRoot = root.trim().replace(/[/\\]+$/, "");
  const cleanPath = path.trim().replace(/^\.\//, "");
  
  return cleanRoot ? `${cleanRoot}/${cleanPath}` : cleanPath;
}

function isTextContent(target: OpenTarget): boolean {
  return ["markdown", "text", "sheet", "html"].includes(target.preview) && !/\.(xlsx|xls|ods)$/i.test(target.value);
}

export function ArtifactPanel(input: ArtifactPanelProps) {
  const props = input.tab.source ? { ...input, workspaceId: input.tab.source.workspaceId, workspaceRoot: input.tab.source.workspaceRoot, isRemoteWorkspace: false } : input;
  if (props.tab.pendingImportId || props.tab.sourceProject || props.tab.searchSources || props.tab.reviewCitation || props.tab.reviewRecognition || !props.client || !props.workspaceId) return <ArtifactPanelContent {...props} />;
  return <PersistentArtifactPanel {...props} />;
}

export function ArtifactPanelContent({ sessionId, tab, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, localReadOnly = false, onClose }: ArtifactPanelProps) {
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[tab.sourceSessionId ?? sessionId] ?? EMPTY_TRANSCRIPT_TARGETS);
  const artifactTargets = useMemo(() => transcriptTargets.filter(isCollectibleArtifactTarget), [transcriptTargets]);
  // Tabs opened from the workspace file browser carry their own path, so they
  // stay viewable even when the transcript never mentioned the file.
  const target = artifactTargets.find((item) => item.id === tab.id) ?? (tab.value ? {
    id: tab.id,
    kind: "file",
    value: tab.value,
    name: tab.label,
    preview: tab.preview,
    confidence: 100,
    reason: "workspace file",
    exists: true,
    size: tab.size,
    updatedAt: tab.updatedAt,
  } satisfies OpenTarget : null);

  if (tab.pendingImportId) return <FileCopyPanel id={tab.pendingImportId} />;
  if (tab.sourceProject) return <ProjectFilePanel key={tab.id} source={tab.sourceProject} tab={tab} sessionId={sessionId} onClose={onClose} />;

  if (tab.storage && client && workspaceId === tab.storage.workspaceId) {
    return <OfficeEditorBoundary key={tab.id}><Suspense fallback={<PreviewLoading />}>
      <StorageFilePanel
        sessionId={sessionId}
        tabId={tab.id}
        workspaceRoot={workspaceRoot}
        isRemoteWorkspace={isRemoteWorkspace}
        client={client}
        workspaceId={tab.storage.workspaceId}
        localReadOnly={localReadOnly}
        root={tab.storage.root}
        file={tab.storage.file}
        onClose={onClose}
      />
    </Suspense></OfficeEditorBoundary>;
  }

  if (!target || !client || !workspaceId) {
    return null;
  }

  if (tab.searchSources?.length) return <OfficeEditorBoundary key={tab.id}><Suspense fallback={<PreviewLoading />}>
    <SearchSourcePanel client={client} workspaceId={workspaceId} sources={tab.searchSources} name={tab.label} onClose={onClose} />
  </Suspense></OfficeEditorBoundary>;
  if (tab.reviewCitation) return <OfficeEditorBoundary key={tab.id}><Suspense fallback={<PreviewLoading />}>
    <ReviewSourcePanel client={client} workspaceId={workspaceId} citation={tab.reviewCitation} name={tab.label} onClose={onClose} />
  </Suspense></OfficeEditorBoundary>;
  if (tab.reviewRecognition) return <OfficeEditorBoundary key={tab.id}><Suspense fallback={<PreviewLoading />}>
    <ReviewRecognitionPanel client={client} workspaceId={workspaceId} reference={tab.reviewRecognition} name={tab.label} onClose={onClose} />
  </Suspense></OfficeEditorBoundary>;

  const suggestionId = tab.wikiSuggestion?.id ?? suggestionIdFromFile(target.value);
  if (suggestionId) return <Suspense fallback={<PreviewLoading />}><WikiSuggestionPanel key={suggestionId} client={client} workspaceId={tab.wikiSuggestion?.workspaceId ?? workspaceId} id={suggestionId} tabId={tab.id} /></Suspense>;

  if (target.preview === "view") return <Suspense fallback={<PreviewLoading />}><ViewFilePanel client={client} workspaceId={workspaceId} path={target.value} tabId={tab.id} /></Suspense>;

  if (target.preview === "markdown") {
    return <OfficeEditorBoundary key={`${workspaceId}:${target.id}`}><Suspense fallback={<PreviewLoading />}>
      <ArtifactMarkdownPanel sessionId={sessionId} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} isRemoteWorkspace={isRemoteWorkspace} localReadOnly={localReadOnly} target={target} onClose={onClose} />
    </Suspense></OfficeEditorBoundary>;
  }

  return (
    <ArtifactPanelView
      key={`${workspaceId}:${target.id}`}
      sessionId={sessionId}
      client={client}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      isRemoteWorkspace={isRemoteWorkspace}
      target={target}
      localReadOnly={localReadOnly}
      sourcePage={tab.sourcePage}
      onClose={onClose}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: Record<string, unknown>, key: string) {
  const property = value[key];
  return typeof property === "string" ? property : "";
}

export function ArtifactPanelView({ sourcePage, localReadOnly = false, saveActions, sessionId, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, target, onClose }: ArtifactPanelViewProps) {
  const taskActive = useDocumentTaskActive();
  const runtimeEntry = useDocumentRuntimeEntry();
  const controlSessionIds = useDocumentControlSessions(sessionId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [textDraft, setTextDraft] = useState<MarkdownDraft | null>(null);
  const textDraftRef = useRef<MarkdownDraft | null>(null);
  const updateTextDraft = useCallback((update: (current: MarkdownDraft | null) => MarkdownDraft | null) => {
    textDraftRef.current = update(textDraftRef.current);
    setTextDraft(textDraftRef.current);
  }, []);
  const draft = textDraft?.content ?? "";
  const setDraft = (content: string) => updateTextDraft(current => current ? { ...current, content } : current);
  const [documentSnapshot, setDocumentSnapshot] = useState<DocxSnapshot | null>(null);
  const [documentDirty, setDocumentDirty] = useState(false);
  const documentDirtyRef = useRef(false);
  const reader = useRef(false);
  const snapshotRef = useRef(documentSnapshot);
  snapshotRef.current = documentSnapshot;
  const pendingWrite = useRef<Promise<unknown> | null>(null);
  const docxApi = useRef<DocxEditorApi | null>(null);
  const pdfApi = useRef<PdfPreviewApi | null>(null);
  const officeApi = useRef<OfficeEditorApi | null>(null);
  const sheetApi = useRef<SpreadsheetEditorApi | null>(null);
  const isTextSheet = target.preview === "sheet" && isTextContent(target);
  const hasSaveActions = Boolean(saveActions);
  const isOfficeEditor = /\.(pptx|xlsx)$/i.test(target.value);
  const isBinaryEditor = target.preview === "word" || isOfficeEditor;
  const [documentSaving, setDocumentSaving] = useState(false);
  const writableFile = target.kind === "file" && !localReadOnly;
  const isEditableDocument = isBinaryEditor && writableFile && !isRemoteWorkspace;
  const autosaveKey = JSON.stringify([workspaceId, target.value]);
  const canAutosaveText = writableFile && target.preview === "text" && !hasSaveActions;
  const canAutosave = (target.preview === "word" && isEditableDocument && !hasSaveActions) || canAutosaveText;
  const autosave = useDocumentPreferences((state) => canAutosave && (canAutosaveText ? state.autosave[autosaveKey] !== false : state.autosave[autosaveKey] === true));
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const onDocumentDirtyChange = useCallback((dirty: boolean) => {
    documentDirtyRef.current = dirty;
    if (dirty) usePanelTabStore.getState().keepTab(sessionId, target.id);
    setDocumentDirty(dirty);
  }, [sessionId, target.id]);

  useEffect(() => {
    if (!isEditableDocument && !(hasSaveActions && isTextSheet)) return;
    return registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, target.id), target.name, () => documentDirtyRef.current, () => { void docxApi.current?.discardRecovery().catch(() => toast.error(t("docx.recovery_not_cleared"))); }, taskActive);
  }, [isEditableDocument, hasSaveActions, isTextSheet, sessionId, target.id, target.name, workspaceId, taskActive]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!documentDirtyRef.current && (!textDraftRef.current || textDraftRef.current.content === textDraftRef.current.baseline)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const isDirectTextEdit = target.preview === "text";
  const externalPath = useMemo(() => target.kind === "file" ? absoluteWorkspacePath(workspaceRoot, target.value) : target.value, [target.kind, target.value, workspaceRoot]);

  const { data: fileIcon } = useQuery<string | null>({
    queryKey: ["desktop-file-icon", externalPath] as const,
    queryFn: async () => getDesktopFileIcon(externalPath, "small"),
    enabled: target.kind === "file" && !isRemoteWorkspace && isElectronRuntime(),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });

  const { data, error, isError, isLoading, refetch } = useQuery<ArtifactQueryState>({
    queryKey: ["artifact-panel", workspaceId, target.id, client.baseUrl, runtimeEntry?.generation] as const,
    queryFn: async () => {
      if (target.kind === "url") {
        throw new Error(t("artifact.urls_open_in_browser"));
      }
      else if (target.exists === false) {
        throw new Error(t("artifact.file_not_found"));
      }

      if (isTextContent(target)) {
        const result = await client.readWorkspaceFile(workspaceId, target.value);
        
        return { kind: "text", data: result.content, updatedAt: result.updatedAt ?? null };
      }

      const previous = queryClient.getQueryData<ArtifactQueryState>(["artifact-panel", workspaceId, target.id, client.baseUrl]);
      if ((localReadOnly || reader.current) && previous?.kind === "binary") {
        // Older servers without stat/version metadata retain the download path.
        const stat = await client.statWorkspaceFile(workspaceId, target.value).catch(() => null);
        if (stat && binaryMatchesStat(previous, stat)) return previous;
      }
      const result = await client.downloadWorkspaceFile(workspaceId, target.value);
      const updatedAt = result.updatedAt ?? target.updatedAt ?? null;

      return {
        kind: "binary",
        data: retainBinaryContent(previous?.kind === "binary" ? previous.data : undefined, result.data),
        contentType: result.contentType,
        downloadedUpdatedAt: result.updatedAt,
        updatedAt,
        revision: nextBinaryRevision(result.updatedAt),
      };
    },
    refetchInterval: localReadOnly ? 2000 : false,
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const access = useDocumentOwnership({
    enabled: isEditableDocument || (writableFile && isTextContent(target)),
    isLocalWorkspace: !isRemoteWorkspace,
    client, workspaceId, path: target.value,
    refresh: async () => {
      const loaded = await refetch();
      if (loaded.error) throw loaded.error;
      if (loaded.data?.kind === "binary" && !documentDirtyRef.current) {
        snapshotRef.current = loaded.data;
        setDocumentSnapshot(loaded.data);
      }
    },
    revision: () => isBinaryEditor ? (isOfficeEditor ? officeApi.current : docxApi.current)?.revision() ?? -1 : isTextSheet && !editing ? sheetApi.current?.revision() ?? "" : textDraftRef.current?.content ?? "",
    dirty: () => {
      const current = textDraftRef.current;
      return Boolean((target.preview === "word" ? docxApi.current?.isDirty() : documentDirtyRef.current) || (current && current.content !== current.baseline));
    },
    discard: async () => {
      const current = isBinaryEditor ? await (isOfficeEditor ? officeApi.current : docxApi.current)?.getBuffer()
        : isTextSheet && !editing ? await sheetApi.current?.getContent() : draft;
      if (current == null) throw new Error(t("artifact.still_loading_download"));
      const payload = typeof current === "string" || current instanceof ArrayBuffer ? current : current.data;
      const copy = await keepHandoffCopy(client, workspaceId, target.value, payload);
      if (target.preview === "word") await docxApi.current?.discardRecovery();
      flushSync(() => {
        if (isTextSheet) sheetApi.current?.discard();
        onDocumentDirtyChange(false);
        if (data?.kind === "text") setDraft(data.data);
        setEditing(false);
      });
      toast.info(t("document_access.copy_kept", { path: copy }));
    },
    flush: async () => {
      if (target.preview === "word") return await docxApi.current?.flushSave() ?? false;
      if (isOfficeEditor) {
        await officeApi.current?.drain();
        return !documentDirtyRef.current || (await officeApi.current?.save() === true && !documentDirtyRef.current);
      }
      await pendingWrite.current;
      if (isTextSheet && !editing) return await sheetApi.current?.save() ?? false;
      if (data?.kind === "text") return saveText();
      setEditing(false);
      return true;
    },
    drain: async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const editorDrain = isOfficeEditor ? officeApi.current?.drain() : docxApi.current?.drain();
      try { await pendingWrite.current; } finally {
        await editorDrain;
        // Recovery migration can still be running before the live editor mounts.
        if (target.preview === "word") await drainDocxRecovery();
      }
    },
  });

  const [binaryObjectUrl, setBinaryObjectUrl] = useState<string | null>(null);
  reader.current = access.status === "reader";
  useEffect(() => {
    if (access.status !== "reader" || localReadOnly) return;
    let loading = false;
    const timer = setInterval(() => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      void refetch().finally(() => { loading = false; });
    }, 2000);
    return () => clearInterval(timer);
  }, [access.status, localReadOnly, refetch]);
  const binaryContent = data?.kind === "binary" ? data.data : null;
  const binaryContentType = data?.kind === "binary" ? data.contentType : null;

  useEffect(() => {
    if (!isBinaryEditor || data?.kind !== "binary") return;
    setDocumentSnapshot((current) => reconcileDocxSnapshot(current, data, documentDirtyRef.current || documentSaving));
  }, [data, documentDirty, documentSaving, isBinaryEditor]);

  useEffect(() => {
    if (!binaryContent) {
      setBinaryObjectUrl(null);

      return;
    }

    // Force application/pdf for PDF targets so the browser renders it inline
    // instead of treating an octet-stream blob as a download.
    const blobType = target.preview === "pdf" ? "application/pdf" : binaryContentType ?? "application/octet-stream";
    const url = URL.createObjectURL(new Blob([binaryContent], { type: blobType }));

    setBinaryObjectUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [binaryContent, binaryContentType, target.preview]);

  useEffect(() => {
    setEditing(false);
    updateTextDraft(() => null);
  }, [target.id, workspaceId, updateTextDraft]);

  useEffect(() => {
    if (data?.kind === "text") {
      updateTextDraft(current => loadMarkdownDraft(current, data.data, data.updatedAt));
    }
  }, [data, updateTextDraft]);

  const { mutateAsync, isPending: isSaving } = useMutation({
    mutationFn: async (input: SaveArtifactInput) => {
      if (target.kind !== "file") {
        throw new Error(t("artifact.cannot_save_non_file"));
      }

      access.assertWrite();
      const operation = input.kind === "text"
        ? client.writeWorkspaceFile(workspaceId, { path: target.value, content: input.data, baseUpdatedAt: input.baseUpdatedAt, baseContent: input.baseContent })
        : client.writeWorkspaceBinaryFile(workspaceId, { path: target.value, data: input.data, baseUpdatedAt: input.baseUpdatedAt });
      pendingWrite.current = operation;
      const clear = () => { if (pendingWrite.current === operation) pendingWrite.current = null; };
      void operation.then(clear, clear);
      return operation;
    },
    onSuccess: (result, input) => {
      const savedDocx = isBinaryEditor && input.kind === "binary" && snapshotRef.current
        ? savedDocxSnapshot(snapshotRef.current, input.data, result.updatedAt ?? null)
        : null;
      if (savedDocx) { snapshotRef.current = savedDocx; setDocumentSnapshot(savedDocx); }
      access.saved();
      queryClient.setQueryData<ArtifactQueryState>(
        ["artifact-panel", workspaceId, target.id, client.baseUrl, runtimeEntry?.generation] as const,
        input.kind === "text"
          ? { kind: "text", data: result.content ?? input.data, updatedAt: result.updatedAt ?? null }
          : savedDocx ? publishedDocxSnapshot(savedDocx, nextBinaryRevision(result.updatedAt ?? null)) : {
              kind: "binary",
              data: input.data,
              contentType: data?.kind === "binary" ? data.contentType : null,
              updatedAt: result.updatedAt ?? null,
              revision: nextBinaryRevision(result.updatedAt),
            },
      );

      if (input.kind === "text") {
        updateTextDraft(current => {
          if (!current) return current;
          const written = result.content ?? input.data;
          if (current.content === input.data) return { content: written, baseline: written, updatedAt: result.updatedAt ?? null };
          return result.merged ? { ...current, baseline: input.data } : savedMarkdownDraft(current, input.data, result.updatedAt ?? null);
        });
        automaticTextSave.saved();
      }
    },
  });

  const pendingTextSave = useRef<Promise<boolean> | null>(null);
  const saveText = (): Promise<boolean> => {
    if (pendingTextSave.current) return pendingTextSave.current;
    const snapshot = textDraftRef.current;
    // A handoff flush still owns the file while ordinary editing is suspended.
    if (!snapshot || !writableFile || !access.ownsFile) return Promise.resolve(false);
    if (snapshot.content === snapshot.baseline) return Promise.resolve(true);
    const operation = mutateAsync({ kind: "text", data: snapshot.content, baseContent: snapshot.baseline, baseUpdatedAt: snapshot.updatedAt })
      .then(() => true)
      .finally(() => { pendingTextSave.current = null; });
    pendingTextSave.current = operation;
    return operation;
  };
  const automaticTextSave = useTextAutosave({
    enabled: canAutosaveText && autosave,
    suspended: !access.editable || !writableFile,
    content: draft,
    isDirty: () => Boolean(textDraftRef.current && textDraftRef.current.content !== textDraftRef.current.baseline),
    save: saveText,
  });

  const download = async () => {
    if (target.kind === "url") {
      return;
    }
    
    // Download the visible draft, including unsaved edits or a recovery copy after
    // a conflict. Reading the workspace here would silently export an older version.
    let buffer: ArrayBuffer;
    let contentType: string | null;
    if (isEditableDocument) {
      const current = await (isOfficeEditor ? officeApi.current : docxApi.current)?.getBuffer();
      if (!current) throw new Error(t("artifact.still_loading_download"));
      buffer = current;
      contentType = isOfficeEditor ? (data?.kind === "binary" ? data.contentType : null) : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else {
      const result = await client.downloadWorkspaceFile(workspaceId, target.value);
      buffer = result.data;
      contentType = result.contentType;
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = target.name;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExternal = async () => {
    if (target.kind === "url") {
      window.open(target.value, "_blank", "noopener,noreferrer");

      return;
    }
    else if (!isRemoteWorkspace) {
      if (saveActions && data?.kind === "text" && draft !== data.data && !(await persistWorkingCopy())) return;
      if (isEditableDocument && documentDirtyRef.current) {
        if (!(await saveDocument())) return;
        if (documentDirtyRef.current) {
          toast.error(t("artifact.edits_while_saving"));
          return;
        }
      }
      await openDesktopPath(externalPath);

      return;
    }

    await download();
  };

  const revealExternal = async () => {
    if (target.kind !== "file" || isRemoteWorkspace) return;
    await revealDesktopItemInDir(externalPath);
  };

  const save = () => {
    if (target.kind !== "file" || !isTextContent(target) || data?.kind !== "text") {
      return;
    }

    void saveText().then(saved => { if (saved) setEditing(false); }).catch(error => {
      toast.error(error instanceof Error ? error.message : t("artifact.save_failed"));
    });
  };

  const saveSpreadsheetContent = async (payload: Data) => {
    if (target.kind !== "file") {
      return;
    }

    await mutateAsync({
      ...payload,
      baseUpdatedAt: data?.kind === payload.kind ? data.updatedAt : target.updatedAt ?? null,
    });
  };

  const saveDocumentContent = async (buffer: ArrayBuffer) => {
    if (target.kind !== "file") {
      return;
    }

    await mutateAsync({
      kind: "binary",
      data: buffer,
      baseUpdatedAt: snapshotRef.current ? snapshotRef.current.updatedAt : target.updatedAt ?? null,
    });
  };

  const documentSurface = useMemo<LegalworkControlSurface | null>(() => (
    (isBinaryEditor || target.preview === "pdf")
      ? {
          id: `${sessionId}:${target.id}`,
          kind: "document",
          format: target.preview === "pdf" ? "pdf" : target.preview === "word" ? "docx" : /\.xlsx$/i.test(target.value) ? "xlsx" : "pptx",
          sessionId,
          workspaceId,
          name: target.name,
          path: target.value,
          editable: isEditableDocument && access.editable,
          agentEditsTracked: target.preview === "word",
        }
      : null
  ), [isBinaryEditor, isRemoteWorkspace, isEditableDocument, access.editable, sessionId, target.id, target.kind, target.name, target.preview, target.value, workspaceId]);
  useControlSurface(documentSurface);

  const documentAgentControlAction = useMemo<LegalworkControlAction | null>(() => (
    documentSurface && isBinaryEditor ? {
      id: target.preview === "word" ? "document.agent_tool" : "office.agent_tool",
      label: `Work on ${target.name}`,
      description: `Read or edit ${target.value} in the live editor. Edits save automatically.${target.preview === "word" ? " Body text proposals are tracked changes; native structure tools report direct edits." : " Office edits are direct edits, without tracked changes."}`,
      sideEffect: "mutation",
      requiresArgs: true,
      args: [
        { name: "sessionId", type: "string", required: true, description: "The OpenCode session requesting access." },
        { name: "path", type: "string", description: "Exact workspace path; required for PowerPoint and Excel." },
        { name: "toolName", type: "string", required: true, description: "Editor tool name." },
        { name: "args", type: "object", description: "Arguments for the editor tool." },
      ],
      execute: async (rawArgs) => {
        if (!isRecord(rawArgs)) return { ok: false, error: "Document tool arguments are required." };
        if (!controlSessionIds.includes(stringProperty(rawArgs, "sessionId"))) {
          return { ok: false, error: "No in-app document is open for this session." };
        }
        const toolName = stringProperty(rawArgs, "toolName");
        if ((!isEditableDocument || !access.editable) && !isDocumentReadTool(target.preview === "word" ? "docx" : "office", toolName)) return { ok: false, error: t("document_access.read_only") };
        const toolArgs = isRecord(rawArgs.args) ? rawArgs.args : {};
        if (target.preview !== "word" && stringProperty(rawArgs, "path") !== target.value) return { ok: false, error: "The active file changed. Read the sidebar snapshot and select the intended file before retrying." };
        const api = target.preview === "word" ? docxApi.current : officeApi.current;
        if (!api) return { ok: false, error: "The in-app editor is still loading." };
        if (toolName === "prepare_file_edit") {
          if (!isEditableDocument) return { ok: false, error: "This document is read-only. Open an editable workspace copy first." };
          await api.drain();
          const saved = target.preview === "word" ? await docxApi.current?.flushSave()
            : !documentDirtyRef.current || await api.save();
          if (!saved || documentDirtyRef.current) return { ok: false, error: "The document still has unsaved changes. File editing is not ready; the draft remains open." };
          // Release the live editor before a file pipeline writes, so a stale
          // draft can never overwrite those changes. Opening again refetches it.
          if (!runtimeEntry) onClose();
          return { ok: true, saved: true, path: target.value, nextStep: "Edit the saved file, then use inapp_documents_open to reopen it before continuing." };
        }
        const copying = target.preview === "word" && (toolName === "create_comparison_copy" || toolName === "create_clean_copy");
        if (copying && (!client || !workspaceId)) return { ok: false, error: "The task's project is unavailable." };
        const result = copying && client && workspaceId && (toolName === "create_comparison_copy" || toolName === "create_clean_copy")
          ? await executeWordCopy(api, client, workspaceId, toolName, toolArgs)
          : await api.executeAgentTool(toolName, toolArgs);
        if (!result.success) return { ok: false, error: result.error || `Could not run ${toolName}.`, data: result.data, saved: result.saved === true };
        return {
          ok: true,
          document: { name: target.name, path: target.value, trackChanges: target.preview === "word" },
          data: result.data,
          saved: result.saved === true,
        };
      },
    } : null
  ), [documentSurface, isBinaryEditor, controlSessionIds, sessionId, target.name, target.preview, target.value, isEditableDocument, access.editable, onClose, runtimeEntry, client, workspaceId]);
  useDocumentAgentControl(documentSurface, documentAgentControlAction, () =>
    access.status !== "checking" && Boolean(target.preview === "word" ? docxApi.current?.isReady() : officeApi.current?.isReady()), () => documentDirtyRef.current, () => snapshotRef.current?.updatedAt ?? null);

  useControlAction(useMemo<LegalworkControlAction | null>(() => documentSurface ? {
    id: "documents.navigate", label: "Show a requested document location", sideEffect: "navigation", requiresArgs: true,
    description: "Only when explicitly requested by the user. Navigate the active PDF/DOCX page, PPTX slide or Excel sheet/range without editing or saving.",
    args: [{ name: "sessionId", type: "string", required: true }, { name: "path", type: "string", required: true }, { name: "target", type: "object", required: true }],
    execute: async rawArgs => {
      if (!isRecord(rawArgs) || !controlSessionIds.includes(stringProperty(rawArgs, "sessionId"))) return { ok: false, error: "No document is open for this session." };
      const parsed = documentNavigationSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, error: "Provide the exact file path and a valid destination." };
      if (parsed.data.path !== target.value) return { ok: false, error: "The active file changed. Select the intended document and retry." };
      if (target.preview === "pdf") {
        if (parsed.data.target.kind !== "page") return { ok: false, error: "PDF navigation requires a page number." };
        if (!pdfApi.current) return { ok: false, error: "The PDF is still loading." };
        const page = parsed.data.target.page;
        return { ok: true, path: target.value, ...await pdfApi.current.navigate(page) };
      }
      const api = target.preview === "word" ? docxApi.current : officeApi.current;
      if (!api) return { ok: false, error: "The document is still loading." };
      try { return { ok: true, path: target.value, location: await api.navigate(parsed.data.target) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Navigation failed." }; }
    },
  } : null, [documentSurface, controlSessionIds, target.value, target.preview]));

  const saveDocument = async () => {
    if (!access.editable || documentSaving || isSaving) return false;
    setDocumentSaving(true);
    try {
      const ok = await (isOfficeEditor ? officeApi.current : docxApi.current)?.save();
      if (ok) toast.success(t("artifact.saved"));
      else toast.error(t("artifact.save_wait_loading"));
      return ok === true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("artifact.save_failed"));
      return false;
    } finally {
      setDocumentSaving(false);
    }
  };

  const persistWorkingCopy = async () => {
    if (!access.editable || isSaving || documentSaving || localReadOnly) return false;
    if (isTextSheet && !editing) return (await sheetApi.current?.save()) ?? false;
    if (data?.kind === "text") {
      const saved = await saveText();
      if (saved) setEditing(false);
      return saved;
    } else if (isEditableDocument && documentDirtyRef.current) {
      if (!(await saveDocument()) || documentDirtyRef.current) return false;
    }
    return true;
  };

  const textDirtyRef = useRef(false);
  textDirtyRef.current = Boolean(textDraft && draft !== textDraft.baseline);
  useEffect(() => { if (textDirtyRef.current) usePanelTabStore.getState().keepTab(sessionId, target.id); }, [draft, data, sessionId, target.id]);
  useEffect(() => {
    if (!writableFile || isBinaryEditor || isTextSheet) return;
    return registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, target.id), target.name, () => textDirtyRef.current, undefined, taskActive);
  }, [writableFile, isBinaryEditor, isTextSheet, workspaceId, sessionId, target.id, target.name, taskActive]);

  const runFileAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("artifact.open_failed"));
    }
  };
  const documentChangedOnDisk = documentDirty && documentSnapshot && data?.kind === "binary" && data.updatedAt !== documentSnapshot.updatedAt;

  return (
    <ArtifactFrame
        expandable={isBinaryEditor || isDirectTextEdit || target.preview === "audio" || target.preview === "video"}
        title={target.name}
        icon={fileIcon ? <img src={fileIcon} alt="" className="size-5 shrink-0 object-contain" /> : <ArtifactIcon type={target.preview} className="size-5" />}
        meta={<>
          {target.exists === false ? "missing" : target.size !== undefined ? formatFileSize(target.size) : null}
          {isEditableDocument && documentSnapshot ? (
            <span className="ms-2 inline-grid whitespace-nowrap text-end" role="status">
              <span aria-hidden className="invisible col-start-1 row-start-1">{t("common.unsaved_changes")}</span>
              <span className="col-start-1 row-start-1">{documentSaving || isSaving ? t("common.saving") : autosaveError ? t("artifact.autosave_paused") : documentDirty ? t("common.unsaved_changes") : t("common.saved")}</span>
            </span>
          ) : null}
          {isDirectTextEdit && textDraft && <span className="ms-2 whitespace-nowrap" role="status">
            {isSaving ? t("common.saving") : automaticTextSave.error ? t("artifact.autosave_paused") : draft !== textDraft.baseline ? t("common.unsaved_changes") : t("common.saved")}
          </span>}
        </>}
        actions={<>
          {canAutosave && access.editable && <label className="me-3 flex shrink-0 items-center gap-1.5 text-xs" title={t("artifact.autosave_description")}>
            <Switch size="sm" checked={autosave} onCheckedChange={(enabled) => useDocumentPreferences.getState().setAutosave(autosaveKey, enabled)} />
            {t("artifact.autosave")}
          </label>}
          {saveActions && data && access.editable ? saveActions(persistWorkingCopy, isSaving || documentSaving) : null}
          {isTextContent(target) && data?.kind === "text" && !localReadOnly && access.editable && !(hasSaveActions && isTextSheet) ? (
            editing || isDirectTextEdit ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (data?.kind === "text") {
                            updateTextDraft(() => ({ content: data.data, baseline: data.data, updatedAt: data.updatedAt }));
                            automaticTextSave.saved();
                          }
                          setEditing(false);
                        }}
                        disabled={isSaving}
                      >
                        Discard
                      </Button>
                    )}
                  />
                  <TooltipContent>{t("artifact.discard_changes")}</TooltipContent>
                </Tooltip>
                {!saveActions && <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button variant="default" size="sm" onClick={() => void save()} disabled={isSaving || draft === textDraft?.baseline} aria-busy={isSaving} className={isSaving ? "disabled:opacity-100" : undefined}>{t("common.save")}</Button>
                    )}
                  />
                  <TooltipContent>{t("artifact.save_changes")}</TooltipContent>
                </Tooltip>}
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
                  )}
                />
                <TooltipContent>{t("artifact.edit")}</TooltipContent>
              </Tooltip>
            )
          ) : null}
          {!saveActions && isEditableDocument && access.editable && data?.kind === "binary" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="default" size="sm" onClick={() => void saveDocument()} disabled={documentSaving || isSaving || !documentSnapshot} aria-busy={documentSaving || isSaving} className={documentSaving || isSaving ? "disabled:opacity-100" : undefined}>
                    {t("common.save")}
                  </Button>
                )}
              />
              <TooltipContent>{t("artifact.save_changes_tooltip")}</TooltipContent>
            </Tooltip>
          ) : null}
          {target.kind === "file" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void runFileAction(download)} aria-label={t("artifact.download")}>
                    <Download />
                  </Button>
                )}
              />
              <TooltipContent>{t("artifact.download")}</TooltipContent>
            </Tooltip>
          ) : null}
          {target.kind === "file" && !isRemoteWorkspace ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void revealExternal()} aria-label={t("artifact.show_in_folder")}>
                    <FolderOpen />
                  </Button>
                )}
              />
              <TooltipContent>{t("artifact.show_in_folder")}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={() => void runFileAction(openExternal)} disabled={documentSaving || isSaving} aria-label={isRemoteWorkspace ? "Download artifact" : "Open externally"}>
                  <ExternalLink />
                </Button>
              )}
            />
            <TooltipContent>{isRemoteWorkspace ? "Download artifact" : "Open externally"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={documentSaving || isSaving} aria-label={t("artifact.close")}>
                  <X />
                </Button>
              )}
            />
            <TooltipContent>{t("artifact.close")}</TooltipContent>
          </Tooltip>
        </>}
      >
      <DocumentAccessBanner access={access} />
      {autosaveError && <div className="shrink-0 border-b border-border bg-muted px-4 py-2 text-xs" role="alert">
        {t("artifact.autosave_failed")} <span>{autosaveError}</span>
      </div>}
      {automaticTextSave.error && <div className="shrink-0 border-b border-border bg-muted px-4 py-2 text-xs" role="alert">
        {t("artifact.autosave_failed")} <span>{automaticTextSave.error}</span>
      </div>}
      {documentChangedOnDisk ? (
        <div className="shrink-0 border-b border-border bg-muted px-4 py-2 text-xs" role="alert">
          {t("artifact.file_changed_note")}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden" inert={access.status === "offering" || access.status === "releasing"}>
        {isLoading || access.status === "checking" || (data?.kind === "binary" && (!binaryObjectUrl || (isBinaryEditor && !documentSnapshot))) ? (
          <PreviewLoading />
        ) : isError ? (
          <PreviewError message={error instanceof Error ? error.message : t("artifact.load_failed") } />
        ) : data?.kind === "text" && (editing || isDirectTextEdit) ? (
          <TextEditor value={draft} name={target.name} language={target.preview === "markdown" ? "markdown" : "text"} readOnly={localReadOnly || !access.editable} onSave={save} onChange={value => { if (!localReadOnly && access.editable) setDraft(value); }} />
        ) : target.preview === "markdown" && data?.kind === "text" ? (
          <MarkdownPreview content={data.data} />
        ) : isOfficeEditor && documentSnapshot ? (
          <OfficeEditorBoundary key={`${target.id}:${documentSnapshot.revision}:${access.ownsFile}`}>
          <Suspense fallback={<PreviewLoading />}>
            {/\.pptx$/i.test(target.value) ? (
              <ArtifactPptxEditor key={`${target.id}:${documentSnapshot.revision}:${access.ownsFile}`} name={target.name} content={documentSnapshot.data} readOnly={!isEditableDocument || !access.ownsFile} interactionLocked={!access.editable} onSave={saveDocumentContent} apiRef={officeApi} onDirtyChange={onDocumentDirtyChange} onSavingChange={setDocumentSaving} />
            ) : (
              <ArtifactXlsxEditor key={`${target.id}:${documentSnapshot.revision}:${access.ownsFile}`} name={target.name} content={documentSnapshot.data} readOnly={!isEditableDocument || !access.ownsFile} interactionLocked={!access.editable} onSave={saveDocumentContent} apiRef={officeApi} onDirtyChange={onDocumentDirtyChange} onSavingChange={setDocumentSaving} />
            )}
          </Suspense>
          </OfficeEditorBoundary>
        ) : target.preview === "sheet" && data?.kind === "text" ? (
          <SheetEditor
            apiRef={sheetApi}
            onDirtyChange={onDocumentDirtyChange}
            readOnly={localReadOnly || isRemoteWorkspace || !access.ownsFile}
            hideSave={hasSaveActions}
            name={target.name}
            content={data ?? { kind: "binary", data: new ArrayBuffer(0) }}
            saving={isSaving}
            onSave={saveSpreadsheetContent}
          />
        ) : target.preview === "word" && documentSnapshot ? (
          <DocxView
            key={`${target.id}:${documentSnapshot.revision}:${access.ownsFile}`}
            name={target.name}
            content={documentSnapshot.data}
            readOnly={localReadOnly || isRemoteWorkspace || target.kind !== "file" || !access.ownsFile}
            interactionLocked={!access.editable}
            onSave={saveDocumentContent}
            apiRef={docxApi}
            onDirtyChange={onDocumentDirtyChange}
            autosave={autosave}
            onAutosaveError={setAutosaveError}
            recoveryKey={isEditableDocument && access.ownsFile ? access.key ?? undefined : undefined}
            legacyRecoveryKey={JSON.stringify([workspaceId, target.value])}
            baseUpdatedAt={documentSnapshot.updatedAt}
            onRestore={(baseUpdatedAt) => {
              onDocumentDirtyChange(true);
              const restored = snapshotRef.current ? { ...snapshotRef.current, updatedAt: baseUpdatedAt } : null;
              snapshotRef.current = restored;
              setDocumentSnapshot(restored);
            }}
          />
        ) : target.preview === "html" && data?.kind === "text" ? (
          <HTMLPreview key={`${target.id}:${data.updatedAt}`} type="text" title={target.name} content={data.data} readPdf={(path) => client.downloadWorkspaceFile(workspaceId, path)} />
        ) : (target.preview === "audio" || target.preview === "video") && data?.kind === "binary" && binaryObjectUrl ? (
          <MediaPreview key={binaryObjectUrl} kind={target.preview} src={binaryObjectUrl} title={target.name} />
        ) : target.preview === "image" && data?.kind === "binary" && binaryObjectUrl ? (
          <ImagePreview src={binaryObjectUrl} alt={target.name} />
        ) : target.preview === "pdf" && data?.kind === "binary" && binaryObjectUrl ? (
          <PdfPreview apiRef={pdfApi} url={sourcePage ? `${binaryObjectUrl}#page=${sourcePage}` : binaryObjectUrl} title={target.name} />
        ) : data?.kind === "binary" && binaryObjectUrl && target.preview === "html" ? (
          <HTMLPreview type="binary" title={target.name} url={binaryObjectUrl} />
        ) : data?.kind === "text" ? (
          <PlainText content={data.data} />
        ) : (
          <PreviewUnavailable />
        )}
      </div>
    </ArtifactFrame>
  );
}

interface TextEditorProps extends React.ComponentProps<typeof ArtifactTextEditor> {
  value: string;
  language: "markdown" | "text";
  onChange: (value: string) => void;
}

function TextEditor({ value, language, onChange, ...props }: TextEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactTextEditor value={value} language={language} onChange={onChange} {...props} />
    </Suspense>
  );
}

interface SheetEditorProps extends React.ComponentProps<typeof ArtifactSpreadsheetEditor> {
  
}

function SheetEditor({ className, ...props }: SheetEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactSpreadsheetEditor
        className={className}
        {...props}
      />
    </Suspense>
  );
}

function DocxView(props: React.ComponentProps<typeof ArtifactDocxEditor>) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactDocxEditor {...props} />
    </Suspense>
  );
}
