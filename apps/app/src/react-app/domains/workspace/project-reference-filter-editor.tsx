import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Popover } from "twenty-ui/primitives/surfaces";
import type { BackOfficeField, BackOfficeObject, BackOfficeRecord } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters, projectReferenceFilterError, projectReferenceFilterFields, projectReferenceFiltersSchema, projectReferenceOperators, type ProjectReferenceCondition, type ProjectReferenceFilters } from "@legalwork/types/workspace";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale, t } from "@/i18n";
import { BackOfficeTheme, DirectoryEditorPopup } from "../back-office/twenty-controls";
import { CellEditor } from "../back-office/cell-editor";

function operatorLabel(operator: ProjectReferenceCondition["operator"], field?: BackOfficeField) {
  const multiple = field?.type === "multiselect" || field?.type === "relation" && field.multiple;
  return {
    is: t(multiple ? "projects.reference.includes_any" : "project_filters.is"),
    is_not: t(multiple ? "projects.reference.includes_none" : "project_filters.is_not"),
    contains: t("project_filters.contains"), not_contains: t("project_filters.not_contains"),
    gt: t(field?.type === "date" || field?.type === "datetime" ? "project_filters.after" : "project_filters.gt"),
    gte: t("project_filters.gte"), lt: t(field?.type === "date" || field?.type === "datetime" ? "project_filters.before" : "project_filters.lt"),
    lte: t("project_filters.lte"), empty: t("project_filters.empty"), not_empty: t("project_filters.not_empty"),
  }[operator];
}

export function ProjectReferenceFilterEditor({ object, records, value, onChange }: {
  object?: BackOfficeObject;
  records: BackOfficeRecord[];
  value?: ProjectReferenceFilters | null;
  onChange: (value: ProjectReferenceFilters) => void;
}) {
  const filters: ProjectReferenceFilters = value ?? { mode: "all", conditions: [] };
  const fields = object ? projectReferenceFilterFields(object) : [];
  const available = object ? records.filter(record => record.objectId === object.id && !record.archivedAt) : [];
  const complete = object && projectReferenceFiltersSchema.safeParse(filters).success && !projectReferenceFilterError(object, filters);
  const matching = complete ? available.filter(record => matchesProjectReferenceFilters(record, object, filters)).length : 0;
  const replace = (index: number, condition: ProjectReferenceCondition) => onChange({ ...filters, conditions: filters.conditions.map((previous, i) => i === index ? condition : previous) });
  return <div className="space-y-3 border-t border-border pt-3">
    <div className="flex items-center justify-between gap-2">
      <div className="space-y-1"><span className="text-xs font-medium">{t("projects.reference.filter_records")}</span>
        <p className="text-xs text-muted-foreground">{t(filters.conditions.length ? "projects.reference.rules_description" : "projects.reference.all_records")}</p></div>
      <Button type="button" variant="ghost" size="sm" className="shrink-0" disabled={!fields.length || filters.conditions.length >= 20} onClick={() => onChange({ ...filters, conditions: [...filters.conditions, { fieldId: "", operator: "is", values: [] }] })}><Plus className="size-3.5" />{t("projects.reference.add_rule")}</Button>
    </div>
    {filters.conditions.length > 0 && <>
      {filters.conditions.length > 1 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t("projects.reference.match_rules")}</span>
        <Select value={filters.mode} onValueChange={mode => { if (mode === "all" || mode === "any") onChange({ ...filters, mode }); }}>
          <SelectTrigger size="sm" className="rounded-md bg-transparent text-xs" aria-label={t("project_filters.combine")}><SelectValue>{t(filters.mode === "all" ? "projects.reference.all_rules" : "projects.reference.any_rule")}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">{t("projects.reference.all_rules")}</SelectItem><SelectItem value="any">{t("projects.reference.any_rule")}</SelectItem></SelectContent>
        </Select>
      </div>}
      {filters.conditions.map((condition, index) => <ConditionEditor key={`${index}:${condition.fieldId}:${condition.operator}`} fields={fields} condition={condition} records={records} onChange={condition => replace(index, condition)} onRemove={() => onChange({ ...filters, conditions: filters.conditions.filter((_, i) => i !== index) })} />)}
      <div className="space-y-1 border-t border-border pt-3 text-xs">
        <p role="status">{complete ? t("projects.reference.matching_count", { count: matching, total: available.length }) : t(object ? "projects.reference.complete_rule" : "projects.reference.unavailable_object")}</p>
        <p className="text-muted-foreground">{t("projects.reference.filters_hint")}</p>
      </div>
    </>}
  </div>;
}

