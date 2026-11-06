import { useViewSaveDestinations, viewSaveDestinationGroups } from "./view-save-destinations";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Check } from "lucide-react";
import type { SessionViewPreview, SessionViewReview, ViewOwner, ViewRecord } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DashboardIcon } from "@/react-app/design-system/dashboard-icon";
import { t } from "@/i18n";
import { isViewSaveConflict, sameViewOwner, viewInputForDestination, viewOwnerKey } from "./view-save";
import { useViewGenerationStore, viewGenerationId } from "./view-generation";
import { useViewCopyStore } from "./view-save-locations";
import { sessionDeleteError } from "./session-view-delete";

export type SessionViewDeleteRequest = { client: LegalworkServerClient; workspaceId: string; sessionId: string; review: SessionViewReview; onDelete: (discardReview?: string) => Promise<void> };
export function SessionViewDeleteDialog({ request, onClose }: { request: SessionViewDeleteRequest; onClose: () => void }) {
  const { client, workspaceId, sessionId } = request;
  const [review, setReview] = useState(request.review);
  const cache = useQueryClient();
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, ViewRecord>>({});
  const [receipts, setReceipts] = useState<ViewRecord[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [copies, setCopies] = useState<string[]>([]);
  const [action, setAction] = useState<"save" | "discard" | null>(null);
  const busy = action !== null;
  const hasUnsaved = review.items.length > 0;
  const hasUnavailable = review.items.some(item => !item.preview);
  const [error, setError] = useState("");
  const destinations = useViewSaveDestinations(client);
  const groups = viewSaveDestinationGroups(destinations.data);
  const itemKey = (item: SessionViewPreview) => JSON.stringify([item.sessionId ?? sessionId, item.callId]);
  const destination = (item: SessionViewPreview, owner: ViewOwner) => destinations.data?.find(target => viewOwnerKey(target.owner) === (targets[itemKey(item)] ?? viewOwnerKey(owner)));
  const selectedTargets = review.items.flatMap(item => {
    if (!item.preview || saved[itemKey(item)]) return [];
    const target = destination(item, item.preview.owner);
    return target ? [{ owner: target.owner, preview: item.preview }] : [];
  });
  const refreshReview = async () => {
    const current = await client.sessionViewReview(workspaceId, sessionId);
    setReview(current);
    setSaved(values => Object.fromEntries(Object.entries(values).filter(([key]) => !current.items.some(item => itemKey(item) === key))));
  };
  const run = async (save: boolean) => {
    setAction(save ? "save" : "discard"); setError("");
    let savingKey: string | undefined;
    try {
      if (save) for (const item of review.items) {
        if (saved[itemKey(item)]) continue;
        if (!item.preview) continue;
        savingKey = itemKey(item);
        const preview = item.preview, target = destination(item, preview.owner);
        if (!target) throw new Error(t("views.delete_choose_destination"));
        const input = viewInputForDestination(preview.input, preview.owner, target.owner);
        const source = { workspaceId, sessionId: item.sessionId ?? sessionId, callId: item.callId };
        const copy = copies.includes(savingKey);
        const view = preview.target && sameViewOwner(preview.owner, target.owner) && !copy
          ? await client.updateView(target.owner, preview.target.viewId, { input, baseRevision: preview.target.baseRevision }, source)
          : await client.createView(target.owner, copy ? { ...input, title: t("views.copy_title", { title: input.title }).slice(0, 200) } : input, source);
        setSaved(values => ({ ...values, [itemKey(item)]: view }));
        setReceipts(values => [...values, view]);
        void cache.invalidateQueries({ queryKey: ["ui-views", client.baseUrl, view.owner.kind, view.owner.id] });
        if (view.owner.kind === "wiki") void cache.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, view.owner.id] });
        else {
          void cache.invalidateQueries({ queryKey: ["workspace-files", view.owner.id] });
          void cache.invalidateQueries({ queryKey: ["workspace-view-files", client.baseUrl, view.owner.id] });
        }
        useViewCopyStore.getState().remember(client.baseUrl, { key: viewGenerationId(client.baseUrl, item.sessionId ?? sessionId, item.callId) }, view);
        useViewGenerationStore.getState().markSaved(viewGenerationId(client.baseUrl, item.sessionId ?? sessionId, item.callId), view);
      }
      savingKey = undefined;
      if (save && hasUnavailable) { await refreshReview(); return; }
      await request.onDelete(save ? undefined : review.reviewToken);
      onClose();
    } catch (error) {
      if (isViewSaveConflict(error) && savingKey) {
        const key = savingKey;
        setConflicts(values => [...new Set([...values, key])]);
        setError(t("views.save_conflict"));
      } else setError(sessionDeleteError(error));
      try {
        await refreshReview();
      } catch { /* Keep the dialog and chat intact if refreshing fails. */ }
    }
    finally { setAction(null); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy} className="sm:max-w-xl">
    <DialogHeader><DialogTitle>{t(hasUnsaved ? "views.delete_chat_title" : "session.delete_session_title")}</DialogTitle><DialogDescription>{t(hasUnsaved ? "views.delete_chat_description" : "views.delete_copies_kept")}</DialogDescription></DialogHeader>
    {hasUnsaved && destinations.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p>}
    {hasUnsaved && destinations.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("views.no_save_destinations")}</p>}
    <div className="max-h-[45vh] space-y-3 overflow-auto">
      {review.items.map(item => <div key={itemKey(item)} className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-2"><DashboardIcon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>{saved[itemKey(item)] && <Check className="size-4 text-success" aria-label={t("views.delete_saved")} />}</div>
        {item.preview ? <label className="flex items-center gap-2 text-xs text-muted-foreground">{t("views.delete_save_in")}<select className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground" disabled={busy || destinations.isPending || Boolean(destinations.error) || Boolean(saved[itemKey(item)])} value={targets[itemKey(item)] ?? viewOwnerKey(item.preview.owner)} onChange={event => setTargets(values => ({ ...values, [itemKey(item)]: event.target.value }))}>
          {!destination(item, item.preview.owner) && <option value={targets[itemKey(item)] ?? viewOwnerKey(item.preview.owner)}>{t("views.delete_choose_destination")}</option>}
          {groups.map(group => <optgroup key={group.kind} label={group.label}>{group.items.map(target => <option key={viewOwnerKey(target.owner)} value={viewOwnerKey(target.owner)}>{target.name}</option>)}</optgroup>)}
        </select></label> : <p className="text-xs text-muted-foreground">{t("views.delete_preview_unavailable")}</p>}
        {item.preview?.target && conflicts.includes(itemKey(item)) && sameViewOwner(destination(item, item.preview.owner)?.owner ?? item.preview.owner, item.preview.owner) && <label className="flex items-center gap-2 text-sm"><Checkbox checked={copies.includes(itemKey(item))} disabled={busy} onCheckedChange={checked => setCopies(values => checked ? [...values, itemKey(item)] : values.filter(key => key !== itemKey(item)))} />{t("views.save_copy_instead")}</label>}
      </div>)}
      {receipts.length > 0 && <div role="status" className="space-y-2 rounded-lg border border-success/30 p-3"><p className="text-xs font-medium">{t("views.saved_during_review")}</p>{receipts.map(view => <p key={`${viewOwnerKey(view.owner)}:${view.id}:${view.revision}`} className="flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-3.5 shrink-0 text-success" />{view.title} · {destinations.data?.find(target => sameViewOwner(target.owner, view.owner))?.name ?? view.owner.kind}</p>)}</div>}
    </div>
    {selectedTargets.some(({ owner, preview }) => !sameViewOwner(owner, preview.owner) && Object.keys(preview.input.queries).length > 0) && <p className="text-xs text-muted-foreground">{t("views.copy_snapshot_hint")}</p>}
    {selectedTargets.some(({ owner }) => owner.kind === "wiki") && <p className="text-xs text-muted-foreground">{t("views.wiki_save_hint")}</p>}
    {(error || hasUnsaved && destinations.error) && <p role="alert" className="text-sm text-destructive">{error || destinations.error?.message}</p>}
    {hasUnsaved && destinations.error && <Button variant="ghost" size="sm" disabled={busy || destinations.isFetching} onClick={() => void destinations.refetch()}>{t("wiki.retry")}</Button>}
    <DialogFooter className="flex-wrap"><Button variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>{hasUnsaved && <Button variant="outline" disabled={busy} onClick={() => void run(false)}>{action === "discard" && <Loader2 className="size-4 animate-spin" />}{t("views.delete_without_saving")}</Button>}{(!hasUnsaved || review.items.some(item => item.preview)) && <Button disabled={busy || hasUnsaved && (destinations.isFetching || Boolean(destinations.error)) || review.items.some(item => item.preview && !saved[itemKey(item)] && (!destination(item, item.preview.owner) || conflicts.includes(itemKey(item)) && !copies.includes(itemKey(item)) && sameViewOwner(destination(item, item.preview.owner)?.owner ?? item.preview.owner, item.preview.owner)))} onClick={() => void run(true)}>{action === "save" && <Loader2 className="size-4 animate-spin" />}{t(!hasUnsaved ? "session.delete" : hasUnavailable ? "views.save_available" : "views.save_and_delete")}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}
