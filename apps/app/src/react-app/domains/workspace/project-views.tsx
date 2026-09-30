import { useState } from "react";
import { Bookmark, Check, ChevronDown, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { projectViewHasChanges, useProjectFilterStore } from "./project-filters";

export function ProjectViews({ onSelect }: { onSelect: () => void }) {
  const state = useProjectFilterStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const active = state.views.find(view => view.id === state.activeViewId);
  const changed = active ? projectViewHasChanges(active, state) : false;
  const filtered = state.teamOnly || state.filters.length > 0 || !state.descending;
  const name = editing?.name.trim() ?? "";
  const normalize = (value: string) => value.normalize("NFC").trim().toLowerCase();
  const duplicate = state.views.some(view => view.id !== editing?.id && normalize(view.name) === normalize(name));
  const select = (id: string | null) => { state.selectView(id); setOpen(false); onSelect(); };

  return <div className="mb-3 flex min-h-8 flex-wrap items-center gap-2">
    <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setSearch(""); }}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className="h-8 min-w-0 max-w-72 gap-2 px-2 text-sm" aria-label={t("project_views.choose")}><Bookmark className="size-3.5 shrink-0" /><span className="truncate">{active?.name ?? t(filtered ? "project_views.custom" : "project_views.all")}</span>{changed && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" title={t("project_views.unsaved")} />}<ChevronDown className="size-3 shrink-0 text-muted-foreground" /></Button>} />
      <PopoverContent align="start" className="w-72 gap-0 p-1.5">
        <PopoverTitle className="px-2 py-2 text-xs font-medium text-muted-foreground">{t("project_views.title")}</PopoverTitle>
        {state.views.length > 5 && <Input autoFocus className="mb-1 h-8 text-xs" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("project_views.search")} aria-label={t("project_views.search")} />}
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal" onClick={() => select(null)}><Check className={cn("size-3.5", (active || filtered) && "invisible")} />{t("project_views.all")}</Button>
        <div className="max-h-64 overflow-auto">
          {state.views.filter(view => normalize(view.name).includes(normalize(search))).map(view => <div key={view.id} className="group flex items-center rounded-lg hover:bg-muted/60">
            <Button variant="ghost" className="h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-xs font-normal" onClick={() => select(view.id)}><Check className={cn("size-3.5 shrink-0", view.id !== state.activeViewId && "invisible")} /><span className="truncate">{view.name}</span></Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t("project_views.actions", { name: view.name })} className="mr-1 shrink-0"><MoreHorizontal className="size-3.5" /></Button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { setEditing({ id: view.id, name: view.name }); setOpen(false); }}><Pencil className="size-3.5" />{t("project_views.rename")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setDeleting(view.id); setOpen(false); }}><Trash2 className="size-3.5" />{t("project_views.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>)}
        </div>
        {!state.views.length && <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">{t("project_views.empty")}</p>}
        <div className="mt-1 border-t border-border/60 pt-1"><Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal" onClick={() => { setEditing({ name: "" }); setOpen(false); }}><Plus className="size-3.5" />{t("project_views.save_as")}</Button></div>
      </PopoverContent>
    </Popover>
    {changed && <><span className="text-xs text-muted-foreground">{t("project_views.unsaved")}</span><Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={state.updateView}>{t("project_views.update")}</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => select(state.activeViewId)}>{t("project_views.reset")}</Button></>}
    {(filtered || active) && <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => setEditing({ name: "" })}><Plus className="size-3" />{t("project_views.save_as")}</Button>}
    <Dialog open={editing !== null} onOpenChange={value => { if (!value) setEditing(null); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t(editing?.id ? "project_views.rename" : "project_views.save_as")}</DialogTitle><DialogDescription>{t("project_views.save_hint")}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault();
          if (!editing || !name || duplicate) return;
          if (editing.id) state.renameView(editing.id, name); else state.saveView(name);
          setEditing(null);
        }}>
          <Input autoFocus maxLength={80} value={editing?.name ?? ""} aria-label={t("project_views.name")} placeholder={t("project_views.name")} onChange={event => setEditing(current => current && { ...current, name: event.target.value })} />
          {duplicate && <p role="alert" className="text-xs text-destructive">{t("project_views.duplicate")}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button><Button type="submit" disabled={!name || duplicate}>{t("common.save")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={deleting !== null} onOpenChange={value => { if (!value) setDeleting(null); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t("project_views.delete_title", { name: state.views.find(view => view.id === deleting)?.name ?? "" })}</DialogTitle><DialogDescription>{t("project_views.delete_hint")}</DialogDescription></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => { if (deleting) state.deleteView(deleting); setDeleting(null); }}>{t("project_views.delete")}</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
