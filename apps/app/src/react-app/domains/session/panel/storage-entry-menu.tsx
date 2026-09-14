/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { StorageDeleteFile } from "./storage-delete-file";

export function StorageEntryMenu({ client, workspaceId, root, file, children, onOpen, onRefresh, onUpload, onNewFolder, disabled }: {
  client: LegalworkServerClient; workspaceId: string; root: StorageRoot; file: StorageEntry; children: ReactNode;
  onOpen: () => void; onRefresh?: () => void; onUpload?: () => void; onNewFolder?: () => void; disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writable = root.writable && !disabled && !busy;
  return <>
    <StorageDeleteFile client={client} workspaceId={workspaceId} root={root} file={file} trigger={(remove) =>
      <ContextMenu>
        <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onOpen}><FolderOpen />{t("storage.open")}</ContextMenuItem>
          {onRefresh && <ContextMenuItem onClick={onRefresh}><RefreshCw />{t("storage.refresh_folder", { name: file.name })}</ContextMenuItem>}
          {root.writable && <>
            <ContextMenuSeparator />
            {onUpload && <ContextMenuItem disabled={!writable} onClick={onUpload}><Upload />{t("storage.upload")}</ContextMenuItem>}
            {onNewFolder && <ContextMenuItem disabled={!writable} onClick={onNewFolder}><FolderPlus />{t("storage.new_folder")}</ContextMenuItem>}
            {file.path && <ContextMenuItem disabled={!writable} onClick={() => { setName(file.name); setError(""); setRenaming(true); }}><Pencil />{t("storage.rename")}</ContextMenuItem>}
            {remove && <ContextMenuItem disabled={!writable} variant="destructive" onClick={remove}><Trash2 />{t("storage.delete_file")}</ContextMenuItem>}
          </>}
        </ContextMenuContent>
      </ContextMenu>}
    />
    <Dialog open={renaming} onOpenChange={(open) => { if (!busy) setRenaming(open); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("storage.rename")}</DialogTitle><DialogDescription>{root.name} / {file.path}</DialogDescription></DialogHeader>
        <form id={`rename-${workspaceId}-${root.id}-${file.path}`} onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || /[/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") { setError(t("storage.invalid_name")); return; }
          setBusy(true); setError("");
          try {
            await client.renameStorageEntry(workspaceId, root.id, file.path, name.trim(), file.kind);
            setRenaming(false);
          } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
          finally {
            setBusy(false);
            void queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, root.id] });
            void queryClient.invalidateQueries({ queryKey: ["storage-filename-search", workspaceId, root.id] });
          }
        }}>
          <Input autoFocus value={name} maxLength={255} aria-label={t("storage.new_name")} disabled={busy} onChange={(event) => setName(event.target.value)} />
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setRenaming(false)}>{t("common.cancel")}</Button>
          <Button type="submit" form={`rename-${workspaceId}-${root.id}-${file.path}`} disabled={busy || !writable || name.trim() === file.name}>{busy && <Loader2 className="size-4 animate-spin" />}{t("storage.rename")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
