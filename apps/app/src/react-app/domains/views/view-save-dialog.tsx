import { useId, useState } from "react";
import { BookOpen, Check, Loader2, Search } from "lucide-react";
import type { ViewOwner, ViewSaveSource, ViewPreview, ViewRecord } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { viewPanelTab } from "./view-reference";
import { sameViewOwner, viewOwnerKey } from "./view-save";
import { useViewSaveDestinations, viewSaveDestinationGroups } from "./view-save-destinations";
import { useViewSave } from "./use-view-save";
import { useViewSaveLocations } from "./use-view-save-locations";
import type { ViewSaveScope } from "./view-save-locations";

export function ViewSaveDialog({ client, preview, savedFrom, scope, onClose, onSaved }: { savedFrom?: ViewSaveSource; scope: ViewSaveScope; client: LegalworkServerClient; preview: ViewPreview; onClose: () => void; onSaved: (view: ViewRecord) => void }) {
  const id = useId();
  const requestTab = useRequestPanelTab();
  const [title, setTitle] = useState(preview.input.title);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ViewOwner["kind"]>();
  const destinations = useViewSaveDestinations(client);
  const locations = useViewSaveLocations(client, scope);
  const saved = locations.error ? [] : locations.data ?? [];
  const available = destinations.data?.filter(item => !saved.some(view => sameViewOwner(view.owner, item.owner)));
  const kind = category ?? (available?.some(item => item.owner.kind === preview.owner.kind) ? preview.owner.kind : available?.[0]?.owner.kind ?? preview.owner.kind);
  const groups = viewSaveDestinationGroups(available, preview.owner, search, kind);
  const destination = available?.find(item => item.owner.kind === kind && viewOwnerKey(item.owner) === (selected ?? viewOwnerKey(preview.owner)));
  const save = useViewSave(client, preview, savedFrom, onSaved, scope);
  const loading = destinations.isPending || locations.isPending;
  const error = destinations.error || locations.error;
  const canSave = !save.isPending && !loading && !error && Boolean(title.trim()) && Boolean(destination);
  const savedOwners = [...new Map(saved.map(view => [viewOwnerKey(view.owner), view])).values()];
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent showCloseButton={!save.isPending} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
    <DialogHeader><DialogTitle>{t("views.save_copy")}</DialogTitle><DialogDescription>{t("views.independent_copy_hint")}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (canSave && destination) save.mutate({ owner: destination.owner, title, copy: true }); }}>
      {savedOwners.length > 0 && <section className="space-y-1" aria-labelledby={`${id}-saved`}>
        <p id={`${id}-saved`} className="text-xs font-medium text-muted-foreground">{t("views.already_saved_in")}</p>
        {savedOwners.map(view => <div key={viewOwnerKey(view.owner)} className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
          <Check className="size-4 shrink-0 text-success" /><div className="min-w-0 flex-1"><p className="truncate text-sm">{destinations.data?.find(item => sameViewOwner(item.owner, view.owner))?.name ?? view.title}</p><p className="text-xs text-muted-foreground">{t(view.owner.kind === "wiki" ? "wiki.title" : "views.project_location")}</p></div>
          <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => { requestTab(viewPanelTab(client.baseUrl, { owner: view.owner, viewId: view.id }, view.title)); onClose(); }}>{t("session.open")}</Button>
        </div>)}
      </section>}
      <div className="space-y-2"><Label htmlFor={`${id}-name`}>{t("views.name")}</Label><Input id={`${id}-name`} autoFocus maxLength={200} required value={title} disabled={save.isPending} onChange={event => setTitle(event.target.value)} /></div>
      <div className="space-y-2">
        <Label id={`${id}-location`}>{t("views.location")}</Label>
        <div className="flex gap-1" role="group" aria-label={t("views.destination_type")}>
          <Button type="button" size="sm" disabled={save.isPending} variant={kind === "workspace" ? "secondary" : "ghost"} aria-pressed={kind === "workspace"} onClick={() => { setCategory("workspace"); setSelected(null); setSearch(""); }}>{t("projects.plural")}</Button>
          <Button type="button" size="sm" disabled={save.isPending} variant={kind === "wiki" ? "secondary" : "ghost"} aria-pressed={kind === "wiki"} onClick={() => { setCategory("wiki"); setSelected(null); setSearch(""); }}>{t("views.wikis")}</Button>
        </div>
        {(available?.filter(item => item.owner.kind === kind).length ?? 0) > 5 && <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input disabled={save.isPending} className="pl-9" aria-label={t("views.search_destinations")} placeholder={t("views.search_destinations")} value={search} onChange={event => setSearch(event.target.value)} /></div>}
        {/* Base UI measures radio offsets against this scroll container on mount and keyboard navigation. */}
        {!loading && !error && <RadioGroup aria-labelledby={`${id}-location`} className="relative max-h-44 gap-1 overflow-y-auto" value={destination ? viewOwnerKey(destination.owner) : ""} onValueChange={value => { if (typeof value === "string") setSelected(value); }} disabled={save.isPending}>
          {groups.flatMap(group => group.items.map(item => <label key={viewOwnerKey(item.owner)} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 hover:bg-muted/50 has-data-checked:border-primary/40 has-data-checked:bg-muted/50">
            <RadioGroupItem value={viewOwnerKey(item.owner)} />{item.owner.kind === "wiki" ? <BookOpen className="size-4 shrink-0 text-muted-foreground" /> : <FolderIcon className="size-4 shrink-0" />}<span className="min-w-0 flex-1 truncate">{item.name}</span>
          </label>))}
        </RadioGroup>}
        {!loading && !error && groups.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t(search ? "views.no_matching_destinations" : "views.no_further_destinations")}</p>}
        {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t("common.loading")}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{t("views.locations_check_failed")}<Button type="button" size="sm" variant="ghost" onClick={() => { void destinations.refetch(); void locations.refetch(); }}>{t("wiki.retry")}</Button></p>}
        {destination && <p className="text-xs text-muted-foreground">{t("views.copy_folder_hint", { folder: t(preview.input.mode === "dashboard" ? "views.dashboards" : "views.reports") })}</p>}
      </div>
      {destination && !sameViewOwner(destination.owner, preview.owner) && Object.keys(preview.input.queries).length > 0 && <p className="text-xs text-muted-foreground">{t("views.copy_snapshot_hint")}</p>}
      {destination?.owner.kind === "wiki" && <p className="text-xs text-muted-foreground">{t("views.wiki_save_hint")}</p>}
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={!canSave}>{save.isPending && <Loader2 className="size-4 animate-spin" />}{t("views.save_copy")}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
