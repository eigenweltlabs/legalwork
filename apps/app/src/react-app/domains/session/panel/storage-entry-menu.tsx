/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { FileEntryActions } from "./file-entry-actions";
import { changePinnedPaths } from "./file-pins";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { StorageDeleteEntry } from "./storage-delete-entry";
import { useProjectFiles } from "../../workspace/project-file-context";

export function StorageEntryMenu({ client, workspaceId, root, file, children, onOpen, onRefresh, onUpload, onNewFolder, onDeleted, disabled }: {
  client: LegalworkServerClient; workspaceId: string; root: StorageRoot; file: StorageEntry; children: ReactNode;
  onOpen: () => void; onRefresh?: () => void; onUpload?: () => void; onNewFolder?: () => void; disabled?: boolean;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const access = useProjectFiles();
  const source = file.kind === "file" ? access?.identify(client, workspaceId, { name: file.name, path: file.path, connectionId: root.id }) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writable = root.writable && !disabled && !busy;
  return <>
    <StorageDeleteEntry client={client} workspaceId={workspaceId} root={root} file={file} disabled={disabled || busy} onDeleted={() => { changePinnedPaths(workspaceId, root.id, file.path); onDeleted?.(); }} trigger={(remove) =>
      <FileEntryActions name={file.name} source={source ?? undefined} onOpen={!disabled && file.kind === "file" ? onOpen : undefined} pin={file.kind === "file" ? { workspaceId, source: root.id, path: file.path, name: file.name } : undefined} actions={[
        { label: t("storage.open"), icon: <FolderOpen />, onClick: onOpen, disabled },
        ...(onRefresh ? [{ label: t("storage.refresh_folder", { name: file.name }), icon: <RefreshCw />, onClick: onRefresh }] : []),
        ...(root.writable ? [
          ...(onUpload ? [{ label: t("storage.upload"), icon: <Upload />, disabled: !writable, onClick: onUpload }] : []),
          ...(onNewFolder ? [{ label: t("storage.new_folder"), icon: <FolderPlus />, disabled: !writable, onClick: onNewFolder }] : []),
          ...(file.path ? [{ label: t("storage.rename"), icon: <Pencil />, disabled: !writable, onClick: () => { setName(file.name); setError(""); setRenaming(true); } }] : []),
          ...(remove ? [{ label: t(file.kind === "folder" ? "storage.delete_folder" : "storage.delete_file"), icon: <Trash2 />, disabled: !writable, destructive: true, onClick: remove }] : []),
        ] : []),
      ]}>{children}</FileEntryActions>}
    />
    <Dialog open={renaming} onOpenChange={(open) => { if (!busy) setRenaming(open); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("storage.rename")}</DialogTitle><DialogDescription>{root.name} / {file.path}</DialogDescription></DialogHeader>
        <form id={`rename-${workspaceId}-${root.id}-${file.path}`} onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || /[/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") { setError(t("storage.invalid_name")); return; }
          setBusy(true); setError("");
          try {
            const renamed = await client.renameStorageEntry(workspaceId, root.id, file.path, name.trim(), file.kind);
            changePinnedPaths(workspaceId, root.id, file.path, renamed.path);
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
