/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Download, Loader2, Pencil, RefreshCw, Save, Upload, X } from "lucide-react";
import {
  STORAGE_MAX_FILE_BYTES,
  type StorageEntry,
  type StorageFile,
  type StorageRoot,
} from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { ArtifactFrame } from "../artifacts/artifact-frame";
import { ArtifactIcon } from "../artifacts/artifact-icon";
import {
  artifactDocumentKey,
  confirmDiscardDocuments,
  registerUnsavedDocument,
} from "../artifacts/docx-document-state";
import { t } from "@/i18n";
import { classifyOpenTarget } from "../artifacts/open-target";
import { OfficeEditorBoundary } from "../artifacts/office-editor-boundary";
import type { DocxEditorApi } from "../artifacts/artifact-docx-editor";
import type { OfficeEditorApi } from "../artifacts/office-editor-state";

const DocxEditor = lazy(() =>
  import("../artifacts/artifact-docx-editor").then((module) => ({ default: module.ArtifactDocxEditor })),
);
const XlsxEditor = lazy(() =>
  import("../artifacts/artifact-xlsx-editor").then((module) => ({ default: module.ArtifactXlsxEditor })),
);
const PptxEditor = lazy(() =>
  import("../artifacts/artifact-pptx-editor").then((module) => ({ default: module.ArtifactPptxEditor })),
);

