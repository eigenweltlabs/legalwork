import { useState } from "react";
import { ArrowLeft, CalendarDays, Check, ChevronDown, Hash, ListFilter, Loader2, Plus, Search, Type, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { filterNeedsValue, filterOperators, validProjectFilter, type FilterOperator, type ProjectFilter, type ProjectFilterField, type ProjectFilterMode } from "./project-filters";

const icons = { text: Type, number: Hash, date: CalendarDays, select: ListFilter };

function operatorLabel(operator: FilterOperator, type: ProjectFilterField["type"]) {
  if (type === "select" && (operator === "is" || operator === "is_not")) return t(`project_filters.${operator === "is" ? "is_any" : "is_none"}`);
  if (type === "date" && operator === "is") return t("project_filters.on");
  return t(`project_filters.${operator}`);
}

function filterSummary(filter: ProjectFilter) {
  const display = (value: string) => filter.field.type === "date"
    ? new Date(`${value}T00:00:00`).toLocaleDateString(currentLocale(), { day: "numeric", month: "short", year: "numeric" })
    : filter.field.type === "number" ? Number(value).toLocaleString(currentLocale()) : value;
  if (!filterNeedsValue(filter.operator)) return "";
  if (filter.operator === "between") return filter.values.map(display).join(" – ");
  if (filter.values.length > 2) return `${display(filter.values[0])} +${filter.values.length - 1}`;
  return filter.values.map(display).join(", ");
}

export function ProjectFilterBar(props: {
  fields: ProjectFilterField[];
  filters: ProjectFilter[];
  mode: ProjectFilterMode;
  onChange: (filters: ProjectFilter[]) => void;
  onModeChange: (mode: ProjectFilterMode) => void;
  onClear: () => void;
  resultCount: number;
  totalCount: number;
  loading: boolean;
  unavailable: number;
  onRetry: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [field, setField] = useState<ProjectFilterField | null>(null);
  const [search, setSearch] = useState("");
  const candidates = props.fields.filter(field => field.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="mb-4 space-y-2" aria-label={t("project_filters.title")}>
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <Popover open={adding} onOpenChange={open => { setAdding(open); if (!open) { setField(null); setSearch(""); } }}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" className={cn("h-8 gap-1.5 px-2 text-xs font-medium", props.filters.length > 0 ? "text-foreground" : "text-muted-foreground")}><ListFilter className="size-3.5" />{t("project_filters.title")}{props.filters.length > 0 && <span className="rounded bg-muted px-1.5 text-[10px] tabular-nums">{props.filters.length}</span>}</Button>} />
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
          {field ? <>
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <Button variant="ghost" size="icon-xs" aria-label={t("project_filters.back")} onClick={() => setField(null)}><ArrowLeft className="size-3.5" /></Button>
              <PopoverTitle className="truncate text-xs font-medium">{field.label}</PopoverTitle>
            </div>
            <ProjectFilterEditor key={field.key} field={field} onApply={filter => { props.onChange([...props.filters, filter]); setAdding(false); setField(null); setSearch(""); }} />
          </> : <>
            <PopoverTitle className="sr-only">{t("project_filters.add")}</PopoverTitle>
            <Command items={candidates} filter={null} value={search} onValueChange={setSearch}>
              <CommandInput placeholder={t("project_filters.search_fields")} aria-label={t("project_filters.search_fields")} className="h-10 text-xs" />
              <div className="border-t border-border/60">
                <CommandList className="max-h-72 overflow-auto p-1.5">
                  {candidates.map(field => {
                    const Icon = icons[field.type];
                    return <CommandItem key={field.key} value={field.key} onClick={() => setField(field)} className="gap-2.5 rounded-lg px-2 py-2 text-xs">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{field.label}</span>
                      <span className="text-[10px] text-muted-foreground">{t(`projects.type_${field.type}`)}</span>
                    </CommandItem>;
                  })}
                  <CommandEmpty className="px-2 py-5 text-center text-xs text-muted-foreground">{t(props.loading ? "projects.loading" : "project_filters.no_fields")}</CommandEmpty>
                </CommandList>
              </div>
            </Command>
          </>}
        </PopoverContent>
      </Popover>
      {props.filters.length > 0 && <>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        {props.filters.length > 1 && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-xs font-normal text-muted-foreground" aria-label={t("project_filters.combine")} >{t(props.mode === "all" ? "project_filters.match_all" : "project_filters.match_any")}<ChevronDown className="size-3" /></Button>} />
          <DropdownMenuContent align="start" className="w-64">
            {(["all", "any"] satisfies ProjectFilterMode[]).map(mode => <DropdownMenuItem key={mode} onClick={() => props.onModeChange(mode)} className="items-start gap-2">
              <Check className={cn("mt-0.5 size-3.5", props.mode !== mode && "invisible")} />
              <span><span className="block text-xs">{t(`project_filters.match_${mode}`)}</span><span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{t(`project_filters.match_${mode}_hint`)}</span></span>
            </DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>}
        {props.filters.map(filter => <FilterChip key={filter.id} filter={filter} field={props.fields.find(field => field.key === filter.field.key)}
          onChange={updated => props.onChange(props.filters.map(item => item.id === filter.id ? updated : item))}
          onRemove={() => props.onChange(props.filters.filter(item => item.id !== filter.id))} />)}
        <Button variant="ghost" size="icon-xs" aria-label={t("project_filters.add")} title={t("project_filters.add")} className="text-muted-foreground" onClick={() => setAdding(true)}><Plus className="size-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-normal text-muted-foreground" onClick={props.onClear}>{t("project_filters.clear")}</Button>
      </>}
      <span className="ml-auto flex items-center gap-1.5 pl-2 text-xs tabular-nums text-muted-foreground" role="status">
        {props.loading && props.filters.length > 0 ? <><Loader2 className="size-3 animate-spin" />{t("project_filters.loading")}</> : props.filters.length > 0 ? t("project_filters.result_count", { count: props.resultCount, total: props.totalCount }) : t("project_filters.project_count", { count: props.totalCount })}
      </span>
    </div>
    {props.unavailable > 0 && <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" role="status">
      <span>{t("project_filters.unavailable", { count: props.unavailable })}</span>
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={props.onRetry}>{t("project_filters.retry")}</button>
    </div>}
  </div>;
}

function FilterChip({ filter, field, onChange, onRemove }: { filter: ProjectFilter; field?: ProjectFilterField; onChange: (filter: ProjectFilter) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const resolved = field ?? { ...filter.field, options: [] };
  const Icon = icons[resolved.type];
  const summary = filterSummary(filter);
  return <div className="inline-flex h-7 min-w-0 max-w-full items-center rounded-lg border border-border/80 bg-muted/35 text-xs">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" className="h-[26px] min-w-0 gap-1.5 rounded-r-none px-2 text-xs font-normal" title={`${resolved.label} ${operatorLabel(filter.operator, resolved.type)} ${summary}`}>
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="max-w-36 truncate">{resolved.label}</span>
        <span className="shrink-0 text-muted-foreground">{operatorLabel(filter.operator, resolved.type)}</span>
        {summary && <span className="max-w-40 truncate font-medium">{summary}</span>}
      </Button>} />
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
        <PopoverTitle className="border-b border-border/60 px-4 py-3 text-xs font-medium">{resolved.label}</PopoverTitle>
        {open && <ProjectFilterEditor initial={filter} field={resolved} onApply={filter => { onChange(filter); setOpen(false); }} />}
      </PopoverContent>
    </Popover>
    <Button variant="ghost" size="icon-xs" className="mr-0.5 size-5 shrink-0 rounded-md text-muted-foreground hover:text-foreground" aria-label={t("project_filters.remove", { name: resolved.label })} onClick={onRemove}><X className="size-3" /></Button>
  </div>;
}

function ProjectFilterEditor({ field, initial, onApply }: { field: ProjectFilterField; initial?: ProjectFilter; onApply: (filter: ProjectFilter) => void }) {
  const [operator, setOperator] = useState<FilterOperator>(initial?.operator ?? filterOperators(field.type)[0]);
  const [values, setValues] = useState(initial?.values ?? []);
  const [search, setSearch] = useState("");
  const draft: ProjectFilter = { id: initial?.id ?? "draft", field: { key: field.key, label: field.label, type: field.type }, operator, values };
  const needsValue = filterNeedsValue(operator);
  const options = [...field.options, ...values.filter(value => value && !field.options.some(option => option.value === value)).map(value => ({ value, count: 0 }))];
  const visibleOptions = options.filter(option => option.value.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const suggestions = field.type === "text" ? field.options.filter(option => option.value.toLocaleLowerCase().includes((values[0] ?? "").toLocaleLowerCase())).slice(0, 6) : [];
  const valid = validProjectFilter(draft);
  return <form className="min-w-0 p-3" onSubmit={event => { event.preventDefault(); if (valid) onApply({ ...draft, id: initial?.id ?? crypto.randomUUID() }); }}>
    <Select value={operator} onValueChange={value => {
      const next = filterOperators(field.type).find(operator => operator === value);
      if (!next) return;
      setOperator(next);
      setValues(current => field.type === "select" ? current : current.slice(0, next === "between" ? 2 : 1));
    }}>
      <SelectTrigger aria-label={t("project_filters.operator")} className="h-8 w-full text-xs"><SelectValue>{operatorLabel(operator, field.type)}</SelectValue></SelectTrigger>
      <SelectContent align="start">{filterOperators(field.type).map(operator => <SelectItem key={operator} value={operator} className="text-xs">{operatorLabel(operator, field.type)}</SelectItem>)}</SelectContent>
    </Select>
    {needsValue && (field.type === "select" ? <div className="mt-3">
      <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input autoFocus aria-label={t("project_filters.search_options")} placeholder={t("project_filters.search_options")} className="h-8 pl-8 text-xs md:text-xs" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="mt-2 max-h-52 space-y-0.5 overflow-auto">
        {visibleOptions.map(option => <label key={option.value} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-xs hover:bg-muted/70">
          <Checkbox checked={values.includes(option.value)} onCheckedChange={checked => setValues(current => checked ? [...current, option.value] : current.filter(value => value !== option.value))} />
          <span className="min-w-0 flex-1 truncate" title={option.value}>{option.value}</span><span className="text-[10px] tabular-nums text-muted-foreground">{option.count}</span>
        </label>)}
        {!visibleOptions.length && <p className="py-4 text-center text-xs text-muted-foreground">{t("project_filters.no_options")}</p>}
      </div>
    </div> : <div className="mt-3 space-y-2">
      <div className={cn("grid gap-2", operator === "between" && "grid-cols-2")}>
        {(operator === "between" ? [0, 1] : [0]).map(index => <label key={index} className="min-w-0 space-y-1 text-xs text-muted-foreground">
          {operator === "between" && <span>{t(index === 0 ? "project_filters.from" : "project_filters.to")}</span>}
          <Input autoFocus={index === 0} required type={field.type === "text" ? "text" : field.type} step="any" lang={currentLocale()} maxLength={4000}
            aria-label={operator === "between" ? t(index === 0 ? "project_filters.from" : "project_filters.to") : t("project_filters.value")}
            placeholder={t("project_filters.value")} className="h-8 px-2 text-xs md:text-xs" value={values[index] ?? ""}
            onChange={event => setValues(current => index === 0 ? [event.target.value, ...(operator === "between" ? [current[1] ?? ""] : [])] : [current[0] ?? "", event.target.value])} />
        </label>)}
      </div>
      {operator === "between" && values.length === 2 && values.every(value => value.trim()) && !valid && <p className="text-xs text-destructive" role="alert">{t("project_filters.invalid_range")}</p>}
      {suggestions.length > 0 && <div className="max-h-40 overflow-auto border-t border-border/60 pt-1">
        {suggestions.map(option => <Button key={option.value} type="button" variant="ghost" className="h-7 w-full justify-between gap-2 px-2 text-xs font-normal" onClick={() => setValues([option.value])}><span className="truncate">{option.value}</span><span className="text-[10px] tabular-nums text-muted-foreground">{option.count}</span></Button>)}
      </div>}
    </div>)}
    <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/60 pt-3">
      {field.type === "select" && needsValue && <span className="mr-auto text-[11px] text-muted-foreground">{t("project_filters.selected", { count: values.length })}</span>}
      <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={!valid}>{t(initial ? "project_filters.apply" : "project_filters.add")}</Button>
    </div>
  </form>;
}
