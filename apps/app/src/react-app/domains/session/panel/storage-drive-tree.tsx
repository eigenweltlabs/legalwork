/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronRight, FolderPlus, Loader2, LockKeyhole, RefreshCw, Upload } from "lucide-react";
import { type StorageEntry, type StorageRoot, type StorageTransferProgress } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { readStorageDrop, storageUploadFiles, uploadStorageBatch, type StorageUploadBatch } from "@/app/lib/storage-upload";
import { canDropStorageEntry, hasStorageEntryDrag, readStorageEntryDrag, writeStorageEntryDrag, type StorageEntryDragItem } from "@/app/lib/storage-entry-drag";
import { hasTaskAttachmentDrag, readTaskAttachmentDrag, type TaskAttachmentDragItem } from "@/app/lib/task-attachment-drag";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { StorageEntryMenu } from "./storage-entry-menu";
import { StorageTransferStatus } from "./storage-transfer-status";
import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";

type Location = { root: StorageRoot; path: string };
type PendingTransfer = { rootId: string; parentPath: string; entry: StorageEntry; progress: StorageTransferProgress };
type TreeProps = {
  client: LegalworkServerClient;
  workspaceId: string;
  roots: StorageRoot[];
  onOpenFile: (root: StorageRoot, file: StorageEntry) => void;
};
export function StorageDriveTree({ client, workspaceId, roots, onOpenFile }: TreeProps) {
  const queryClient = useQueryClient();
  const [selection, setSelected] = useState<Location | null>(null);
  const selectedRoot = roots.find((root) => root.id === selection?.root.id);
  const selected = selection && selectedRoot ? { root: selectedRoot, path: selection.path } : null;
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragItem, setDragItem] = useState<StorageEntryDragItem | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<PendingTransfer | null>(null);
  const transferring = useRef(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refreshFolder = (target: Location) =>
    queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, target.root.id, target.path] });
  const upload = async (target: Location, source: File[] | DataTransfer) => {
    if (busy || uploading.current || !target.root.writable) return;
    uploading.current = true;
    setSelected(target);
    setError("");
    setNotice("");
    setBusy(t("storage.preparing_upload"));
    let failures: StorageUploadBatch["failures"] = [];
    try {
      const batch = Array.isArray(source) ? storageUploadFiles(source) : await readStorageDrop(source);
      failures = await uploadStorageBatch(client, workspaceId, target.root.id, target.path, batch,
        (current, total, name) => setBusy(t("storage.upload_progress", { current, total, name })),
        () => live.current,
      );
      // Nested folders may already be open, so invalidate the whole connection's tree.
      await queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, target.root.id] });
      await queryClient.invalidateQueries({ queryKey: ["storage-filename-search", workspaceId, target.root.id] });
    } catch (cause) {
      failures.push({ path: target.path, cause });
    } finally {
      uploading.current = false;
      if (live.current) {
        setBusy("");
        setError(failures.map(({ path, cause }) =>
          `${path ? `${path}: ` : ""}${cause instanceof Error ? cause.message : t("storage.failed")}`,
        ).join("\n"));
      }
    }
  };
  const copyTaskAttachment = async (target: Location, attachment: TaskAttachmentDragItem) => {
    if (busy || uploading.current || !target.root.writable) return;
    setSelected(target);
    setError("");
    setNotice("");
    setBusy(t("storage.upload_progress", { current: 1, total: 1, name: attachment.filename }));
    try {
      const download = await client.downloadTaskAttachment(workspaceId, attachment.taskId, attachment.attachmentId);
      const filename = attachment.filename.split(/[/\\]/).pop() || "attachment";
      await client.writeStorageFile(
        workspaceId,
        target.root.id,
        target.path ? `${target.path}/${filename}` : filename,
        download.data,
        download.contentType || attachment.contentType || "application/octet-stream",
      );
      await refreshFolder(target);
    } catch (cause) {
      setError(`${attachment.filename}: ${cause instanceof Error ? cause.message : t("storage.failed")}`);
    } finally {
      setBusy("");
    }
  };
  const transfer = async (target: Location, item: StorageEntryDragItem) => {
    if (busy || transferring.current || !canDropStorageEntry(item, workspaceId, target.root, target.path)) return;
    const source = roots.find((root) => root.id === item.connectionId);
    if (!source) return;
    transferring.current = true;
    const name = item.path.split("/").at(-1)!;
    setSelected(target);
    setError("");
    setNotice("");
    setBusy(t("storage.copying", { name }));
    setPendingTransfer({
      rootId: target.root.id, parentPath: target.path,
      entry: { path: target.path ? `${target.path}/${name}` : name, name, kind: item.kind, size: null, modifiedAt: null },
      progress: { phase: "scanning", completedFiles: 0, totalFiles: null, elapsedMs: 0 },
    });
    try {
      await client.transferStorageEntry(workspaceId, item.connectionId, {
        path: item.path, kind: item.kind, destinationId: target.root.id, destinationPath: target.path, mode: "copy",
      }, (progress) => {
        if (live.current) setPendingTransfer((current) => current ? { ...current, progress } : current);
      });
      if (live.current) setNotice(t("storage.copied", { name }));
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : t("storage.failed"));
    } finally {
      await Promise.all([...new Set([source.id, target.root.id])].flatMap((id) => [
        queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, id] }),
        queryClient.invalidateQueries({ queryKey: ["storage-filename-search", workspaceId, id] }),
      ]));
      transferring.current = false;
      if (live.current) { setBusy(""); setDragItem(null); setPendingTransfer(null); }
    }
  };
  return (
    <section aria-label={t("storage.connected_folders")} className="min-h-0 space-y-1 px-2 py-2">
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <span className="mr-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("storage.tab")}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("storage.upload")}
          aria-label={t("storage.upload")}
          disabled={!selected?.root.writable || Boolean(busy)}
          onClick={() => uploadInput.current?.click()}
        >
          <Upload className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("storage.new_folder")}
          aria-label={t("storage.new_folder")}
          disabled={!selected?.root.writable || Boolean(busy)}
          onClick={() => {
            setFolderName("");
            setError("");
            setNewFolder(true);
          }}
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {selected && (
        <p
          className="truncate px-2 pb-1 text-[10px] text-muted-foreground"
          title={`${selected.root.name}/${selected.path}`}
        >
          {selected.root.name}
          {selected.path ? ` / ${selected.path}` : ""}
        </p>
      )}
      <input
        ref={uploadInput}
        type="file"
        multiple
        className="hidden"
        aria-label={t("storage.upload")}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (selected) void upload(selected, files);
        }}
      />
      {busy && pendingTransfer ? <StorageTransferStatus label={busy} progress={pendingTransfer.progress} /> : busy && (
        <p role="status" className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span className="truncate">{busy}</span>
        </p>
      )}
      {notice && !busy && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">{notice}</p>}
      {error && (
        <div
          role="alert"
          className="whitespace-pre-wrap break-words rounded-lg bg-destructive/5 p-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      {roots.map((root) => (
        <StorageFolder
          key={root.id}
          client={client}
          workspaceId={workspaceId}
          root={root}
          path=""
          name={root.name}
          depth={0}
          selected={selected}
          onSelect={setSelected}
          onFile={(entry) => onOpenFile(root, entry)}
          onUpload={upload}
          onTaskAttachmentDrop={copyTaskAttachment}
          onEntryDrop={transfer}
          dragItem={dragItem}
          pendingTransfer={pendingTransfer}
          onDragItem={setDragItem}
          onChooseUpload={(target) => { setSelected(target); uploadInput.current?.click(); }}
          onNewFolder={(target) => { setSelected(target); setFolderName(""); setError(""); setNewFolder(true); }}
          busy={Boolean(busy)}
        />
      ))}
      <Dialog
        open={newFolder}
        onOpenChange={(open) => {
          if (!busy) setNewFolder(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.new_folder")}</DialogTitle>
            <DialogDescription>
              {selected?.root.name} / {selected?.path}
            </DialogDescription>
          </DialogHeader>
          <form
            id="storage-folder-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!selected) return;
              const name = folderName.trim();
              if (!name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) {
                setError(t("storage.invalid_name"));
                return;
              }
              setBusy(t("storage.creating_folder"));
              setError("");
              try {
                await client.createStorageFolder(
                  workspaceId,
                  selected.root.id,
                  selected.path ? `${selected.path}/${name}` : name,
                );
                await refreshFolder(selected);
                setNewFolder(false);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : t("storage.failed"));
              } finally {
                setBusy("");
              }
            }}
          >
            <Input
              autoFocus
              aria-label={t("storage.folder_name")}
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder={t("storage.folder_name")}
              required
              disabled={Boolean(busy)}
            />
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setNewFolder(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="storage-folder-form" disabled={Boolean(busy)}>
              {t("storage.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

type FolderProps = Location & {
  client: LegalworkServerClient;
  workspaceId: string;
  name: string;
  depth: number;
  selected: Location | null;
  onSelect: (target: Location) => void;
  onFile: (entry: StorageEntry) => void;
  onUpload: (target: Location, source: File[] | DataTransfer) => Promise<void>;
  onTaskAttachmentDrop: (target: Location, attachment: TaskAttachmentDragItem) => Promise<void>;
  onEntryDrop: (target: Location, item: StorageEntryDragItem) => Promise<void>;
  dragItem: StorageEntryDragItem | null;
  pendingTransfer: PendingTransfer | null;
  onDragItem: (item: StorageEntryDragItem | null) => void;
  onChooseUpload: (target: Location) => void;
  onNewFolder: (target: Location) => void;
  busy: boolean;
};
function StorageFolder(props: FolderProps) {
  const { client, workspaceId, root, path, name, depth, selected, onSelect, onFile, onUpload, busy } = props;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearExpandTimer = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    expandTimer.current = null;
  };
  useEffect(() => {
    if (!props.dragItem) { setDragging(false); clearExpandTimer(); }
    return clearExpandTimer;
  }, [props.dragItem]);
  const isPending = props.pendingTransfer?.rootId === root.id && props.pendingTransfer.entry.kind === "folder" && props.pendingTransfer.entry.path === path;
  const children = useInfiniteQuery({
    queryKey: ["storage-children", workspaceId, root.id, path, root.revision],
    queryFn: ({ pageParam }) => client.storageChildren(workspaceId, root.id, path, pageParam),
    initialPageParam: ((): string | undefined => undefined)(),
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && !isPending,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const entries = [
    ...new Map(
      (children.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [
        `${entry.kind}:${entry.path}`,
        entry,
      ]),
    ).values(),
  ];
  const incoming = props.pendingTransfer;
  if (incoming?.rootId === root.id && incoming.parentPath === path && !entries.some((entry) => entry.path === incoming.entry.path)) {
    entries.push(incoming.entry);
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name));
  }
  const isSelected = selected?.root.id === root.id && selected.path === path;
  return (
    <div>
      <StorageEntryMenu client={client} workspaceId={workspaceId} root={root} file={{ path, name, kind: "folder", size: null, modifiedAt: null }} disabled={busy}
        onOpen={() => { onSelect({ root, path }); setOpen(true); }} onRefresh={() => void children.refetch()}
        onDeleted={() => {
          if (selected?.root.id === root.id && (selected.path === path || selected.path.startsWith(`${path}/`)))
            onSelect({ root, path: path.split("/").slice(0, -1).join("/") });
        }}
        onUpload={() => props.onChooseUpload({ root, path })} onNewFolder={() => props.onNewFolder({ root, path })}>
      <div className="group flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-busy={isPending || undefined}
          disabled={isPending}
          title={path || name}
          draggable={Boolean(path) && !busy}
          onDragStart={(event) => {
            event.stopPropagation();
            props.onDragItem(writeStorageEntryDrag(event.dataTransfer, workspaceId, root, { path, name, kind: "folder", size: null, modifiedAt: null }));
          }}
          onDragEnd={() => props.onDragItem(null)}
          style={{ paddingLeft: 6 + depth * 15 }}
          className={cn(
            "flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg pr-2 text-left text-[13px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            isSelected && "bg-muted/70",
            dragging && "bg-primary/10 ring-1 ring-primary/40",
          )}
          onClick={() => {
            onSelect({ root, path });
            setOpen((value) => !value);
          }}
          onDragOver={(event) => {
            const storageDrag = hasStorageEntryDrag(event.dataTransfer);
            if (
              root.writable &&
              !busy &&
              (storageDrag || event.dataTransfer.types.includes("Files") || hasTaskAttachmentDrag(event.dataTransfer)) &&
              (!storageDrag || !props.dragItem || canDropStorageEntry(props.dragItem, workspaceId, root, path))
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
              if (!open && !expandTimer.current) expandTimer.current = setTimeout(() => { setOpen(true); expandTimer.current = null; }, 600);
            } else {
              event.dataTransfer.dropEffect = "none";
              setDragging(false);
              clearExpandTimer();
            }
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDragging(false); clearExpandTimer();
          }}
          onDrop={(event) => {
            setDragging(false);
            clearExpandTimer();
            if (!root.writable || busy) return;
            event.preventDefault();
            event.stopPropagation();
            if (hasStorageEntryDrag(event.dataTransfer)) {
              const item = readStorageEntryDrag(event.dataTransfer);
              if (item && canDropStorageEntry(item, workspaceId, root, path)) {
                setOpen(true);
                void props.onEntryDrop({ root, path }, item);
              }
              props.onDragItem(null);
              return;
            }
            setOpen(true);
            const attachment = readTaskAttachmentDrag(event.dataTransfer);
            if (attachment) {
              void props.onTaskAttachmentDrop({ root, path }, attachment);
              return;
            }
            void onUpload({ root, path }, event.dataTransfer);
          }}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <span className="relative flex size-5 shrink-0">
            <FolderIcon open={open} />
            {isPending && <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-background text-foreground ring-2 ring-background"><Loader2 className="size-3 animate-spin" /></span>}
          </span>
          <span className={cn("min-w-0 flex-1 truncate", depth === 0 && "font-medium")}>{name}</span>
          {!root.writable && depth === 0 && <LockKeyhole className="size-3 text-muted-foreground" />}
        </button>
        {open && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("storage.refresh_folder", { name })}
            onClick={() => void children.refetch()}
            disabled={children.isFetching}
          >
            <RefreshCw className="size-3" />
          </Button>
        )}
      </div>
      </StorageEntryMenu>
      {open && (
        <div>
          {children.isLoading && (
            <p
              style={{ paddingLeft: 25 + depth * 15 }}
              className="flex h-8 items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {t("storage.loading")}
            </p>
          )}
          {entries.map((entry) =>
            entry.kind === "folder" ? (
              <StorageFolder
                key={`folder:${entry.path}`}
                {...props}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
              />
            ) : (
              <StorageEntryMenu key={`file:${entry.path}`} client={client} workspaceId={workspaceId} root={root} file={entry} disabled={busy} onOpen={() => onFile(entry)}>
              <div className="group flex items-center">
              <button
                type="button"
                aria-busy={incoming?.rootId === root.id && incoming.entry.path === entry.path || undefined}
                disabled={incoming?.rootId === root.id && incoming.entry.path === entry.path}
                draggable={!busy}
                onDragStart={(event) => props.onDragItem(writeStorageEntryDrag(event.dataTransfer, workspaceId, root, entry))}
                onDragEnd={() => props.onDragItem(null)}
                onClick={() => onFile(entry)}
                title={entry.path}
                style={{ paddingLeft: 40 + depth * 15 }}
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-[13px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="relative flex size-5 shrink-0">
                  <ArtifactIcon type={classifyOpenTarget(entry.name, "file")} className="size-5 shrink-0" />
                  {incoming?.rootId === root.id && incoming.entry.path === entry.path && <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-background ring-2 ring-background"><Loader2 className="size-3 animate-spin" /></span>}
                </span>
                <span className="truncate">{entry.name}</span>
              </button>
              </div>
              </StorageEntryMenu>
            ),
          )}
          {children.isError && (
            <div style={{ paddingLeft: 25 + depth * 15 }} className="py-2 text-xs text-destructive">
              <p className="break-words">
                <AlertCircle className="mr-1 inline size-3" />
                {children.error.message}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void (children.hasNextPage ? children.fetchNextPage() : children.refetch())}
              >
                {t("storage.retry")}
              </Button>
            </div>
          )}
          {!children.isLoading && !children.isError && entries.length === 0 && (
            <p style={{ paddingLeft: 25 + depth * 15 }} className="py-2 text-xs text-muted-foreground">
              {t("storage.empty_folder")}
            </p>
          )}
          {children.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-6 text-xs"
              disabled={children.isFetching}
              onClick={() => void children.fetchNextPage()}
            >
              {children.isFetchingNextPage ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("storage.load_more")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
