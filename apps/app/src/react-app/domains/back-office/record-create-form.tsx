import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Plus } from "lucide-react";
import { Button, Input } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { z, BackOfficeRecordSchema, validateBackOfficeValues, type BackOfficeObject, type BackOfficeRecord, type BackOfficeValue } from "@legalwork/types/back-office";
import type { ProjectReferenceFilters } from "@legalwork/types/workspace";
import { useQuery } from "@tanstack/react-query";
import { t } from "@/i18n";
import { isMacPlatform } from "@/app/utils";
import { CellEditor } from "./cell-editor";
import { FieldIcon } from "./record-values";
import { ObjectIcon } from "./object-icon";
import { RecordFilesProvider } from "./record-files";
import { DirectoryEditorPopup } from "./twenty-controls";
import { quickCreateFieldIds, recordCreationValues } from "./record-creation-values";
import { useRecordCreation } from "./record-creation-context";
import { RecordCreateRelation } from "./record-create-relation";

function focusName(input: HTMLInputElement | null) { input?.focus({ preventScroll: true }); }

function displayValue(value: BackOfficeValue | undefined): string {
  if (value === undefined || value === null || value === "") return t("projects.empty_value");
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : item.name).join(", ");
  if (typeof value === "object") return `${value.amountMinor / 100} ${value.currency}`;
  if (typeof value === "boolean") return t(value ? "projects.reference.filter_true" : "projects.reference.filter_false");
  return String(value);
}

