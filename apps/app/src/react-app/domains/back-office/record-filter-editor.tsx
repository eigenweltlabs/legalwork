import { useState } from "react";
import { Plus, X, ChevronDown } from "lucide-react";
import { Button, Input } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { backOfficeFilterError, backOfficeFilterFields, backOfficeFilterOperators, compileBackOfficeFilters, type BackOfficeField, type BackOfficeObject, type BackOfficeRecord, type BackOfficeFilterCondition, type BackOfficeFilterCriteria } from "@legalwork/types/back-office";
import { currentLocale, t } from "@/i18n";
import { DirectoryEditorPopup, DirectorySelect } from "./twenty-controls";
import { CellEditor } from "./cell-editor";

export function recordFilterOperatorLabel(operator: BackOfficeFilterCondition["operator"], field?: BackOfficeField) {
  const date = field?.type === "date" || field?.type === "datetime";
  return { is: t("project_filters.is"), is_not: t("project_filters.is_not"), contains: t("project_filters.contains"), not_contains: t("project_filters.not_contains"), gt: t(date ? "project_filters.after" : "project_filters.gt"), gte: t("project_filters.gte"), lt: t(date ? "project_filters.before" : "project_filters.lt"), lte: t("project_filters.lte"), empty: t("project_filters.empty"), not_empty: t("project_filters.not_empty") }[operator];
}
export function recordFilterValueLabel(condition: BackOfficeFilterCondition, object: BackOfficeObject, records: BackOfficeRecord[]) {
  const field = object.fields.find(field => field.id === condition.fieldId);
  return new Intl.ListFormat(currentLocale(), { type: "disjunction" }).format(condition.values.map(value => typeof value === "object"
    ? new Intl.NumberFormat(currentLocale(), { style: "currency", currency: value.currency }).format(value.amountMinor / 100)
    : typeof value === "boolean" ? t(value ? "projects.reference.filter_true" : "projects.reference.filter_false")
    : field?.type === "relation" ? String(records.find(record => record.id === value && record.objectId === field.target)?.values.name ?? t("projects.reference.unavailable")) : String(value)));
}

export function RecordFilterEditor({ object, records, rows, finance, value, onApply, onCancel }: {
  object: BackOfficeObject; records: BackOfficeRecord[]; rows: BackOfficeRecord[]; finance: boolean; value: BackOfficeFilterCriteria;
  onApply: (value: BackOfficeFilterCriteria) => void; onCancel: () => void;
}) {
  const fields = backOfficeFilterFields(object, finance);
  const [draft, setDraft] = useState<BackOfficeFilterCriteria>(() => value.conditions.length ? value : {
    mode: "all", conditions: [{ fieldId: "name", operator: "contains", values: [] }],
  });
  const [rowIds, setRowIds] = useState(() => draft.conditions.map(() => crypto.randomUUID()));
  const error = backOfficeFilterError(object, draft);
  const count = error ? null : rows.filter(compileBackOfficeFilters(object, draft)).length;
  return <form className="bo-record-filters" aria-label={t("back_office.filters.title")} onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!error) onApply(draft); }}>
    <div className="bo-filter-heading"><strong>{t("back_office.filters.title")}</strong><Button type="button" size="sm" variant="ghost" aria-label={t("projects.cancel")} startIcon={<X size={14} />} onClick={onCancel} /></div>
    <p className="bo-muted">{t("back_office.filters.hint")}</p>
    {draft.conditions.length > 1 && <div className="bo-filter-combine"><span>{t("projects.reference.match_rules")}</span><DirectorySelect label={t("project_filters.combine")} value={draft.mode} onChange={mode => { if (mode === "all" || mode === "any") setDraft({ ...draft, mode }); }} options={[{ value: "all", label: t("projects.reference.all_rules") }, { value: "any", label: t("projects.reference.any_rule") }]} /></div>}
    {draft.conditions.map((condition, index) => <FilterCondition key={rowIds[index]} condition={condition} fields={fields} object={object} records={records} onChange={next => setDraft({ ...draft, conditions: draft.conditions.map((previous, i) => i === index ? next : previous) })} onRemove={() => { setRowIds(current => current.filter((_, i) => i !== index)); setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) }); }} />)}
    <Button type="button" size="sm" variant="ghost" disabled={draft.conditions.length >= 20} startIcon={<Plus size={14} />} onClick={() => { setRowIds(current => [...current, crypto.randomUUID()]); setDraft({ ...draft, conditions: [...draft.conditions, { fieldId: "", operator: "is", values: [] }] }); }}>{t("project_filters.add")}</Button>
    <p role="status" className="bo-muted">{count === null ? t("back_office.filters.incomplete") : t("back_office.filters.matches", { count, total: rows.length })}</p>
    <div className="bo-filter-footer"><Button type="button" size="sm" variant="ghost" onClick={() => onApply({ mode: "all", conditions: [] })}>{t("back_office.filters.clear")}</Button><Button type="submit" size="sm" variant="solid" color="neutral" disabled={Boolean(error)}>{t("back_office.filters.apply")}</Button></div>
  </form>;
}

