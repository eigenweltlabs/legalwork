import { FileCellEditor } from "./record-files";
import { useState } from "react";
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
import { useRecordCreation } from "./record-creation-context";
import { creatableRecordObject } from "./record-creation-values";
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
}: {
  field: BackOfficeField;
  record?: BackOfficeRecord;
  value: BackOfficeValue | undefined;
  records: BackOfficeRecord[];
  onSave: (value: BackOfficeValue) => Promise<void>;
  onCancel: () => void;
  creationFilters?: ProjectReferenceFilters | null;
}) {
  const creation = useRecordCreation();
  const target = field.type === "relation" ? creatableRecordObject(creation?.state, field.target) : undefined;
  const [creating, setCreating] = useState(false), [created, setCreated] = useState<BackOfficeRecord[]>([]);
  const initial =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? String(value.amountMinor / 100)
      : Array.isArray(value)
        ? value.join(", ")
        : String(value ?? "");
  const [text, setText] = useState(initial);
  const [month, setMonth] = useState(
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : new Date().toISOString().slice(0, 10)
    ).slice(0, 7),
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(
    Array.isArray(value)
      ? value.filter((item) => typeof item === "string")
      : typeof value === "string" && value
        ? [value]
        : [],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (next: BackOfficeValue, newlyCreated = false) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next);
      onCancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save.";
      setError(`${newlyCreated || created.length ? t("back_office.create.not_linked") + " " : ""}${message}`);
    } finally {
      setSaving(false);
    }
  };
  const options =
    field.type === "relation"
      ? [...new Map([...created, ...records].map(record => [record.id, record])).values()]
          .filter(
            (record) => record.objectId === field.target && !record.archivedAt,
          )
          .sort((a, b) => {
            const left = selected.indexOf(a.id), right = selected.indexOf(b.id);
            return (left < 0 ? selected.length : left) - (right < 0 ? selected.length : right);
          })
          .map((record) => ({
            id: record.id,
            label: String(record.values.name ?? ""),
          }))
      : field.options.map((option) => ({ id: option, label: option }));
  const multiple = field.multiple || field.type === "multiselect";
  const isChoices =
    field.type === "relation" ||
    field.type === "select" ||
    (field.type === "multiselect" && field.options.length > 0);
  if (creating && target) return <RecordCreateForm object={displayBackOfficeObject(target)} name={query.trim()} filters={creationFilters} onCancel={() => setCreating(false)} onCreated={async record => {
    setCreated(current => [record, ...current]);
    setQuery(""); setCreating(false);
    if (multiple) setSelected(current => [record.id, ...current.filter(id => id !== record.id)]);
    else { setSelected([record.id]); await save(record.id, true); }
  }} />;
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
        event.stopPropagation();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isChoices) {
            void save(multiple ? selected : (selected[0] ?? null));
            return;
          }
          if (field.type === "number" || field.type === "currency") {
            const numeric = Number(text);
            if (!Number.isFinite(numeric)) {
              setError("Enter a number.");
              return;
            }
            void save(
              text === ""
                ? null
                : field.type === "currency"
                  ? {
                      amountMinor: Math.round(numeric * 100),
                      currency:
                        typeof value === "object" &&
                        value !== null &&
                        !Array.isArray(value)
                          ? value.currency
                          : "EUR",
                    }
                  : numeric,
            );
            return;
          }
          void save(
            text === ""
              ? null
              : field.type === "boolean"
                ? text === "true"
                : field.type === "multiselect"
                  ? text
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean)
                  : text,
          );
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
            <div className="bo-choice-search">
              <Input
                ref={focusEditorInput}
                size="sm"
                variant="plain"
                aria-label={`Search ${field.label}`}
                placeholder="Search…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="bo-choices">
              {!field.required && !query && (
                <ListItem
                  render={<button type="button" disabled={saving} />}
                  selected={!selected.length}
                  indicator="check"
                  onClick={() => void save(null)}
                >
                  No {field.label}
                </ListItem>
              )}

              {options
                .filter(
                  (option) =>
                    !query ||
                    option.label
                      .toLocaleLowerCase()
                      .includes(query.toLocaleLowerCase()),
                )
                .map((option) => (
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
                    onClick={() => {
                      if (multiple)
                        setSelected((current) =>
                          current.includes(option.id)
                            ? current.filter((id) => id !== option.id)
                            : [...current, option.id],
                        );
                      else void save(option.id);
                    }}
                  >
                    {option.label}
                  </ListItem>
                ))}
              {!options.length && (
                <p className="bo-muted">
                  {t("back_office.create.empty")}
                </p>
              )}
            </div>
            {target && <ListItem className="bo-create-option" render={<button type="button" disabled={saving} />} startIcon={<Plus size={14} />} onClick={() => setCreating(true)}>{t("back_office.create.title", { name: displayBackOfficeObject(target).label })}</ListItem>}
            {multiple && (
              <Button
                type="submit"
                size="sm"
                variant="solid"
                color="neutral"
                fullWidth
                disabled={saving}
              >
                Apply
              </Button>
            )}
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
