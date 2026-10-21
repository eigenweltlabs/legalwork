import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { Checkbox } from "@/components/ui/checkbox";
import { useViewSaveDestinations, viewSaveDestinationGroups } from "./view-save-destinations";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, Loader2, Search, X } from "lucide-react";
import type { ViewOwner, ViewSaveSource, ViewPreview, ViewRecord } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { isViewSaveConflict, preferredSavedView, sameViewOwner, viewInputForDestination, viewOwnerKey } from "./view-save";

export function ViewSaveDialog({ client, preview, savedFrom, fromChat = false, onClose, onSaved }: { savedFrom?: ViewSaveSource; fromChat?: boolean; client: LegalworkServerClient; preview: ViewPreview; onClose: () => void; onSaved: (view: ViewRecord) => void }) {
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string[]>([viewOwnerKey(preview.owner)]);
  const [saved, setSaved] = useState<ViewRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ViewOwner["kind"] | undefined>();
  const destinations = useViewSaveDestinations(client);
  const groups = viewSaveDestinationGroups(destinations.data, preview.owner, search, kind);
  const categories = viewSaveDestinationGroups(destinations.data, preview.owner);
  const targets = destinations.data?.filter(item => selected.includes(viewOwnerKey(item.owner))) ?? [];
  const unsavedTargets = targets.filter(item => !saved.some(view => sameViewOwner(view.owner, item.owner)));
  const finish = () => { const view = preferredSavedView(saved, preview.owner); if (view) onSaved(view); else onClose(); };
  const save = async (saveCopy = false) => {
    setBusy(true); setError("");
    const completed = [...saved];
    try {
      for (const { owner } of targets) {
        if (completed.some(view => sameViewOwner(view.owner, owner))) continue;
        const input = viewInputForDestination(preview.input, preview.owner, owner);
        const result = preview.target && sameViewOwner(preview.owner, owner) && !saveCopy
          ? await client.updateView(owner, preview.target.viewId, { baseRevision: preview.target.baseRevision, input }, savedFrom)
          : await client.createView(owner, !fromChat || saveCopy ? { ...input, title: t("views.copy_title", { title: input.title }).slice(0, 200) } : input, savedFrom);
        completed.push(result); setSaved([...completed]);
        void cache.invalidateQueries({ queryKey: ["ui-views", client.baseUrl, owner.kind, owner.id] });
        void cache.invalidateQueries({ queryKey: ["ui-view", client.baseUrl, owner.kind, owner.id] });
        if (owner.kind === "wiki") void cache.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, owner.id] });
        else {
          void cache.invalidateQueries({ queryKey: ["workspace-files", owner.id] });
          void cache.invalidateQueries({ queryKey: ["workspace-view-files", client.baseUrl, owner.id] });
        }
      }
      const view = preferredSavedView(completed, preview.owner);
      if (view) {
        toast.success(t("views.saved_notice", { title: view.title, destinations: completed.map(view => destinations.data?.find(item => sameViewOwner(item.owner, view.owner))?.name ?? view.title).join(", ") }));
        onSaved(view);
      }
    } catch (error) {
      const revisionConflict = isViewSaveConflict(error);
      setConflict(value => value || revisionConflict);
      setError(revisionConflict ? t("views.save_conflict") : error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) finish(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle className="break-words">{t(fromChat ? "views.save_named" : "views.save_copy_named", { title: preview.input.title })}</DialogTitle><DialogDescription>{t(fromChat ? "views.preview_save_hint" : "views.save_hint")}</DialogDescription></DialogHeader>
    <div className="space-y-2">
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" aria-label={t("views.search_destinations")} placeholder={t("views.search_destinations")} value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="flex gap-1" role="group" aria-label={t("views.destination_type")}>
        <Button size="sm" variant={!kind ? "secondary" : "ghost"} aria-pressed={!kind} onClick={() => setKind(undefined)}>{t("views.all_destinations")}</Button>
        {categories.map(group => <Button key={group.kind} size="sm" variant={kind === group.kind ? "secondary" : "ghost"} aria-pressed={kind === group.kind} onClick={() => setKind(group.kind)}>{group.label}<span className="text-muted-foreground">{group.items.length}</span></Button>)}
      </div>
      {targets.length > 0 && <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto" aria-label={t("views.selected_destinations")}>
        {targets.map(item => { const done = saved.some(view => sameViewOwner(view.owner, item.owner)); return <Button key={viewOwnerKey(item.owner)} size="sm" variant="outline" className="h-7 max-w-full gap-1 px-2 text-xs" disabled={busy || done} title={item.name} aria-label={t("views.remove_destination", { name: item.name })} onClick={() => setSelected(values => values.filter(value => value !== viewOwnerKey(item.owner)))}><span className="truncate">{item.name}</span>{done ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}</Button>; })}
      </div>}
    </div>
    <div className="max-h-[35vh] min-h-24 space-y-3 overflow-y-auto">
      {destinations.isPending && <p role="status" className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p>}
      {destinations.data?.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t("views.no_save_destinations")}</p>}
      {destinations.error && <p role="alert" className="text-sm text-destructive">{destinations.error.message}<Button size="sm" variant="ghost" onClick={() => void destinations.refetch()}>{t("wiki.retry")}</Button></p>}
      {Boolean(destinations.data?.length) && groups.length === 0 && <p role="status" className="py-3 text-sm text-muted-foreground">{t("views.no_matching_destinations")}</p>}
      {groups.map(group => <fieldset key={group.kind} className="min-w-0">
        <legend className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</legend>
        {group.items.map(({ owner, name }) => { const key = viewOwnerKey(owner), done = saved.some(view => sameViewOwner(view.owner, owner)); return <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent has-[:checked]:bg-accent/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring">
        <Checkbox checked={done || selected.includes(key)} disabled={busy || done} onCheckedChange={checked => setSelected(values => checked ? [...values, key] : values.filter(value => value !== key))} />
        {owner.kind === "wiki" ? <BookOpen className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={name}>{name}</span>{preview.target && sameViewOwner(owner, preview.owner) && <span className="text-xs text-muted-foreground">{t(conflict ? "views.save_copy_instead" : "views.update_saved")}</span>}</span>{sameViewOwner(owner, preview.owner) && <span className="shrink-0 text-xs text-muted-foreground">{t("views.current_destination")}</span>}{done && <Check className="size-4 text-success" />}
      </label>; })}</fieldset>)}
    </div>
    {targets.some(item => !sameViewOwner(item.owner, preview.owner)) && Object.keys(preview.input.queries).length > 0 && <p className="text-xs text-muted-foreground">{t("views.copy_snapshot_hint")}</p>}
    {targets.some(item => item.owner.kind === "wiki") && <p className="text-xs text-muted-foreground">{t("views.wiki_save_hint")}</p>}
    {saved.length > 0 && <p role="status" className="text-xs text-muted-foreground">{t("views.saved_destinations", { destinations: saved.map(view => destinations.data?.find(item => sameViewOwner(item.owner, view.owner))?.name ?? view.title).join(", ") })}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="ghost" disabled={busy} onClick={finish}>{t(saved.length ? "common.close" : "common.cancel")}</Button><Button disabled={busy || !unsavedTargets.length || destinations.isFetching || Boolean(destinations.error)} onClick={() => void save(conflict)}>{busy && <Loader2 className="size-4 animate-spin" />}{t(!fromChat || conflict ? "views.save_copy" : "common.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
