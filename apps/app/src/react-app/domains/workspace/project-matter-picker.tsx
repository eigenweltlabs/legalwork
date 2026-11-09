import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { matchesProjectReferenceFilters, type ProjectField, type ProjectRecordReference } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { RecordCreationProvider } from "../back-office/record-creation-context";
import { RecordCreateForm } from "../back-office/record-create-form";
import { creatableRecordObject } from "../back-office/record-creation-values";
import { displayBackOfficeObject } from "../back-office/labels";
import { BackOfficeTheme } from "../back-office/twenty-controls";
import { ObjectIcon } from "../back-office/object-icon";
import { useProjectBackOffice } from "./project-record-field";

export function ProjectMatterPicker({ client, field, disabled, onChange, onCreatingChange }: {
  client: LegalworkServerClient | null;
  field: Extract<ProjectField, { type: "backoffice" }>;
  disabled: boolean;
  onChange: (value: ProjectRecordReference | null) => void;
  onCreatingChange: (creating: boolean) => void;
}) {
  const directory = useProjectBackOffice(client);
  const data = directory.data;
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [creating, setCreating] = useState(false);
  useEffect(() => {
    onCreatingChange(open && creating);
    return () => onCreatingChange(false);
  }, [open, creating, onCreatingChange]);
  const object = data?.model.objects.find(object => object.id === "matters" && !object.archived);
  const creatable = creatableRecordObject(data, "matters");
  const records = data?.records.filter(record => record.objectId === "matters" && !record.archivedAt) ?? [];
  const selected = field.value?.recordIds ?? [];
  const currentDirectory = field.value === null || field.value.directoryId === data?.directoryId;
  const search = query.trim().toLocaleLowerCase();
  const matches = object ? records.filter(record => matchesProjectReferenceFilters(record, object, field.filters)
    && `${record.values.name ?? ""}\n${record.values.fileNumber ?? ""}`.toLocaleLowerCase().includes(search)) : [];
  const setSelection = (ids: string[]) => {
    if (data?.directoryId) onChange(ids.length ? { directoryId: data.directoryId, recordIds: ids } : null);
  };
  return <RecordCreationProvider client={client} state={data}>
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map(id => {
          const name = currentDirectory ? records.find(record => record.id === id)?.values.name : undefined;
          return <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/30 py-1 pl-2 text-xs">
            <ObjectIcon id="matters" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{String(name ?? t("projects.reference.unavailable"))}</span>
            <Button type="button" variant="ghost" size="icon-sm" className="size-5 shrink-0" disabled={disabled}
              aria-label={`${t("common.remove")}: ${name ?? t("projects.reference.unavailable")}`}
              onClick={() => { if (field.value) onChange(selected.length === 1 ? null : { directoryId: field.value.directoryId, recordIds: selected.filter(item => item !== id) }); }}><X className="size-3" /></Button>
          </span>;
        })}
        <Popover open={open && !disabled} onOpenChange={value => { setOpen(value); if (!value) { setQuery(""); setCreating(false); } }}>
          <PopoverTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled || !object || !data?.directoryId} />}>
            <Plus className="size-3.5" />{t(directory.isPending ? "common.loading" : "projects.matters.choose")}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(400px,calc(100vw-32px))] max-h-[min(540px,70vh)] overflow-y-auto p-2" onKeyDown={event => event.stopPropagation()}>
            {creating && creatable ? <BackOfficeTheme>
              <RecordCreateForm object={displayBackOfficeObject(creatable)} name={query.trim()} filters={field.filters}
                onCancel={() => setCreating(false)} onCreated={async record => {
                  setSelection(field.multiple && currentDirectory ? [...selected.filter(id => id !== record.id), record.id] : [record.id]);
                  setCreating(false); setOpen(false); setQuery("");
                }} />
            </BackOfficeTheme> : <Command filter={null} value={query} onValueChange={(value, details) => { if (details.reason !== "item-press") setQuery(value); }}>
              <CommandInput aria-label={t("projects.matters.search")} placeholder={t("projects.matters.search")} />
              <CommandList className="max-h-64 overflow-y-auto">
                {matches.map(record => <CommandItem key={record.id} value={record.id} onClick={() => {
                  const ids = currentDirectory ? selected : [];
                  setSelection(ids.includes(record.id) ? ids.filter(id => id !== record.id) : field.multiple ? [...ids, record.id] : [record.id]);
                  if (!field.multiple) setOpen(false);
                }} className="gap-2 rounded-md px-2">
                  <ObjectIcon id="matters" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{String(record.values.name)}</span>
                    {typeof record.values.fileNumber === "string" && record.values.fileNumber && <span className="block truncate text-xs text-muted-foreground">{record.values.fileNumber}</span>}
                  </span>
                  {currentDirectory && selected.includes(record.id) && <Check className="size-4 shrink-0" />}
                </CommandItem>)}
                {!matches.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t("projects.matters.no_matches")}</p>}
                {creatable && <CommandItem value="create-matter" onClick={() => setCreating(true)} className="gap-2 rounded-md border-t px-2">
                  <Plus className="size-4" />{t("projects.matters.create")}
                </CommandItem>}
              </CommandList>
            </Command>}
          </PopoverContent>
        </Popover>
      </div>
      {directory.error && <p role="alert" className="text-xs text-destructive">{t("projects.matters.unavailable")}</p>}
    </div>
  </RecordCreationProvider>;
}
