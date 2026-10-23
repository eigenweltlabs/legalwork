import { useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import type { AssistantSettingsCatalog } from "@legalwork/types/main-assistant";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { FolderIcon } from "@/react-app/design-system/folder-icon";
import { Surface } from "@/react-app/design-system/surface";
import { t } from "@/i18n";

type Props = {
  projects: AssistantSettingsCatalog["projects"];
  selectedIds: string[];
  mode: "include" | "exclude";
  disabled?: boolean;
  onToggle: (id: string, checked: boolean) => void;
};

export function AssistantProjectPicker({ projects, selectedIds, mode, disabled, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const selected = selectedIds.map(id => ({ id, name: projects.find(project => project.id === id)?.name ?? t("assistant.project_unavailable") }));
  const options = [...projects, ...selected.filter(item => !projects.some(project => project.id === item.id))];
  const matches = options.filter(project => project.name.toLocaleLowerCase().includes(query));
  const title = t(mode === "include" ? "assistant.project_selection_include" : "assistant.project_selection_exclude");
  return <Surface className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">{title}</h4><p className="text-xs text-muted-foreground">{t("assistant.selection_count", { count: selectedIds.length })}</p></div>
      <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setSearch(""); }}>
        <PopoverTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>{t("assistant.projects_choose")}<ChevronDown className="size-3.5" /></PopoverTrigger>
        <PopoverContent align="end" className="w-[min(420px,calc(100vw-32px))] gap-0 overflow-hidden p-0">
          <PopoverTitle className="border-b border-border px-4 py-3 text-sm">{title}</PopoverTitle>
          <div className="relative border-b border-border">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label={t("assistant.projects_search")} placeholder={t("assistant.projects_search")} className="h-11 rounded-none border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0" value={search} onChange={event => setSearch(event.target.value)} />
          </div>
          {open && <AssistantProjectOptions projects={matches} selectedIds={selectedIds} onToggle={onToggle} disabled={disabled} />}
        </PopoverContent>
      </Popover>
    </div>
    {selected.length > 0 && <div className="flex flex-wrap gap-2">
      {selected.slice(0, 3).map(project => <Badge key={project.id} variant="secondary" className="h-auto min-h-7 max-w-full gap-1 py-0 pl-2.5 pr-0.5 font-normal" title={project.name}>
        <FolderIcon className="size-4 shrink-0" /><span className="min-w-0 truncate">{project.name}</span>
        <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} aria-label={`${t("common.remove")}: ${project.name}`} onClick={() => onToggle(project.id, false)}><X /></Button>
      </Badge>)}
      {selected.length > 3 && <Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={`${t("assistant.projects_choose")}: ${t("assistant.selection_count", { count: selectedIds.length })}`} onClick={() => setOpen(true)}>+{selected.length - 3}</Button>}
    </div>}
  </Surface>;
}

export function AssistantProjectOptions({ projects, selectedIds, onToggle, disabled }: Omit<Props, "mode">) {
  return <div className="max-h-64 overflow-y-auto p-1.5">
    {projects.map(project => <label key={project.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/40 has-[[aria-checked=true]]:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring/40">
      <Checkbox checked={selectedIds.includes(project.id)} disabled={disabled} onCheckedChange={checked => onToggle(project.id, checked)} />
      <FolderIcon className="size-5 shrink-0" /><span className="min-w-0 break-words">{project.name}</span>
    </label>)}
    {!projects.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("assistant.projects_empty")}</p>}
  </div>;
}
