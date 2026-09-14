/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";

export function StorageDeleteEntry({ client, workspaceId, root, file, disabled, trigger, onDeleted }: {
  client: LegalworkServerClient; workspaceId: string; root: StorageRoot; file: StorageEntry; disabled?: boolean;
  trigger?: (remove?: () => void) => ReactNode;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  if (!root.writable || !file.path) return trigger?.();
  const label = t(file.kind === "folder" ? "storage.delete_folder" : "storage.delete_file");
  return <>
    {trigger ? trigger(() => { setError(""); setOpen(true); }) : <Button variant="ghost" size="icon-sm" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" disabled={disabled || busy}
      aria-label={t("storage.delete_file_named", { name: file.name })} title={label}
      onClick={() => { setError(""); setOpen(true); }}><Trash2 className="size-3.5" /></Button>}
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{t(file.kind === "folder" ? "storage.delete_folder_confirm" : "storage.delete_file_confirm", { name: file.name, connection: root.name })}</DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm text-muted-foreground">{file.path}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try {
              if (file.kind === "folder") await client.deleteStorageFolder(workspaceId, root.id, file.path);
              else await client.deleteStorageFile(workspaceId, root.id, file.path);
              setOpen(false);
              onDeleted?.();
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : t("storage.failed");
              setError(message);
              // A partial folder deletion may remove this row; keep the error visible.
              if (file.kind === "folder") toast.error(message);
            } finally {
              setBusy(false);
              void queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, root.id] });
              void queryClient.invalidateQueries({ queryKey: ["storage-filename-search", workspaceId, root.id] });
            }
          }}>{busy && <Loader2 className="size-4 animate-spin" />}{label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