export function StorageFilePanel({
  sessionId,
  tabId,
  client,
  workspaceId,
  root,
  file,
  onClose,
}: {
  sessionId: string;
  tabId: string;
  client: LegalworkServerClient;
  workspaceId: string;
  root: StorageRoot;
  file: StorageEntry;
  onClose: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const documentKey = artifactDocumentKey(workspaceId, sessionId, tabId);
  const onDirtyChange = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };
  useEffect(
    () =>
      registerUnsavedDocument(
        documentKey,
        file.name,
        () => dirtyRef.current,
        () => {
          dirtyRef.current = false;
          setDirty(false);
        },
      ),
    [documentKey, file.name],
  );
  const [revision, setRevision] = useState(0);
  const query = useQuery({
    queryKey: ["storage-file", workspaceId, root.id, file.path, revision],
    queryFn: () => client.readStorageFile(workspaceId, root.id, file.path),
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  const reload = () => {
    if (busy || !confirmDiscardDocuments(documentKey)) return;
    onDirtyChange(false);
    setRevision((value) => value + 1);
  };
  if (query.data && !query.error) {
    return (
      <StorageFileEditor
        key={revision}
        client={client}
        workspaceId={workspaceId}
        root={root}
        file={file}
        initial={query.data}
        dirty={dirty}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
        onBusyChange={setBusy}
        onReload={reload}
      />
    );
  }
  return (
    <ArtifactFrame
      title={file.name}
      icon={<ArtifactIcon type={classifyOpenTarget(file.name, "file")} />}
      expandable
      actions={
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("side_panel.close_preview")}>
          <X />
        </Button>
      }
    >
      {query.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <AlertCircle className="size-6 text-muted-foreground" />
          <p role="alert" className="max-w-lg text-center text-sm">
            {query.error.message}
          </p>
          <Button variant="outline" onClick={reload}>
            {t("storage.retry")}
          </Button>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}
    </ArtifactFrame>
  );
}

function StorageFileEditor({
  client,
  workspaceId,
  root,
  file,
  initial,
  dirty,
  onClose,
  onDirtyChange,
  onBusyChange,
  onReload,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  root: StorageRoot;
  file: StorageEntry;
  initial: StorageFile;
  dirty: boolean;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const [original] = useState(
    () => Uint8Array.from(atob(initial.dataBase64), (character) => character.charCodeAt(0)).buffer,
  );
  const preview = classifyOpenTarget(file.name, "file");
  const isText = ["text", "markdown", "html"].includes(preview) || /\.(csv|tsv)$/i.test(file.name);
  const isOffice = preview === "word" || /\.(xlsx|pptx)$/i.test(file.name);
  const [draft, setDraft] = useState(() => (isText ? new TextDecoder().decode(original) : ""));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [objectUrl, setObjectUrl] = useState("");
  const version = useRef(initial.version);
  const latest = useRef(original);
  const dirtyRef = useRef(false);
  const docx = useRef<DocxEditorApi | null>(null);
  const office = useRef<OfficeEditorApi | null>(null);
  const replacement = useRef<HTMLInputElement>(null);
  const writable = root.writable && initial.writable;
  const contentType =
    preview === "pdf"
      ? "application/pdf"
      : preview === "image" && initial.contentType === "application/octet-stream"
        ? `image/${file.name.split(".").at(-1)?.replace("jpg", "jpeg")}`
        : initial.contentType;
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([original], { type: contentType }));
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [original, contentType]);
  const changed = (dirty: boolean) => {
    dirtyRef.current = dirty;
    onDirtyChange(dirty);
    setSaved(!dirty && latest.current !== original);
  };
  const save = async (data: ArrayBuffer, mimeType = contentType) => {
    setBusy(true);
    onBusyChange(true);
    setError("");
    setSaved(false);
    try {
      const result = await client.writeStorageFile(workspaceId, root.id, file.path, data, mimeType, version.current);
      version.current = result.version;
      latest.current = data;
      // Office editors track edits made while a save is in flight themselves.
      if (!isOffice) changed(false);
      void queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, root.id] });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("storage.failed");
      setError(message);
      throw cause;
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const download = async () => {
    const bytes = isText
      ? new TextEncoder().encode(draft).buffer
      : isOffice
        ? ((await (preview === "word" ? docx.current : office.current)?.getBuffer()) ?? latest.current)
        : latest.current;
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <ArtifactFrame
      title={`${file.name}${dirty ? " *" : ""}`}
      icon={<ArtifactIcon type={preview} />}
      expandable
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onReload}
            title={t("storage.reload")}
            aria-label={t("storage.reload")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("storage.download")}
            aria-label={t("storage.download")}
            onClick={() =>
              void download().catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : t("storage.failed")),
              )
            }
          >
            <Download className="size-3.5" />
          </Button>
          {writable && !isOffice && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("storage.replace")}
              aria-label={t("storage.replace")}
              disabled={busy || dirtyRef.current}
              onClick={() => replacement.current?.click()}
            >
              <Upload className="size-3.5" />
            </Button>
          )}
          {writable && isText && !editing && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditing(true)}
              title={t("storage.edit")}
              aria-label={t("storage.edit")}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {writable && (isOffice || editing) && (
            <Button
              size="sm"
              aria-label={t("storage.save")}
              title={t("storage.save")}
              disabled={busy}
              onClick={() => {
                if (isText)
                  void save(new TextEncoder().encode(draft).buffer)
                    .then(() => setEditing(false))
                    .catch(() => undefined);
                else
                  void (preview === "word" ? docx.current : office.current)
                    ?.save()
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("storage.failed")));
              }}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {t("common.save")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onClose}
            aria-label={t("side_panel.close_preview")}
          >
            <X />
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={`${root.name} / ${file.path}`}>
          {root.name} / {file.path}
        </span>
        {!writable && <span className="shrink-0">{t("storage.read_only")}</span>}
        {saved && (
          <span role="status" className="shrink-0 text-green-11">
            {t("storage.saved")}
          </span>
        )}
      </div>
      <input
        ref={replacement}
        type="file"
        className="hidden"
        aria-label={t("storage.replace")}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (!selected) return;
          if (selected.size > STORAGE_MAX_FILE_BYTES) {
            setError(t("storage.size_limit"));
            return;
          }
          void selected
            .arrayBuffer()
            .then((data) => save(data, selected.type || "application/octet-stream"))
            .then(onReload)
            .catch(() => undefined);
        }}
      />
      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-auto">
        <OfficeEditorBoundary>
          <Suspense
            fallback={
              <div className="m-auto">
                <Loader2 className="size-6 animate-spin" />
              </div>
            }
          >
            {preview === "word" ? (
              <DocxEditor
                name={file.name}
                content={original}
                readOnly={!writable}
                onSave={save}
                onDirtyChange={changed}
                apiRef={docx}
              />
            ) : /\.xlsx$/i.test(file.name) ? (
              <XlsxEditor
                name={file.name}
                content={original}
                readOnly={!writable}
                onSave={save}
                onDirtyChange={changed}
                onSavingChange={onBusyChange}
                apiRef={office}
              />
            ) : /\.pptx$/i.test(file.name) ? (
              <PptxEditor
                name={file.name}
                content={original}
                readOnly={!writable}
                onSave={save}
                onDirtyChange={changed}
                onSavingChange={onBusyChange}
                apiRef={office}
              />
            ) : isText ? (
              editing ? (
                <textarea
                  aria-label={t("storage.file_content")}
                  className="min-h-full w-full resize-none bg-background p-6 font-mono text-sm leading-6 outline-none"
                  spellCheck={false}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    changed(true);
                  }}
                />
              ) : (
                <pre className="w-full whitespace-pre-wrap break-words p-6 font-mono text-sm leading-6">{draft}</pre>
              )
            ) : preview === "image" ? (
              <img src={objectUrl} alt={file.name} className="m-auto max-h-full max-w-full object-contain p-4" />
            ) : preview === "pdf" ? (
              <iframe title={file.name} src={objectUrl} className="h-full w-full border-0" />
            ) : preview === "audio" ? (
              <audio controls src={objectUrl} className="m-auto" />
            ) : preview === "video" ? (
              <video controls src={objectUrl} className="m-auto max-h-full max-w-full" />
            ) : (
              <div className="m-auto max-w-sm space-y-3 p-6 text-center">
                <Download className="mx-auto size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t("storage.download_to_open")}</p>
                <Button variant="outline" onClick={() => void download()}>
                  {t("storage.download")}
                </Button>
              </div>
            )}
          </Suspense>
        </OfficeEditorBoundary>
      </div>
    </ArtifactFrame>
  );
}