function FilterCondition({ condition, fields, object, records, onChange, onRemove }: {
  condition: BackOfficeFilterCondition; fields: BackOfficeField[]; object: BackOfficeObject; records: BackOfficeRecord[];
  onChange: (value: BackOfficeFilterCondition) => void; onRemove: () => void;
}) {
  const field = fields.find(field => field.id === condition.fieldId);
  return <div className="bo-record-filter-row">
    <label><span>{t("projects.reference.rule_field")}</span><DirectorySelect label={t("projects.reference.filter_field")} value={condition.fieldId} onChange={id => {
      const next = fields.find(field => field.id === id);
      if (next) onChange({ fieldId: id, operator: backOfficeFilterOperators(next)[0], values: next.type === "boolean" ? [true] : [] });
    }} options={[{ value: "", label: t("projects.reference.choose_filter_field") }, ...fields.map(field => ({ value: field.id, label: field.label })), ...(condition.fieldId && !field ? [{ value: condition.fieldId, label: t("projects.reference.unavailable_object") }] : [])]} /></label>
    <label><span>{t("projects.reference.rule_condition")}</span><DirectorySelect label={t("projects.reference.filter_operator")} disabled={!field} value={condition.operator} onChange={operator => {
      const next = field && backOfficeFilterOperators(field).find(item => item === operator);
      if (next) onChange({ ...condition, operator: next, values: next === "empty" || next === "not_empty" ? [] : condition.values });
    }} options={(field ? backOfficeFilterOperators(field) : [condition.operator]).map(operator => ({ value: operator, label: recordFilterOperatorLabel(operator, field) }))} /></label>
    <div className="bo-record-filter-value"><span>{t("projects.reference.rule_value")}</span>{field ? condition.operator === "empty" || condition.operator === "not_empty" ? <span className="bo-muted">{t("projects.reference.no_value_needed")}</span> : <FilterValue key={`${field.id}:${condition.operator}`} field={field} condition={condition} object={object} records={records} onChange={values => onChange({ ...condition, values })} /> : <span className="bo-muted">{t("projects.reference.choose_field_first")}</span>}</div>
    <Button type="button" size="sm" variant="ghost" aria-label={t("projects.reference.remove_filter")} startIcon={<X size={14} />} onClick={onRemove} />
  </div>;
}

function localDatetime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : "";
}
function FilterValue({ field, condition, object, records, onChange }: {
  field: BackOfficeField; condition: BackOfficeFilterCondition; object: BackOfficeObject; records: BackOfficeRecord[];
  onChange: (values: BackOfficeFilterCondition["values"]) => void;
}) {
  const first = condition.values[0];
  const [text, setText] = useState(typeof first === "object" ? String(first.amountMinor / 100) : first === undefined ? "" : field.type === "datetime" && typeof first === "string" ? localDatetime(first) : String(first));
  const [currency, setCurrency] = useState(typeof first === "object" ? first.currency : "EUR");
  const [open, setOpen] = useState(false);
  if (field.type === "boolean") return <DirectorySelect label={t("projects.reference.filter_value")} value={first === undefined ? "" : String(first)} onChange={value => onChange(value ? [value === "true"] : [])} options={[{ value: "", label: t("projects.reference.choose_filter_value") }, { value: "true", label: t("projects.reference.filter_true") }, { value: "false", label: t("projects.reference.filter_false") }]} />;
  if (["select", "multiselect", "relation"].includes(field.type)) return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button type="button" size="sm" variant="outline" className="bo-filter-value-trigger" aria-label={t("projects.reference.filter_value")} endIcon={<ChevronDown size={12} />}><span>{recordFilterValueLabel(condition, object, records) || t("projects.reference.choose_filter_value")}</span></Button>} />
    <Popover.Portal><Popover.Positioner align="start" sideOffset={4}><DirectoryEditorPopup><CellEditor field={{ ...field, multiple: true, required: true }} value={condition.values.filter((value): value is string => typeof value === "string")} records={records} onCancel={() => setOpen(false)} onSave={async value => onChange(Array.isArray(value) ? value.filter((value): value is string => typeof value === "string") : [])} /></DirectoryEditorPopup></Popover.Positioner></Popover.Portal>
  </Popover.Root>;
  const update = (next: string, code = currency) => {
    setText(next);
    if (!next.trim()) { onChange([]); return; }
    if (field.type === "number" || field.type === "currency") {
      const number = Number(next);
      onChange(!Number.isFinite(number) || field.type === "currency" && !/^[A-Z]{3}$/.test(code) ? [] : field.type === "currency" ? [{ amountMinor: Math.round(number * 100), currency: code }] : [number]);
    } else if (field.type === "datetime") {
      const date = new Date(next); onChange(Number.isFinite(date.getTime()) ? [date.toISOString()] : []);
    } else onChange([next]);
  };
  return <div className="bo-filter-inputs"><Input size="sm" aria-label={t("projects.reference.filter_value")} placeholder={t(field.type === "file" ? "back_office.filters.filename" : "back_office.filters.enter_value")} type={field.type === "number" || field.type === "currency" ? "number" : field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text"} step="any" value={text} onChange={event => update(event.target.value)} />
    {field.type === "currency" && <Input size="sm" className="bo-filter-currency" aria-label={t("back_office.filters.currency")} value={currency} maxLength={3} onChange={event => { const code = event.target.value.toUpperCase(); setCurrency(code); update(text, code); }} />}
  </div>;
}
