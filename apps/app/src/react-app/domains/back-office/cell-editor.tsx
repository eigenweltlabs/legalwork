import { isInternalBackOfficeObject } from "@legalwork/types/back-office";
import { allRecordsTarget, nativeKind } from "./native-model";
import { NativeDateEditor } from "./native-date-editor";
import { cellInputText, parseCellInput } from "./cell-input";
import { FileCellEditor } from "./record-files";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { Plus, X } from "lucide-react";
import { DatePicker } from "twenty-ui/components/input";
import { Button, Input } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import { Avatar } from "twenty-ui/primitives/data-display";
import type {
  BackOfficeField,
  BackOfficeRecord,
  BackOfficeValue,
} from "@legalwork/types/back-office";
import { DirectorySelect } from "./twenty-controls";
import { LocalCreationScope, useRecordCreation } from "./record-creation-context";
import { creatableRecordObject, relationPickerOptions } from "./record-creation-values";
import { RecordCreateForm } from "./record-create-form";
import { displayBackOfficeObject } from "./labels";
import type { ProjectReferenceFilters } from "@legalwork/types/workspace";
import { t } from "@/i18n";

function focusEditorInput(input: HTMLInputElement | null) {
  input?.focus({ preventScroll: true });
}

export function CellEditor({
  field,
  record,
  value,
  records,
  onSave,
  onCancel,
  creationFilters,
  projectScope,
}: {
  field: BackOfficeField;
  record?: BackOfficeRecord;
  value: BackOfficeValue | undefined;
  records: BackOfficeRecord[];
  onSave: (value: BackOfficeValue, previousSelection?: string[]) => Promise<void>;
  onCancel: () => void;
  creationFilters?: ProjectReferenceFilters | null;
  projectScope?: string;
}) {
  const creation = useRecordCreation();
  const [targetType,setTargetType] = useState("");
  const polymorphic = field.target === allRecordsTarget;
  const targetId = polymorphic ? targetType : field.target;
  const target = field.type === "relation" ? creatableRecordObject(creation?.state, targetId) : undefined;
  const [creating, setCreating] = useState(false), [created, setCreated] = useState<{ record: BackOfficeRecord; replica?: string }[]>([]);
  const [text, setText] = useState(() => cellInputText(value));
  const [month, setMonth] = useState(
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : new Date().toISOString().slice(0, 10)
    ).slice(0, 7),
  );
  const [query, setQuery] = useState("");
  const selectedValues = Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" && value ? [value] : [];
  const [pending, setPending] = useState<{ id: string; add: boolean }[]>([]);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = pending.reduce((ids, edit) => edit.add ? [...new Set([...ids, edit.id])] : ids.filter(id => id !== edit.id), selectedValues);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (next: BackOfficeValue, newlyCreated = false, previous?: string[]) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next, previous);
      onCancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save.";
      setError(`${newlyCreated || created.length ? t("back_office.create.not_linked") + " " : ""}${message}`);
    } finally {
      setSaving(false);
    }
  };
  const search = query.trim().toLocaleLowerCase();
  const matchesName = (name: string) => name.toLocaleLowerCase().includes(search);
  let options: { id: string; label: string; subtitle?: string }[];
  if (field.type === "relation") {
    const available = [...new Map([...created.filter(item => item.replica === creation?.state.permissions.replicaId).map(item => item.record), ...records].map(item => [item.id, item])).values()]
      .filter(item => (polymorphic ? !item.objectId.startsWith("@") && !isInternalBackOfficeObject(item.objectId) && (!targetType || item.objectId === targetType) : item.objectId === field.target) && !item.archivedAt);
    options = relationPickerOptions(available, query, field.target === "matters" ? projectScope : undefined, creation?.state.records)
      .map(({ record, subtitle }) => ({ id: record.id, label: String(record.values.name ?? ""), subtitle:polymorphic ? creation?.state.model.objects.find(o=>o.id===record.objectId)?.label : subtitle }))
      .sort((a, b) => {
        const left = selected.indexOf(a.id), right = selected.indexOf(b.id);
        return (left < 0 ? selected.length : left) - (right < 0 ? selected.length : right);
      });
  } else {
    options = field.options.filter(matchesName).map(option => ({ id: option, label: option }));
  }
  const multiple = field.multiple || field.type === "multiselect";
  const isChoices =
    field.type === "relation" ||
    field.type === "select" ||
    (field.type === "multiselect" && field.options.length > 0);
  const choose = (id: string) => {
    if (!multiple) { void save(id); return; }
    const edit = { id, add: !selected.includes(id) };
    const next = edit.add ? [...selected, id] : selected.filter(item => item !== id);
    setPending(items => [...items, edit]);
    setError("");
    queue.current = queue.current.then(async () => {
      try { await onSave(next, selected); }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : t("back_office.create.failed");
        if (mounted.current) setError(message);
        else toast.error(message);
      }
      finally { setPending(items => items.filter(item => item !== edit)); }
    });

  };
  const localSource = record && creation?.state.localRows?.some(row => row.id === record.id) ? { id: record.id, objectId: record.objectId, fields: [field.id] } : undefined;
  if (creating && target) return <LocalCreationScope.Provider value={localSource}><RecordCreateForm object={displayBackOfficeObject(target)} name={query.trim()} filters={creationFilters} persistenceNotice={projectScope ? t("back_office.create.persistence_notice") : undefined} onCancel={() => setCreating(false)} onCreated={async record => {
    setCreated(current => [{ record, replica: creation?.state.permissions.replicaId }, ...current]);
    setQuery(""); setCreating(false);
    const next = multiple ? [record.id, ...selected.filter(id => id !== record.id)] : [record.id];
    await queue.current;
    await save(multiple ? next : record.id, true, multiple ? selected : undefined);
  }} /></LocalCreationScope.Provider>;
  if (record && nativeKind(record.objectId) && field.id === "due") return <NativeDateEditor value={typeof value === "string"?value:""} required={field.required} onSave={onSave} onCancel={onCancel}/>;
  if (field.type === "file")
    return (
      <FileCellEditor
        record={record}
        field={field}
        value={value}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  return (
    <div
      className="bo-cell-form"
      aria-label={`Edit ${field.label}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (projectScope && multiple && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!event.repeat) onCancel();
        }
        if (projectScope && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"], .bo-create-option')];
          const index = choices.indexOf(event.target as HTMLButtonElement);
          if (choices.length) {
            event.preventDefault();
            const next = event.key === "ArrowDown" ? index + 1 : (index < 0 ? -1 : index - 1);
            choices.at(next % choices.length)?.focus();
          }
        }
        event.stopPropagation();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isChoices) {
            if (!multiple) void save(selected[0] ?? null);
            return;
          }
          try {
            void save(parseCellInput(field.type, text, value));
          } catch (error) {
            setError(error instanceof Error ? error.message : "Invalid value.");
          }
        }}
      >
        {field.type === "date" ? (
          <DatePicker
            value={text || null}
            onValueChange={setText}
            onValueSelect={(date) => void save(date)}
            viewedMonth={month}
            onViewedMonthChange={setMonth}
            weekStart={1}
            locale={navigator.language}
            previousMonthLabel="Previous month"
            nextMonthLabel="Next month"
            monthLabel="Month"
            yearLabel="Year"
          />
        ) : isChoices ? (
          <>
            {polymorphic && creation && <DirectorySelect label={t("native.all_models")} value={targetType} onChange={setTargetType} options={[{value:"",label:t("native.all_models")},...creation.state.model.objects.filter(o => creatableRecordObject(creation.state,o.id)).map(o => ({value:o.id,label:displayBackOfficeObject(o).plural}))]}/>}
            <div className="bo-choice-search">
              <Input
                ref={focusEditorInput}
                size="sm"
                variant="plain"
                aria-label={projectScope ? t("back_office.create.search", { name: field.label }) : `Search ${field.label}`}
                placeholder="Search…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (event.repeat || saving) return;
                  if (options.length) choose(options[0].id);
                  else if (target) setCreating(true);
                }}
              />
            </div>
            <div className="bo-choices">
              {!field.required && !query && (
                <ListItem
                  render={<button type="button" disabled={saving} />}
                  selected={!selected.length}
                  indicator="check"
                  onClick={async () => { await queue.current; await save(multiple ? [] : null, false, multiple ? selected : undefined); }}
                >
                  No {field.label}
                </ListItem>
              )}

              {options.map((option) => (
                  <ListItem
                    key={option.id}
                    render={<button type="button" disabled={saving} />}
                    role="option"
                    selected={selected.includes(option.id)}
                    indicator="check"
                    aria-selected={selected.includes(option.id)}
                    startIcon={
                      field.type === "relation" ? (
                        <Avatar
                          size="xs"
                          name={option.label}
                          colorSeed={option.id}
                        />
                      ) : undefined
                    }
                    onClick={() => choose(option.id)}
                  >
                    {option.subtitle ? <span className="block min-w-0">
                      <span className="block truncate">{option.label}</span>
                      <small className="bo-muted block truncate" title={option.subtitle}>{option.subtitle}</small>
                    </span> : option.label}
                  </ListItem>
                ))}
              {!options.length && (
                <p className="bo-muted">
                  {t("back_office.create.empty")}
                </p>
              )}
            </div>
            {target && <ListItem className="bo-create-option" render={<button type="button" disabled={saving} />} startIcon={<Plus size={14} />} onClick={() => setCreating(true)}>{t("back_office.create.title", { name: displayBackOfficeObject(target).label })}</ListItem>}

          </>
        ) : (
          <>
            {field.type === "boolean" ? (
              <DirectorySelect
                label={field.label}
                value={text}
                onChange={setText}
                options={[
                  { value: "", label: "Empty" },
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]}
              />
            ) : (
              <Input
                ref={focusEditorInput}
                size="sm"
                aria-label={field.label}
                value={text}
                onChange={(event) => setText(event.target.value)}
                type={
                  field.type === "datetime"
                    ? "datetime-local"
                    : field.type === "number" || field.type === "currency"
                      ? "number"
                      : "text"
                }
                step="any"
              />
            )}
            <Button
              type="submit"
              size="sm"
              variant="solid"
              color="neutral"
              disabled={saving}
              fullWidth
            >
              Save
            </Button>
          </>
        )}
        {error && (
          <p className="bo-error" role="alert">
            {error}
          </p>
        )}
        {!isChoices && (
          <div className="bo-editor-footer">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Clear value
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Close editor"
              onClick={onCancel}
              startIcon={<X size={14} />}
            />
          </div>
        )}
      </form>
    </div>
  );
}
