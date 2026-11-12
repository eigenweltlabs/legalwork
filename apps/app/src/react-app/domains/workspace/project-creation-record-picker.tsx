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
import { projectReferenceObjects } from "./project-record-field";
import type { BackOfficeState } from "../back-office/api";
import { projectQuickActionLabel } from "./project-connections";
import { matterPickerOptions, recentMatterIds, rememberMatter } from "./matter-picker-options";

export function ProjectCreationRecordPicker({ client, state, field, disabled, onChange, onCreatingChange }: {
  client: LegalworkServerClient | null;
  state?: BackOfficeState;
  field: Extract<ProjectField, { type: "backoffice" }>;
  disabled: boolean;
  onChange: (value: ProjectRecordReference | null) => void;
  onCreatingChange: (fieldId: string, creating: boolean) => void;
}) {
  const data = state;
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [creating, setCreating] = useState(false);
  const [recent, setRecent] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  const scope = JSON.stringify([client?.baseUrl, data?.directoryId, data?.permissions.userId, data?.permissions.principalKey, data?.permissions.replicaId]);
  useEffect(() => {
    onCreatingChange(field.id, open && creating);
    return () => onCreatingChange(field.id, false);
  }, [field.id, open, creating, onCreatingChange]);
  const object = projectReferenceObjects(data).find(object => object.id === field.objectId);
  const creatable = creatableRecordObject(data, field.objectId);
  const records = data?.records.filter(record => record.objectId === field.objectId && !record.archivedAt) ?? [];
  const selected = field.value?.recordIds ?? [];
  const currentDirectory = field.value === null || field.value.directoryId === data?.directoryId;
  const isMatter = field.objectId === "matters";
  const label = object?.label ?? field.label;
  const searchLabel = isMatter ? t("projects.matters.search") : t("back_office.create.search", { name: object?.plural ?? field.label });
  const options = isMatter ? matterPickerOptions(data?.records ?? [], query, recent.scope === scope ? recent.ids : [])
    : records.filter(record => String(record.values.name).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .sort((a, b) => String(a.values.name).localeCompare(String(b.values.name)))
      .map(record => ({ record, clientNames: [], reference: "" }));
  const matches = object ? options.filter(({ record }) => matchesProjectReferenceFilters(record, object, field.filters)) : [];
  const setSelection = (ids: string[]) => {
    if (data?.directoryId) onChange(ids.length ? { directoryId: data.directoryId, recordIds: ids } : null);
  };
  return <RecordCreationProvider client={client} state={data}>
    <div className={selected.length ? "w-full space-y-2" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map(id => {
          const name = currentDirectory ? records.find(record => record.id === id)?.values.name : undefined;
          return <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/30 py-1 pl-2 text-xs">
            <ObjectIcon id={field.objectId} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{String(name ?? t("projects.reference.unavailable"))}</span>
            <Button type="button" variant="ghost" size="icon-sm" className="size-5 shrink-0" disabled={disabled}
              aria-label={`${t("common.remove")}: ${name ?? t("projects.reference.unavailable")}`}
              onClick={() => { if (field.value) onChange(selected.length === 1 ? null : { directoryId: field.value.directoryId, recordIds: selected.filter(item => item !== id) }); }}><X className="size-3" /></Button>
          </span>;
        })}
        <Popover open={open && !disabled} onOpenChange={value => { setOpen(value); if (value) setRecent({ scope, ids: recentMatterIds(scope) }); else { setQuery(""); setCreating(false); } }}>
          <PopoverTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled || !object || !data?.directoryId || !currentDirectory} />}>
            <ObjectIcon id={field.objectId} className="size-3.5" />{projectQuickActionLabel(field)}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(400px,calc(100vw-32px))] max-h-[min(540px,70vh)] overflow-y-auto p-2" onKeyDown={event => event.stopPropagation()}>
            {creating && creatable ? <BackOfficeTheme>
              <RecordCreateForm object={displayBackOfficeObject(creatable)} name={query.trim()} filters={field.filters} persistenceNotice={t(isMatter ? "projects.matters.saved_separately" : "projects.connections.saved_separately")}
                onCancel={() => setCreating(false)} onCreated={async record => {
                  if (isMatter) rememberMatter(scope, record.id);
                  setSelection(field.multiple && currentDirectory ? [record.id, ...selected.filter(id => id !== record.id)] : [record.id]);
                  setCreating(false); setOpen(false); setQuery("");
                }} />
            </BackOfficeTheme> : <Command filter={null} value={query} onValueChange={(value, details) => { if (details.reason !== "item-press") setQuery(value); }}>
              <CommandInput aria-label={searchLabel} placeholder={searchLabel} />
              <CommandList className="max-h-64 overflow-y-auto">
                {matches.map(({ record, clientNames, reference }) => <CommandItem key={record.id} value={record.id} onClick={() => {
                  const ids = currentDirectory ? selected : [];
                  if (!ids.includes(record.id) && isMatter) rememberMatter(scope, record.id);
                  setSelection(ids.includes(record.id) ? ids.filter(id => id !== record.id) : field.multiple ? [...ids, record.id] : [record.id]);
                  if (!field.multiple) setOpen(false);
                }} className="gap-2 rounded-md px-2">
                  <ObjectIcon id={field.objectId} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{String(record.values.name)}</span>
                    {(clientNames.length > 0 || reference) && <span className="block truncate text-xs text-muted-foreground" title={[clientNames.join(", "), reference && t("projects.matters.reference", { reference })].filter(Boolean).join(" · ")}>
                      {[clientNames.join(", "), reference && t("projects.matters.reference", { reference })].filter(Boolean).join(" · ")}
                    </span>}
                  </span>
                  {currentDirectory && selected.includes(record.id) && <Check className="size-4 shrink-0" />}
                </CommandItem>)}
                {!matches.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t("projects.matters.no_matches")}</p>}
                {creatable && <CommandItem value="create-project-record" onClick={() => setCreating(true)} className="gap-2 rounded-md border-t px-2">
                  <Plus className="size-4" />{t(isMatter ? "projects.matters.create" : "back_office.create.title", { name: label })}
                </CommandItem>}
              </CommandList>
            </Command>}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  </RecordCreationProvider>;
}
