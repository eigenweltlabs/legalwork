import { useState } from "react";
import { BookOpen, Check, ChevronDown, Loader2, Search } from "lucide-react";
import type { ViewOwner, ViewSaveSource, ViewPreview, ViewRecord } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { sameViewOwner, viewOwnerKey } from "./view-save";
import { useViewSaveDestinations, viewSaveDestinationGroups } from "./view-save-destinations";
import { useViewSave } from "./use-view-save";

export function ViewSaveDialog({ client, preview, savedFrom, copyTitle = false, onClose, onSaved }: { savedFrom?: ViewSaveSource; copyTitle?: boolean; client: LegalworkServerClient; preview: ViewPreview; onClose: () => void; onSaved: (view: ViewRecord) => void }) {
  const [title, setTitle] = useState(() => copyTitle ? t("views.copy_title", { title: preview.input.title }).slice(0, 200) : preview.input.title);
  const [owner, setOwner] = useState(preview.owner);
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ViewOwner["kind"]>(preview.owner.kind);
  const destinations = useViewSaveDestinations(client);
  const destination = destinations.data?.find(item => sameViewOwner(item.owner, owner));
  const groups = viewSaveDestinationGroups(destinations.data, preview.owner, search, kind);
  const save = useViewSave(client, preview, savedFrom, onSaved);
  const name = destination?.name ?? t(owner.kind === "wiki" ? "views.current_wiki" : "views.current_project");
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent showCloseButton={!save.isPending}>
    <DialogHeader><DialogTitle>{t("views.save_as_title")}</DialogTitle><DialogDescription>{t("views.save_as_hint")}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!save.isPending && title.trim() && destination && !destinations.error) save.mutate({ owner, title, copy: true }); }}>
      <div className="space-y-2"><Label htmlFor="view-save-name">{t("views.name")}</Label><Input id="view-save-name" autoFocus maxLength={200} required value={title} disabled={save.isPending} onChange={event => setTitle(event.target.value)} /></div>
      <div className="space-y-2">
        <Label id="view-save-location-label">{t("views.location")}</Label>
        <Button type="button" variant="outline" className="h-auto w-full justify-start py-2 text-left" disabled={save.isPending} aria-labelledby="view-save-location-label view-save-location" aria-expanded={choosing} onClick={() => { setChoosing(value => !value); setKind(owner.kind); setSearch(""); }}>
          {owner.kind === "wiki" ? <BookOpen className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
          <span id="view-save-location" className="min-w-0 flex-1"><span className="block truncate">{name}</span><span className="block text-xs font-normal text-muted-foreground">{t(owner.kind === "wiki" ? "wiki.title" : "views.project_location")} · {t(preview.input.mode === "dashboard" ? "views.dashboards" : "views.reports")}</span></span><ChevronDown className="size-4 shrink-0" />
        </Button>
        {choosing && <div className="space-y-2 rounded-lg border p-2">
          <div className="flex gap-1" role="group" aria-label={t("views.destination_type")}>
            <Button type="button" size="sm" disabled={save.isPending} variant={kind === "workspace" ? "secondary" : "ghost"} aria-pressed={kind === "workspace"} onClick={() => setKind("workspace")}>{t("projects.plural")}</Button>
            <Button type="button" size="sm" disabled={save.isPending} variant={kind === "wiki" ? "secondary" : "ghost"} aria-pressed={kind === "wiki"} onClick={() => setKind("wiki")}>{t("views.wikis")}</Button>
          </div>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input disabled={save.isPending} className="pl-9" aria-label={t("views.search_destinations")} placeholder={t("views.search_destinations")} value={search} onChange={event => setSearch(event.target.value)} /></div>
          <div className="max-h-52 overflow-y-auto">
            {!destinations.isPending && !destinations.error && groups.length === 0 && <p className="p-2 text-sm text-muted-foreground">{t("views.no_matching_destinations")}</p>}
            {groups.flatMap(group => group.items.map(item => <Button type="button" disabled={save.isPending} key={viewOwnerKey(item.owner)} variant="ghost" className="w-full justify-start" onClick={() => { setOwner(item.owner); setChoosing(false); }}>
              {item.owner.kind === "wiki" ? <BookOpen className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}<span className="min-w-0 flex-1 truncate text-left">{item.name}</span>{sameViewOwner(owner, item.owner) && <Check className="size-4 shrink-0" />}
            </Button>))}
          </div>
        </div>}
        {destinations.isPending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t("common.loading")}</p>}
        {destinations.error && <p role="alert" className="text-sm text-destructive">{destinations.error.message}<Button type="button" size="sm" variant="ghost" onClick={() => void destinations.refetch()}>{t("wiki.retry")}</Button></p>}
        {destinations.data && !destination && <p role="alert" className="text-sm text-destructive">{t("views.choose_available_location")}</p>}
      </div>
      {!sameViewOwner(owner, preview.owner) && Object.keys(preview.input.queries).length > 0 && <p className="text-xs text-muted-foreground">{t("views.copy_snapshot_hint")}</p>}
      {owner.kind === "wiki" && <p className="text-xs text-muted-foreground">{t("views.wiki_save_hint")}</p>}
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={save.isPending || !title.trim() || !destination || Boolean(destinations.error)}>{save.isPending && <Loader2 className="size-4 animate-spin" />}{t("common.save")}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
