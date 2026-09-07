/** @jsxImportSource react */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { DocxEditorApi } from "./artifact-docx-editor";
import { artifactDocumentKey, reconcileDocxSnapshot, registerUnsavedDocument, savedDocxSnapshot, type DocxSnapshot } from "./docx-document-state";
import { type ArtifactPanelTab, usePanelTabStore } from "../panel/panel-tab-store";
import { isCollectibleArtifactTarget, type BinaryData, type Data, type OpenTarget, type TextData } from "./open-target";
import { HTMLPreview, ImagePreview, MarkdownPreview, PdfPreview, PlainText, PreviewError, PreviewLoading, PreviewUnavailable } from "./preview";

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

const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];

type ArtifactPanelProps = {
  sessionId: string;
  tab: ArtifactPanelTab;
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
};

type ArtifactPanelViewProps = {
  sessionId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  onClose: () => void;
};

type ArtifactQueryState =
  | (TextData & { updatedAt: number | null })
  | (BinaryData & { contentType: string | null; updatedAt: number | null; revision: number });

type SaveArtifactInput = Data & { baseUpdatedAt: number | null };

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

export function ArtifactPanel({ sessionId, tab, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, onClose }: ArtifactPanelProps) {
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId] ?? EMPTY_TRANSCRIPT_TARGETS);
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

  if (!target || !client || !workspaceId) {
    return null;
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

function ArtifactPanelView({ sessionId, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, target, onClose }: ArtifactPanelViewProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [documentSnapshot, setDocumentSnapshot] = useState<DocxSnapshot | null>(null);
  const [documentDirty, setDocumentDirty] = useState(false);
  const documentDirtyRef = useRef(false);
  const docxApi = useRef<DocxEditorApi | null>(null);
  const officeApi = useRef<OfficeEditorApi | null>(null);
  const isOfficeEditor = /\.(pptx|xlsx)$/i.test(target.value);
  const isBinaryEditor = target.preview === "word" || isOfficeEditor;
  const [documentSaving, setDocumentSaving] = useState(false);
  const isEditableDocument = isBinaryEditor && target.kind === "file" && !isRemoteWorkspace;
  const onDocumentDirtyChange = useCallback((dirty: boolean) => {
    documentDirtyRef.current = dirty;
    setDocumentDirty(dirty);
  }, []);

  useEffect(() => {
    if (!isEditableDocument) return;
    return registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, target.id), target.name, () => documentDirtyRef.current, () => docxApi.current?.discardRecovery());
  }, [isEditableDocument, sessionId, target.id, target.name, workspaceId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!documentDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  // Markdown renders by default (MarkdownPreview); the "Edit" button toggles to raw source.
  const isDirectTextEdit = false;
  const externalPath = useMemo(() => target.kind === "file" ? absoluteWorkspacePath(workspaceRoot, target.value) : target.value, [target.kind, target.value, workspaceRoot]);

  const { data: fileIcon } = useQuery<string | null>({
    queryKey: ["desktop-file-icon", externalPath] as const,
    queryFn: async () => getDesktopFileIcon(externalPath, "small"),
    enabled: target.kind === "file" && !isRemoteWorkspace && isElectronRuntime(),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });

  const { data, error, isError, isLoading } = useQuery<ArtifactQueryState>({
    queryKey: ["artifact-panel", workspaceId, target.id] as const,
    queryFn: async () => {
      if (target.kind === "url") {
        throw new Error("URLs open in browser tabs.");
      }
      else if (target.exists === false) {
        throw new Error("File not found in this workspace.");
      }

      if (isTextContent(target)) {
        const result = await client.readWorkspaceFile(workspaceId, target.value);
        
        return { kind: "text", data: result.content, updatedAt: result.updatedAt ?? null };
      }

      const result = await client.downloadWorkspaceFile(workspaceId, target.value);
      const updatedAt = result.updatedAt ?? target.updatedAt ?? null;

      return {
        kind: "binary",
        data: result.data,
        contentType: result.contentType,
        updatedAt,
        revision: nextBinaryRevision(result.updatedAt),
      };
    },
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const [binaryObjectUrl, setBinaryObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isBinaryEditor || data?.kind !== "binary") return;
    setDocumentSnapshot((current) => reconcileDocxSnapshot(current, data, documentDirtyRef.current || documentSaving));
  }, [data, documentDirty, documentSaving, isBinaryEditor]);

  useEffect(() => {
    if (!data || data.kind !== "binary") {
      setBinaryObjectUrl(null);

      return;
    }

    // Force application/pdf for PDF targets so the browser renders it inline
    // instead of treating an octet-stream blob as a download.
    const blobType = target.preview === "pdf" ? "application/pdf" : data.contentType ?? "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.data], { type: blobType }));

    setBinaryObjectUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [data, target.preview]);

  // Bridge for sandboxed HTML artifacts (e.g. the tabular-review PDF viewer): the iframe
  // cannot read local files, so it postMessages a request and we return the bytes.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const request = event.data as { type?: unknown; path?: unknown; id?: unknown } | null;
      if (!request || request.type !== "legalwork:pdf-request" || typeof request.path !== "string") {
        return;
      }
      const source = event.source as Window | null;
      if (!source) {
        return;
      }
      const path = request.path;
      const id = typeof request.id === "string" ? request.id : path;
      void (async () => {
        try {
          const result = await client.downloadWorkspaceFile(workspaceId, path);
          source.postMessage(
            { type: "legalwork:pdf-response", id, path, ok: true, contentType: result.contentType, data: result.data },
            "*",
          );
        } catch (cause) {
          source.postMessage(
            { type: "legalwork:pdf-response", id, path, ok: false, error: cause instanceof Error ? cause.message : "Failed to load file" },
            "*",
          );
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, workspaceId]);

  useEffect(() => {
    setEditing(false);
    setDraft("");
  }, [target.id, workspaceId]);

  useEffect(() => {
    if (data?.kind === "text") {
      setDraft(data.data);
    }
  }, [data]);

  const { mutate, mutateAsync, isPending: isSaving } = useMutation({
    mutationFn: async (input: SaveArtifactInput) => {
      if (target.kind !== "file") {
        throw new Error("Cannot save non-file artifact.");
      }

      if (input.kind === "text") {
        return client.writeWorkspaceFile(workspaceId, { path: target.value, content: input.data, baseUpdatedAt: input.baseUpdatedAt });
      }

      return client.writeWorkspaceBinaryFile(workspaceId, { path: target.value, data: input.data, baseUpdatedAt: input.baseUpdatedAt });
    },
    onSuccess: (result, input) => {
      const savedDocx = isBinaryEditor && input.kind === "binary" && documentSnapshot
        ? savedDocxSnapshot(documentSnapshot, input.data, result.updatedAt ?? null)
        : null;
      if (savedDocx) setDocumentSnapshot(savedDocx);
      queryClient.setQueryData<ArtifactQueryState>(
        ["artifact-panel", workspaceId, target.id] as const,
        input.kind === "text"
          ? { kind: "text", data: input.data, updatedAt: result.updatedAt ?? null }
          : savedDocx ?? {
              kind: "binary",
              data: input.data,
              contentType: data?.kind === "binary" ? data.contentType : null,
              updatedAt: result.updatedAt ?? null,
              revision: nextBinaryRevision(result.updatedAt),
            },
      );

      if (input.kind === "text") {
        setDraft(input.data);
      }
    },
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
      if (!current) throw new Error("The document is still loading. Try downloading again in a moment.");
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
      if (isEditableDocument && documentDirtyRef.current) {
        if (!(await saveDocument())) return;
        if (documentDirtyRef.current) {
          toast.error("New edits were made while saving. Save again before opening externally.");
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

    mutate(
      {
        kind: "text",
        data: draft,
        baseUpdatedAt: data.updatedAt,
      },
      { onSuccess: () => setEditing(false) },
    );
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
      baseUpdatedAt: documentSnapshot ? documentSnapshot.updatedAt : target.updatedAt ?? null,
    });
  };

  const docxSurface = useMemo<LegalworkControlSurface | null>(() => (
    target.preview === "word"
      ? {
          id: `${sessionId}:${target.id}`,
          kind: "document",
          format: "docx",
          sessionId,
          workspaceId,
          name: target.name,
          path: target.value,
          editable: !isRemoteWorkspace && target.kind === "file",
          agentEditsTracked: true,
        }
      : null
  ), [isRemoteWorkspace, sessionId, target.id, target.kind, target.name, target.preview, target.value, workspaceId]);
  useControlSurface(docxSurface);

  const docxAgentControlAction = useMemo<LegalworkControlAction | null>(() => (
    docxSurface?.editable ? {
      id: "document.agent_tool",
      label: `Work on ${target.name}`,
      description: `Read or edit the open in-app Word document ${target.value}. Agent edits are tracked changes and save automatically.`,
      sideEffect: "mutation",
      requiresArgs: true,
      args: [
        { name: "sessionId", type: "string", required: true, description: "The OpenCode session requesting access." },
        { name: "toolName", type: "string", required: true, description: "Editor tool name." },
        { name: "args", type: "object", description: "Arguments for the editor tool." },
      ],
      execute: async (rawArgs) => {
        if (!isRecord(rawArgs)) return { ok: false, error: "Document tool arguments are required." };
        if (stringProperty(rawArgs, "sessionId") !== sessionId) {
          return { ok: false, error: "No in-app Word document is open for this session." };
        }
        const toolName = stringProperty(rawArgs, "toolName");
        const toolArgs = isRecord(rawArgs.args) ? rawArgs.args : {};
        const api = docxApi.current;
        if (!api) return { ok: false, error: "The in-app Word editor is still loading." };
        const result = await api.executeAgentTool(toolName, toolArgs);
        if (!result.success) return { ok: false, error: result.error || `Could not run ${toolName}.` };
        return {
          ok: true,
          document: { name: target.name, path: target.value, trackChanges: true },
          data: result.data,
          saved: result.saved === true,
        };
      },
    } : null
  ), [docxSurface?.editable, sessionId, target.name, target.value]);
  useControlAction(docxAgentControlAction);

  const saveDocument = async () => {
    if (documentSaving || isSaving) return false;
    setDocumentSaving(true);
    try {
      const ok = await (isOfficeEditor ? officeApi.current : docxApi.current)?.save();
      if (ok) toast.success("Saved");
      else toast.error("The document could not be saved. Wait for it to finish loading and try again.");
      return ok === true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save document.");
      return false;
    } finally {
      setDocumentSaving(false);
    }
  };

  const runFileAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the document.");
    }
  };
  const documentChangedOnDisk = documentDirty && documentSnapshot && data?.kind === "binary" && data.updatedAt !== documentSnapshot.updatedAt;

  return (
    <ArtifactFrame
        expandable={isBinaryEditor}
        title={target.name}
        icon={fileIcon ? <img src={fileIcon} alt="" className="size-5 shrink-0 object-contain" /> : <ArtifactIcon type={target.preview} className="size-5" />}
        meta={<>
          {target.exists === false ? "missing" : target.size !== undefined ? formatFileSize(target.size) : null}
          {isEditableDocument && documentSnapshot ? (
            <span className="ms-2" role="status">
              {documentSaving || isSaving ? "Saving…" : documentDirty ? "Unsaved changes" : "Saved"}
            </span>
          ) : null}
        </>}
        actions={<>
          {isTextContent(target) && data?.kind === "text" ? (
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
                            setDraft(data.data);
                          }
                          setEditing(false);
                        }}
                        disabled={isSaving}
                      >
                        Discard
                      </Button>
                    )}
                  />
                  <TooltipContent>Discard changes</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={(
                      <Button variant="default" size="sm" onClick={() => void save()} disabled={isSaving || draft === data.data}>{isSaving ? "Saving" : "Save"}</Button>
                    )}
                  />
                  <TooltipContent>Save changes</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
                  )}
                />
                <TooltipContent>Edit artifact</TooltipContent>
              </Tooltip>
            )
          ) : null}
          {isEditableDocument && data?.kind === "binary" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="default" size="sm" onClick={() => void saveDocument()} disabled={documentSaving || isSaving || !documentSnapshot}>
                    {documentSaving || isSaving ? "Saving" : "Save"}
                  </Button>
                )}
              />
              <TooltipContent>Save changes to the document</TooltipContent>
            </Tooltip>
          ) : null}
          {target.kind === "file" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void runFileAction(download)} aria-label="Download artifact">
                    <Download />
                  </Button>
                )}
              />
              <TooltipContent>Download artifact</TooltipContent>
            </Tooltip>
          ) : null}
          {target.kind === "file" && !isRemoteWorkspace ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void revealExternal()} aria-label="Show in folder">
                    <FolderOpen />
                  </Button>
                )}
              />
              <TooltipContent>Show in folder</TooltipContent>
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
                <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={documentSaving || isSaving} aria-label="Close artifact">
                  <X />
                </Button>
              )}
            />
            <TooltipContent>Close artifact</TooltipContent>
          </Tooltip>
        </>}
      >
      {documentChangedOnDisk ? (
        <div className="shrink-0 border-b border-border bg-muted px-4 py-2 text-xs" role="alert">
          This file changed in the workspace. Your edits are still here. Download a copy to keep them before reopening the latest version.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading || (data?.kind === "binary" && (!binaryObjectUrl || (isBinaryEditor && !documentSnapshot))) ? (
          <PreviewLoading />
        ) : isError ? (
          <PreviewError message={error instanceof Error ? error.message : "Failed to load artifact" } />
        ) : data?.kind === "text" && (editing || isDirectTextEdit) ? (
          <TextEditor value={draft} language={target.preview === "markdown" ? "markdown" : "text"} onChange={setDraft} />
        ) : target.preview === "markdown" && data?.kind === "text" ? (
          <MarkdownPreview content={data.data} />
        ) : isOfficeEditor && documentSnapshot ? (
          <OfficeEditorBoundary key={`${target.id}:${documentSnapshot.revision}`}>
          <Suspense fallback={<PreviewLoading />}>
            {/\.pptx$/i.test(target.value) ? (
              <ArtifactPptxEditor key={`${target.id}:${documentSnapshot.revision}`} name={target.name} content={documentSnapshot.data} readOnly={!isEditableDocument} onSave={saveDocumentContent} apiRef={officeApi} onDirtyChange={onDocumentDirtyChange} onSavingChange={setDocumentSaving} />
            ) : (
              <ArtifactXlsxEditor key={`${target.id}:${documentSnapshot.revision}`} name={target.name} content={documentSnapshot.data} readOnly={!isEditableDocument} onSave={saveDocumentContent} apiRef={officeApi} onDirtyChange={onDocumentDirtyChange} onSavingChange={setDocumentSaving} />
            )}
          </Suspense>
          </OfficeEditorBoundary>
        ) : target.preview === "sheet" && data?.kind === "text" ? (
          <SheetEditor
            name={target.name}
            content={data ?? { kind: "binary", data: new ArrayBuffer(0) }}
            saving={isSaving}
            onSave={saveSpreadsheetContent}
          />
        ) : target.preview === "word" && documentSnapshot ? (
          <DocxView
            key={`${target.id}:${documentSnapshot.revision}`}
            name={target.name}
            content={documentSnapshot.data}
            readOnly={isRemoteWorkspace || target.kind !== "file"}
            onSave={saveDocumentContent}
            apiRef={docxApi}
            onDirtyChange={onDocumentDirtyChange}
            recoveryKey={isEditableDocument ? JSON.stringify([workspaceId, target.value]) : undefined}
            baseUpdatedAt={documentSnapshot.updatedAt}
            onRestore={(baseUpdatedAt) => {
              onDocumentDirtyChange(true);
              setDocumentSnapshot((current) => current ? { ...current, updatedAt: baseUpdatedAt } : current);
            }}
          />
        ) : target.preview === "html" && data?.kind === "text" ? (
          <HTMLPreview type="text" title={target.name} content={data.data} />
        ) : target.preview === "image" && data?.kind === "binary" && binaryObjectUrl ? (
          <ImagePreview src={binaryObjectUrl} alt={target.name} />
        ) : target.preview === "pdf" && data?.kind === "binary" && binaryObjectUrl ? (
          <PdfPreview url={binaryObjectUrl} title={target.name} />
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
