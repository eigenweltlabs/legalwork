import { useState } from "react";
import { CalendarDays, ChevronDown, Hash, ListFilter, Plus, Type } from "lucide-react";
import type { BackOfficeObject } from "@legalwork/types/back-office";
import type { ProjectField } from "@legalwork/types/workspace";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { ObjectIcon } from "../back-office/object-icon";
import { hasProjectFieldValue, primaryProjectObjects, projectConnectionField } from "./project-connections";
import { projectFieldLabel } from "./project-defaults-store";

export function ProjectMoreFields({ fields, objects, primaryIds, disabled, onChoose, onNew }: {
  fields: ProjectField[]; objects: BackOfficeObject[]; primaryIds: string[]; disabled?: boolean;
  onChoose: (field: ProjectField) => void; onNew: () => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const extraObjects = objects.filter(object => !primaryProjectObjects.includes(object.id));
  const extraIds = extraObjects.map(object => projectConnectionField(fields, object.id, object.plural).id);
  const available = fields.filter(field => !hasProjectFieldValue(field) && !primaryIds.includes(field.id) && !extraIds.includes(field.id)
    && (field.type !== "backoffice" || objects.some(object => object.id === field.objectId)));
  const icons = { text: Type, number: Hash, date: CalendarDays, select: ListFilter };
  const choose = (field: ProjectField) => { setOpen(false); onChoose(field); };
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(""); }}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>{t("projects.more_fields")}<ChevronDown className="size-3.5" /></PopoverTrigger>
    <PopoverContent align="start" className="w-[min(360px,calc(100vw-32px))] p-2" onKeyDown={event => event.stopPropagation()}>
      <Command filter={null} value={query} onValueChange={(value, details) => { if (details.reason !== "item-press") setQuery(value); }}>
        <CommandInput aria-label={t("projects.more_search")} placeholder={t("projects.more_search")} />
        <CommandList className="max-h-64 overflow-y-auto">
          {available.filter(field => matches(projectFieldLabel(field))).map(field => {
            const Icon = field.type === "backoffice" ? null : icons[field.type];
            return <CommandItem key={field.id} value={`field:${field.id}`} className="gap-2 rounded-md px-2" onClick={() => choose(field)}>
              {field.type === "backoffice" ? <ObjectIcon id={field.objectId} size={14} /> : Icon && <Icon className="size-3.5" />}{projectFieldLabel(field)}
            </CommandItem>;
          })}
          {extraObjects.filter(object => matches(object.plural)).map(object => <CommandItem key={object.id} value={`object:${object.id}`} className="gap-2 rounded-md px-2" disabled={fields.length >= 50 && !fields.some(field => field.id === projectConnectionField(fields, object.id, object.plural).id)} onClick={() => choose(projectConnectionField(fields, object.id, object.plural))}>
            <ObjectIcon id={object.id} size={14} />{object.plural}
          </CommandItem>)}
          <CommandItem value="new-project-field" className="gap-2 rounded-md border-t px-2" disabled={fields.length >= 50} onClick={() => { setOpen(false); onNew(); }}><Plus className="size-3.5" />{t("projects.new_field")}</CommandItem>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
