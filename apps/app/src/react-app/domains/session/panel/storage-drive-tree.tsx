/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronRight, FolderPlus, Loader2, LockKeyhole, RefreshCw, Upload } from "lucide-react";
import { type StorageEntry, type StorageRoot } from "@legalwork/types/file-storage";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { ArtifactIcon } from "../artifacts/artifact-icon";
import { classifyOpenTarget } from "../artifacts/open-target";

type Location = { root: StorageRoot; path: string };
type TreeProps = {
  client: LegalworkServerClient;
  workspaceId: string;
  roots: StorageRoot[];
  refreshKey: number;
  onOpenFile: (root: StorageRoot, file: StorageEntry) => void;
};
export function StorageDriveTree({ client, workspaceId, roots, refreshKey, onOpenFile }: TreeProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Location | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    setError("");
  }, [refreshKey]);
  const refreshFolder = (target: Location) =>
    queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, target.root.id, target.path] });
  const upload = async (target: Location, files: File[]) => {
    if (busy || !target.root.writable || !files.length) return;
    setSelected(target);
    setError("");
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      if (!live.current) return;
      setBusy(t("storage.upload_progress", { current: index + 1, total: files.length, name: file.name }));
      try {
        await client.writeStorageFile(
          workspaceId,
          target.root.id,
          target.path ? `${target.path}/${file.name}` : file.name,
          file,
          file.type || "application/octet-stream",
        );
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : t("storage.failed")}`);
      }
    }
    if (!live.current) return;
    await refreshFolder(target);
    setBusy("");
    setError(failures.join("\n"));
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
      {busy && (
        <p role="status" className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span className="truncate">{busy}</span>
        </p>
      )}
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
          key={`${root.id}:${refreshKey}`}
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
  onUpload: (target: Location, files: File[]) => Promise<void>;
  busy: boolean;
};
function StorageFolder(props: FolderProps) {
  const { client, workspaceId, root, path, name, depth, selected, onSelect, onFile, onUpload, busy } = props;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const children = useInfiniteQuery({
    queryKey: ["storage-children", workspaceId, root.id, path],
    queryFn: ({ pageParam }) => client.storageChildren(workspaceId, root.id, path, pageParam),
    initialPageParam: ((): string | undefined => undefined)(),
    getNextPageParam: (page) => page.nextCursor,
    enabled: open,
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
  const isSelected = selected?.root.id === root.id && selected.path === path;
  return (
    <div>
      <div className="group flex items-center">
        <button
          type="button"
          aria-expanded={open}
          title={path || name}
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
            if (root.writable && !busy && event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            setDragging(false);
            if (!root.writable || busy) return;
            event.preventDefault();
            setOpen(true);
            void onUpload({ root, path }, Array.from(event.dataTransfer.files));
          }}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <FolderIcon open={open} />
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
              <button
                key={`file:${entry.path}`}
                type="button"
                onClick={() => onFile(entry)}
                title={entry.path}
                style={{ paddingLeft: 40 + depth * 15 }}
                className="flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 text-left text-[13px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <ArtifactIcon type={classifyOpenTarget(entry.name, "file")} className="size-5 shrink-0" />
                <span className="truncate">{entry.name}</span>
              </button>
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
