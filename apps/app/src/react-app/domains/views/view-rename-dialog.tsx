import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ViewSummary } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { renameView } from "./view-file";

export function ViewRenameDialog({ client, view, onClose }: { client: LegalworkServerClient; view: ViewSummary; onClose: () => void }) {
  const [title, setTitle] = useState(view.title);
  const cache = useQueryClient();
  const rename = useMutation({ mutationFn: () => renameView(client, view, title), onSuccess: async () => {
    await Promise.all(["ui-view", "ui-views", "view-file", "workspace-view-files", "wiki-snapshot"].map(key => cache.invalidateQueries({ queryKey: [key, client.baseUrl] })));
    onClose();
  } });
  return <Dialog open onOpenChange={open => { if (!open && !rename.isPending) onClose(); }}><DialogContent showCloseButton={!rename.isPending}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (title.trim() && !rename.isPending) rename.mutate(); }}>
      <DialogHeader><DialogTitle>{t("storage.rename")}</DialogTitle><DialogDescription>{view.title}</DialogDescription></DialogHeader>
      <Input autoFocus required maxLength={200} aria-label={t("views.name")} value={title} disabled={rename.isPending} onChange={event => setTitle(event.target.value)} />
      {rename.error && <p role="alert" className="text-sm text-destructive">{rename.error.message}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={rename.isPending} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={rename.isPending || !title.trim() || title.trim() === view.title}>{t("storage.rename")}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