export function RecordCreateForm({ object, name, filters, persistenceNotice, initialValues, standalone = false, onCancel, onCreated }: {
  object: BackOfficeObject; name: string; filters?: ProjectReferenceFilters | null;
  persistenceNotice?: string;
  initialValues?: Record<string, BackOfficeValue>;
  standalone?: boolean;
  onCancel: () => void; onCreated: (record: BackOfficeRecord) => Promise<void>;
}) {
  const creation = useRecordCreation();
  const [draft, setDraft] = useState(() => {
    const now = new Date().toISOString();
    return BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: object.id, values: { ...recordCreationValues(object, name, filters), ...initialValues }, revision: 0, schemaRevision: creation?.state.model.revision ?? 0,
      ownerId: creation?.state.permissions.userId ?? "local", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const [edit, setEdit] = useState<string | null>(null), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true);
  const saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const projects = useQuery({ queryKey: ["back-office-projects", creation?.client.baseUrl], enabled: Boolean(creation), queryFn: async () => {
    if (!creation) throw new Error(t("back_office.create.unavailable"));
    return z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await creation.client.backOffice("/projects"));
  } });
  const values = (next: Record<string, BackOfficeValue>) => { setDraft(current => ({ ...current, values: { ...current.values, ...next } })); setError(""); };
  const save = async () => {
    if (!creation || saving.current) return;
    setError("");
    try {
      validateBackOfficeValues(object, draft.values);
      saving.current = true;
      setBusy(true);
      const record = await creation.create(draft, filters);
      if (mounted.current) await onCreated(record);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t("back_office.create.failed")); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  if (!creation) return null;
  const quickFields = quickCreateFieldIds(object);
  const createLabel = t(standalone ? "back_office.create.save" : "back_office.create.select");
  const fields = object.fields.filter(field => field.id !== "name" && (field.visibility !== "finance" || creation.state.permissions.finance));
  const rank = (id: string) => quickFields.includes(id) ? quickFields.indexOf(id) : quickFields.length;
  fields.sort((a, b) => rank(a.id) - rank(b.id));
  const primary = (field: typeof fields[number]) => field.required || quickFields.includes(field.id) || filters?.conditions.some(condition => condition.fieldId === field.id)
    || initialValues?.[field.id] !== undefined;
  const visible = fields.filter(field => more || primary(field));
  return <RecordFilesProvider client={creation.client} records={[...creation.state.records, draft]} projects={projects.data?.projects ?? []}>
    <div className="bo-create-record bo-cell-form" role="form" aria-label={t("back_office.create.title", { name: object.label })} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); if (!busy) onCancel(); }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (!event.repeat) void save(); }
    }}>
      <div className="bo-create-heading"><Button type="button" variant="ghost" size="sm" aria-label={t("back_office.create.back")} disabled={busy} onClick={onCancel} startIcon={<ArrowLeft size={14} />} /><ObjectIcon id={object.id} /><strong>{t("back_office.create.title", { name: object.label })}</strong></div>
      <label className="bo-create-name"><span>{object.fields.find(field => field.id === "name")?.label} *</span><Input size="sm" ref={focusName} value={String(draft.values.name ?? "")} aria-label={t("back_office.create.name", { name: object.label })} disabled={busy} onChange={event => values({ name: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
      {filters?.conditions.length ? <p className="bo-muted">{t("back_office.create.filters")}</p> : null}
      <div className="bo-create-fields">{visible.map(field => {
        const criteria = filters?.mode === "all" ? filters.conditions.filter(condition => condition.fieldId === field.id && ["is", "is_not"].includes(condition.operator)) : [];
        const editorField = ["select", "multiselect"].includes(field.type) && criteria.length ? { ...field, options: field.options.filter(option => criteria.every(condition => condition.operator === "is" ? condition.values.includes(option) : !condition.values.includes(option))) } : field;
        const direct = field.type === "text" || field.type === "email" || field.type === "relation";
        return <div className={`bo-create-field${direct ? " bo-create-field-direct" : ""}`} key={field.id}>
        <span><FieldIcon field={field} />{field.label}{field.required ? " *" : ""}</span>
        {field.type === "relation" ? <RecordCreateRelation field={field} value={draft.values[field.id]} disabled={busy} onChange={value => values({ [field.id]: value })} onSubmit={() => void save()} />
          : field.type === "text" || field.type === "email" ? <Input size="sm" aria-label={field.label} value={String(draft.values[field.id] ?? "")} disabled={busy} onChange={event => values({ [field.id]: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) event.preventDefault(); }} />
          : <Popover.Root open={edit === field.id} onOpenChange={open => setEdit(open ? field.id : null)}>
          <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={t("projects.edit_value", { name: field.label })} endIcon={<ChevronDown size={12} />} />}>
            <span className="bo-create-value">{displayValue(draft.values[field.id])}</span>
          </Popover.Trigger>
          <Popover.Portal><Popover.Positioner align="start" sideOffset={4}><DirectoryEditorPopup style={{ width: field.type === "date" ? "max-content" : 260 }}>
            <CellEditor key={draft.id + field.id} record={draft} field={editorField} records={creation.state.records} value={draft.values[field.id]} onCancel={() => setEdit(null)} onSave={async value => values({ [field.id]: value })} />
          </DirectoryEditorPopup></Popover.Positioner></Popover.Portal>
        </Popover.Root>}
      </div>; })}</div>
      {fields.some(field => !primary(field)) && <Button type="button" size="sm" variant="ghost" disabled={busy} aria-expanded={more} onClick={() => setMore(!more)}>{t("back_office.create.more_details")}<ChevronDown size={13} style={{ transform: more ? "rotate(180deg)" : undefined }} /></Button>}
      {persistenceNotice && <p className="bo-muted">{persistenceNotice}</p>}
      {error && <p className="bo-error" role="alert">{error}</p>}
      <div className="bo-create-actions"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t("projects.cancel")}</Button><Button type="button" size="sm" variant="solid" color="neutral" disabled={busy || !String(draft.values.name ?? "").trim()} startIcon={<Plus size={14} />} aria-label={createLabel} aria-keyshortcuts={isMacPlatform() ? "Meta+Enter" : "Control+Enter"} onClick={() => void save()}>{busy ? t("projects.saving") : createLabel}</Button></div>
    </div>
  </RecordFilesProvider>;
}
