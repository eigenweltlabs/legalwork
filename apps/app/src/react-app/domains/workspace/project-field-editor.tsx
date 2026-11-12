import { useId, useState, type ReactNode } from "react";
import type { ProjectField } from "@legalwork/types/workspace";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { BackOfficeState } from "../back-office/api";
import { ObjectIcon } from "../back-office/object-icon";
import { projectReferenceObjects } from "./project-record-field";
import { projectFieldLabel } from "./project-defaults-store";
import { changeProjectFieldType, parseProjectOptions } from "./project-field-editing";
import { ProjectReferenceFilterEditor } from "./project-reference-filter-editor";

export function ProjectFieldEditor({ field, state, disabled = false, autoFocus, action, onChange }: {
  field: ProjectField; state?: BackOfficeState; disabled?: boolean;
  autoFocus?: boolean; action?: ReactNode; onChange: (field: ProjectField) => void;
}) {
  const id = useId(), objects = projectReferenceObjects(state);
  const object = field.type === "backoffice" ? objects.find(item => item.id === field.objectId) : undefined;
  const [optionDraft, setOptionDraft] = useState<string | null>(null);
  const types = { text: t("projects.type_text"), number: t("projects.type_number"), date: t("projects.type_date"), select: t("projects.type_select") };
  const label = projectFieldLabel(field);
  return <div className="space-y-4">
    <div className="flex items-start gap-2">
      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground" htmlFor={`${id}-name`}>
          {t("projects.field_name")}
          <Input id={`${id}-name`} autoFocus={autoFocus} aria-label={t("projects.field_name")} placeholder={t("projects.field_name_example")}
            maxLength={100} required disabled={disabled} value={label} onChange={event => onChange({ ...field, label: event.target.value, labelSource: "custom" })} />
        </label>
        <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
          <label htmlFor={`${id}-type`}>{t("projects.field_type")}</label>
          <Select value={field.type === "backoffice" ? `backoffice:${field.objectId}` : field.type} disabled={disabled} onValueChange={value => {
            const target = objects.find(item => `backoffice:${item.id}` === value);
            const type = target ? "backoffice" : value === "text" || value === "number" || value === "date" || value === "select" ? value : null;
            if (!type) return;
            const next = changeProjectFieldType(field, type, target?.id);
            if (!next) return;
            if (field.value !== null && field.value !== "" && next.value === null) toast.info(t("projects.value_overwrite_notice", { name: label }));
            setOptionDraft(null); onChange(next);
          }}>
            <SelectTrigger id={`${id}-type`} aria-label={t("projects.field_type")} className="w-full"><SelectValue className="min-w-0 truncate">
              {field.type === "backoffice" ? object?.plural ?? t("projects.reference.unavailable_object") : types[field.type]}
            </SelectValue></SelectTrigger>
            <SelectContent>
              {Object.entries(types).map(([type, name]) => <SelectItem key={type} value={type}>{name}</SelectItem>)}
              {objects.map(item => <SelectItem key={item.id} value={`backoffice:${item.id}`}><ObjectIcon id={item.id} size={14} />{item.plural}</SelectItem>)}
              {field.type === "backoffice" && !object && <SelectItem value={`backoffice:${field.objectId}`} disabled>{t("projects.reference.unavailable_object")}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>
      {action && <div className="pt-5">{action}</div>}
    </div>
    {field.type === "select" && <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      {t("projects.options")}
      <Input aria-label={t("projects.options")} placeholder={t("projects.options")} disabled={disabled}
        value={optionDraft ?? field.options?.join(", ") ?? ""} onChange={event => { setOptionDraft(event.target.value); onChange({ ...field, options: parseProjectOptions(event.target.value) }); }} />
    </label>}
    {field.type === "backoffice" && <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">{t("projects.field_selection_settings")}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{t("projects.reference.label_hint", { source: object?.plural ?? field.objectId })}</p>
        <label className="flex items-center gap-2 text-xs"><Checkbox disabled={disabled} checked={field.quickAction === true}
          onCheckedChange={checked => onChange({ ...field, quickAction: checked === true })} />{t("projects.field_quick_action")}</label>
        <label className="flex items-center gap-2 text-xs"><Checkbox disabled={disabled} checked={field.multiple} onCheckedChange={checked => {
          const clear = !checked && (field.value?.recordIds.length ?? 0) > 1;
          if (clear) toast.info(t("projects.value_overwrite_notice", { name: label }));
          onChange({ ...field, multiple: checked === true, value: clear ? null : field.value });
        }} />{t("projects.reference.multiple")}</label>
        <ProjectReferenceFilterEditor object={object} records={state?.records ?? []} value={field.filters} onChange={filters => onChange({ ...field, filters })} />
      </div>
    </details>}
  </div>;
}
