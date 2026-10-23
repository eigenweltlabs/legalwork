import { useState } from "react";
import { Blocks, ChevronDown, Search, ShieldAlert, Sparkles, Workflow, X } from "lucide-react";
import type { AssistantResource } from "@legalwork/types/main-assistant";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { IconTile } from "@/react-app/design-system/surface";
import { t } from "@/i18n";

type Props = {
  kind: AssistantResource["kind"];
  label: string;
  resources: AssistantResource[];
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
  projectAllowed: (id: string) => boolean;
  disabled?: boolean;
};

export function AssistantResourcePicker({ kind, label, resources, selectedIds, onToggle, projectAllowed, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = resources.filter(item => selectedIds.includes(item.id));
  const query = search.trim().toLocaleLowerCase();
  const matches = resources.filter(item => `${item.name} ${item.description} ${item.projectName ?? ""}`.toLocaleLowerCase().includes(query));
  const Icon = kind === "plugin" ? Blocks : kind === "workflow" ? Workflow : Sparkles;
  return <div className="space-y-3 px-5 py-4">
    <div className="flex items-center gap-3">
      <IconTile size="sm" variant="inset"><Icon aria-hidden="true" className="size-4" /></IconTile>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">{label}</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">{selected.length ? t("assistant.selection_count", { count: selected.length }) : t("assistant.resources_none_selected")}</p>
      </div>
      <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setSearch(""); }}>
        <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled} aria-label={`${t("assistant.resources_choose")}: ${label}`} />}>{t("assistant.resources_choose")}<ChevronDown className="size-3.5" /></PopoverTrigger>
        <PopoverContent align="end" className="w-[min(420px,calc(100vw-32px))] gap-0 overflow-hidden p-0">
          <PopoverTitle className="border-b border-border px-4 py-3 text-sm">{label}</PopoverTitle>
          <div className="relative border-b border-border">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={search} onChange={event => setSearch(event.target.value)} aria-label={`${t("assistant.resources_search")}: ${label}`} placeholder={t("assistant.resources_search")} className="h-11 rounded-none border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0" />
          </div>
          {open && <AssistantResourceOptions resources={matches} selectedIds={selectedIds} onToggle={onToggle} projectAllowed={projectAllowed} disabled={disabled} />}
        </PopoverContent>
      </Popover>
    </div>
    {selected.length > 0 && <div className="flex flex-wrap gap-2">
      {selected.slice(0, 3).map(item => <Badge key={item.id} variant="secondary" className="h-auto min-h-7 max-w-full gap-1 py-0 pl-2.5 pr-0.5 font-normal" title={item.projectId && !projectAllowed(item.projectId) ? t("assistant.resource_project_blocked") : item.projectName ?? item.name}>
        {item.projectId && !projectAllowed(item.projectId) && <ShieldAlert aria-label={t("assistant.resource_project_blocked")} className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{item.name}</span>
        <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} aria-label={`${t("common.remove")}: ${item.name}`} onClick={() => onToggle(item.id, false)}><X /></Button>
      </Badge>)}
      {selected.length > 3 && <Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={`${t("assistant.resources_choose")}: ${label}`} onClick={() => setOpen(true)}>+{selected.length - 3}</Button>}
    </div>}
  </div>;
}

export function AssistantResourceOptions({ resources, selectedIds, onToggle, projectAllowed, disabled }: Omit<Props, "kind" | "label">) {
  return <div className="max-h-72 overflow-y-auto p-1.5">
    {resources.map(item => <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2.5 py-3 transition-colors hover:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring/40 has-[[aria-checked=true]]:bg-muted/60">
      <Checkbox className="mt-0.5" checked={selectedIds.includes(item.id)} disabled={disabled} onCheckedChange={checked => onToggle(item.id, checked)} />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium leading-5">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.projectName ?? t("assistant.resources_global")}</span>
        {item.description && <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={item.description}>{item.description}</span>}
        {item.projectId && !projectAllowed(item.projectId) && <span className="mt-1 block text-xs text-muted-foreground">{t("assistant.resource_project_blocked")}</span>}
      </span>
    </label>)}
    {!resources.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("assistant.resources_empty")}</p>}
  </div>;
}
