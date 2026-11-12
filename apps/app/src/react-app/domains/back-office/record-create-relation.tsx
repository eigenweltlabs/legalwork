import { useContext } from "react";
import { LocalCreationScope } from "./record-creation-context";
import { useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import type { BackOfficeField, BackOfficeValue } from "@legalwork/types/back-office";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { useRecordCreation } from "./record-creation-context";
import { creatableRecordObject, relationPickerOptions } from "./record-creation-values";
import { displayBackOfficeObject } from "./labels";
import { ObjectIcon } from "./object-icon";
import { RecordCreateForm } from "./record-create-form";
import { BackOfficeTheme } from "./twenty-controls";

export function RecordCreateRelation({ field, value, disabled, onChange, onSubmit }: {
  field: BackOfficeField; value: BackOfficeValue | undefined; disabled: boolean;
  onChange: (value: BackOfficeValue) => void; onSubmit: () => void;
}) {
  const creation = useRecordCreation();
  const source = useContext(LocalCreationScope);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [creating, setCreating] = useState(false);
  const object = creation?.state.model.objects.find(object => object.id === field.target);
  const pool = source ? creation?.state.localChoices : creation?.state.records;
  const records = pool?.filter(record => record.objectId === object?.id && !record.archivedAt) ?? [];
  const target = creatableRecordObject(creation?.state, field.target);
  const selected = Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" ? [value] : [];
  const setSelection = (ids: string[]) => onChange(field.multiple ? ids : ids[0] ?? null);
  const scope = JSON.stringify([creation?.client.baseUrl, creation?.state.directoryId, creation?.state.permissions.userId, creation?.state.permissions.principalKey, creation?.state.permissions.replicaId]);
  const options = relationPickerOptions(records, query, field.target === "matters" ? scope : undefined, creation?.state.records);
  const content =
    <div className="w-full" onKeyDownCapture={event => {
          if (!creating && event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.stopPropagation(); if (!event.repeat) { setOpen(false); onSubmit(); }
          }
        }} onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault(); setOpen(false); setQuery("");
          }
          event.stopPropagation();
        }}>
        {creating && target ? <LocalCreationScope.Provider value={source && { ...source, fields: [...source.fields, field.id] }}><BackOfficeTheme><RecordCreateForm object={displayBackOfficeObject(target)} name={query.trim()} persistenceNotice={t("back_office.create.persistence_notice")} onCancel={() => setCreating(false)} onCreated={async record => {
          setSelection(field.multiple ? [record.id, ...selected.filter(id => id !== record.id)] : [record.id]);
          setOpen(false); setCreating(false); setQuery("");
        }} /></BackOfficeTheme></LocalCreationScope.Provider> : <Command filter={null} value={query} onValueChange={(next, details) => { if (details.reason !== "item-press") setQuery(next); }}>
          <CommandInput aria-label={t("back_office.create.search", { name: field.label })} placeholder={t("back_office.create.search", { name: field.label })} />
          <CommandList className="max-h-56 overflow-y-auto">
            {options.map(({ record, subtitle }) => <CommandItem key={record.id} value={record.id} disabled={disabled} onClick={() => {
              setSelection(selected.includes(record.id) ? selected.filter(id => id !== record.id) : field.multiple ? [...selected, record.id] : [record.id]);
              if (!field.multiple) setOpen(false);
            }} className="gap-2 rounded-md px-2">
              <ObjectIcon id={record.objectId} size={14} /><span className="min-w-0 flex-1"><span className="block truncate">{String(record.values.name)}</span>{subtitle && <span className="block truncate text-xs text-muted-foreground" title={subtitle}>{subtitle}</span>}</span>
              {selected.includes(record.id) && <Check className="size-4 shrink-0" />}
            </CommandItem>)}
            {!options.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t("projects.matters.no_matches")}</p>}
            {target && <CommandItem value="create-related-record" disabled={disabled} onClick={() => setCreating(true)} className="gap-2 rounded-md border-t px-2"><Plus className="size-4" />{t("back_office.create.title", { name: displayBackOfficeObject(target).label })}</CommandItem>}
          </CommandList>
        </Command>}
      </div>;
  return <div className="bo-create-relation">
    {selected.map(id => <span className="inline-flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs" key={id}>
      <ObjectIcon id={field.target ?? ""} size={13} />
      <span className="truncate">{String(records.find(record => record.id === id)?.values.name ?? t("projects.reference.unavailable"))}</span>
      <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={`${t("common.remove")}: ${records.find(record => record.id === id)?.values.name ?? t("projects.reference.unavailable")}`} onClick={() => setSelection(selected.filter(item => item !== id))}><X /></Button>
    </span>)}
    <Popover open={open && !disabled} onOpenChange={next => { setOpen(next); if (!next) { setQuery(""); setCreating(false); } }}>
      <PopoverTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={t("projects.edit_value", { name: field.label })} />}>
        {t("back_office.create.choose", { name: field.label })}<ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-32px))] max-h-[min(540px,70vh)] overflow-y-auto p-2">{content}</PopoverContent>
    </Popover>
  </div>;
}
