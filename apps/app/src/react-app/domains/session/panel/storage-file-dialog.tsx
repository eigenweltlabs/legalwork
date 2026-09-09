/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Download, Loader2, Pencil, RefreshCw, Save, Upload } from "lucide-react";
import {
  STORAGE_MAX_FILE_BYTES,
  type StorageEntry,
  type StorageFile,
  type StorageRoot,
} from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export function StorageFileDialog({
  client,
  workspaceId,
  root,
  file,
  onClose,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  root: StorageRoot;
  file: StorageEntry;
  onClose: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"close" | "reload" | null>(null);
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
    setDirty(false);
    setRevision((value) => value + 1);
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) {
            if (dirty) setConfirm("close");
            else onClose();
          }
        }}
      >
        <DialogContent className="flex h-[88dvh] max-w-[1200px] flex-col gap-0 p-0 sm:max-w-[1200px]">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
            <DialogTitle className="truncate text-base">
              {file.name}
              {dirty ? " *" : ""}
            </DialogTitle>
            <DialogDescription className="truncate">
              {root.name} / {file.path}
            </DialogDescription>
          </DialogHeader>
          {query.isLoading ? (
            <div className="grid flex-1 place-items-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : query.error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
              <AlertCircle className="size-6 text-muted-foreground" />
              <p role="alert" className="max-w-lg text-center text-sm">
                {query.error.message}
              </p>
              <Button variant="outline" onClick={reload}>
                {t("storage.retry")}
              </Button>
            </div>
          ) : query.data ? (
            <StorageFileEditor
              key={revision}
              client={client}
              workspaceId={workspaceId}
              root={root}
              file={file}
              initial={query.data}
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
              onReload={() => (dirty ? setConfirm("reload") : reload())}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.unsaved_title")}</DialogTitle>
            <DialogDescription>{t("storage.unsaved_body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t("storage.keep_editing")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === "close") onClose();
                else reload();
              }}
            >
              {t("storage.discard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StorageFileEditor({
  client,
  workspaceId,
  root,
  file,
  initial,
  onDirtyChange,
  onBusyChange,
  onReload,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  root: StorageRoot;
  file: StorageEntry;
  initial: StorageFile;
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-2.5">
        <span className="mr-auto text-xs text-muted-foreground">
          {writable ? t("storage.save_back") : t("storage.read_only")}
        </span>
        {saved && (
          <span role="status" className="text-xs text-green-11">
            {t("storage.saved")}
          </span>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReload}>
          <RefreshCw className="size-3.5" />
          {t("storage.reload")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void download().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : t("storage.failed")),
            )
          }
        >
          <Download className="size-3.5" />
          {t("storage.download")}
        </Button>
        {writable && !isOffice && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || dirtyRef.current}
            onClick={() => replacement.current?.click()}
          >
            <Upload className="size-3.5" />
            {t("storage.replace")}
          </Button>
        )}
        {writable && isText && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            {t("storage.edit")}
          </Button>
        )}
        {writable && (isOffice || editing) && (
          <Button
            size="sm"
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
            {t("storage.save")}
          </Button>
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
    </div>
  );
}