function ConditionEditor({ fields, condition, records, onChange, onRemove }: {
  fields: BackOfficeField[];
  condition: ProjectReferenceCondition;
  records: BackOfficeRecord[];
  onChange: (value: ProjectReferenceCondition) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const field = fields.find(field => field.id === condition.fieldId);
  const operators = field ? projectReferenceOperators(field) : [];
  const noValue = condition.operator === "empty" || condition.operator === "not_empty";
  const labels = condition.values.map(value => field?.type === "relation"
    ? String(records.find(record => record.id === value && record.objectId === field.target)?.values.name ?? t("projects.reference.unavailable"))
    : typeof value === "boolean" ? t(value ? "projects.reference.filter_true" : "projects.reference.filter_false") : String(value));
  const label = new Intl.ListFormat(currentLocale(), { style: "long", type: "disjunction" }).format(labels);
  const choice = field && ["select", "multiselect", "relation"].includes(field.type);
  const editorField = field && { ...field, required: true, multiple: Boolean(choice) };
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,.85fr)_minmax(0,1.5fr)_auto]">
    <div className="col-start-1 flex min-w-0 flex-col gap-1.5 sm:col-start-auto"><span className="text-xs text-muted-foreground">{t("projects.reference.rule_field")}</span><Select value={condition.fieldId} onValueChange={fieldId => {
      const next = fields.find(field => field.id === fieldId);
      if (next) onChange({ fieldId: next.id, operator: "is", values: next.type === "boolean" ? [true] : [] });
    }}>
      <SelectTrigger size="sm" className="w-full rounded-md bg-transparent text-xs" aria-label={t("projects.reference.filter_field")}><SelectValue>{field?.label ?? t(condition.fieldId ? "projects.reference.unavailable" : "projects.reference.choose_filter_field")}</SelectValue></SelectTrigger>
      <SelectContent>{fields.map(field => <SelectItem key={field.id} value={field.id}>{field.label}</SelectItem>)}
        {condition.fieldId && !field && <SelectItem value={condition.fieldId} disabled>{t("projects.reference.unavailable")}</SelectItem>}
      </SelectContent>
    </Select></div>
    <div className="col-start-1 flex min-w-0 flex-col gap-1.5 sm:col-start-auto"><span className="text-xs text-muted-foreground">{t("projects.reference.rule_condition")}</span><Select value={condition.operator} disabled={!field} onValueChange={operator => {
      const next = operators.find(value => value === operator);
      if (next) onChange({ ...condition, operator: next, values: next === "empty" || next === "not_empty" ? [] : condition.values });
    }}>
      <SelectTrigger size="sm" className="w-full rounded-md bg-transparent text-xs" aria-label={t("projects.reference.filter_operator")}><SelectValue>{operatorLabel(condition.operator, field)}</SelectValue></SelectTrigger>
      <SelectContent>{operators.map(operator => <SelectItem key={operator} value={operator}>{operatorLabel(operator, field)}</SelectItem>)}</SelectContent>
    </Select></div>
    <div className="col-start-1 flex min-w-0 flex-col gap-1.5 sm:col-start-auto"><span className="text-xs text-muted-foreground">{t("projects.reference.rule_value")}</span>
    {editorField && !noValue ? <BackOfficeTheme>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<Button type="button" variant="outline" size="sm" className="h-8 w-full min-w-0 justify-between rounded-md bg-transparent font-normal" aria-label={t("projects.reference.filter_value")} title={label}><span className="truncate">{label || t("projects.reference.choose_filter_value")}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></Button>} />
        <Popover.Portal><Popover.Positioner align="start" sideOffset={4}><DirectoryEditorPopup className="bo-reference-filter-popup" style={{ width: editorField.type === "date" ? "max-content" : 260 }}>
          <CellEditor key={`${condition.fieldId}:${condition.operator}:${open}`} field={editorField} value={choice ? condition.values.filter((value): value is string => typeof value === "string") : condition.values[0] ?? null} records={records} onCancel={() => setOpen(false)} onSave={async value => {
            const values = Array.isArray(value) ? value.filter((value): value is string => typeof value === "string") : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [value] : [];
            onChange({ ...condition, values });
          }} />
        </DirectoryEditorPopup></Popover.Positioner></Popover.Portal>
      </Popover.Root>
    </BackOfficeTheme> : <span className="flex h-8 items-center text-xs text-muted-foreground">{t(noValue ? "projects.reference.no_value_needed" : "projects.reference.choose_field_first")}</span>}
    </div>
    <Button type="button" variant="ghost" size="icon-sm" className="col-start-2 row-start-1 text-muted-foreground sm:col-start-4" aria-label={t("projects.reference.remove_filter")} onClick={onRemove}><X className="size-3.5" /></Button>
  </div>;
}
