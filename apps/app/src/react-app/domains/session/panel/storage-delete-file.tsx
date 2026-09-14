/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

export function StorageDeleteFile({ client, workspaceId, root, file, disabled, trigger }: {
  client: LegalworkServerClient; workspaceId: string; root: StorageRoot; file: StorageEntry; disabled?: boolean;
  trigger?: (remove?: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  if (!root.writable || file.kind !== "file") return trigger?.();
  return <>
    {trigger ? trigger(() => { setError(""); setOpen(true); }) : <Button variant="ghost" size="icon-sm" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" disabled={disabled || busy}
      aria-label={t("storage.delete_file_named", { name: file.name })} title={t("storage.delete_file")}
      onClick={() => { setError(""); setOpen(true); }}><Trash2 className="size-3.5" /></Button>}
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("storage.delete_file")}</DialogTitle>
          <DialogDescription>{t("storage.delete_file_confirm", { name: file.name, connection: root.name })}</DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm text-muted-foreground">{file.path}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try {
              await client.deleteStorageFile(workspaceId, root.id, file.path);
              setOpen(false);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["storage-children", workspaceId, root.id, file.path.split("/").slice(0, -1).join("/")] }),
                queryClient.invalidateQueries({ queryKey: ["storage-filename-search", workspaceId, root.id] }),
              ]);
            } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
            finally { setBusy(false); }
          }}>{busy && <Loader2 className="size-4 animate-spin" />}{t("storage.delete_file")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
