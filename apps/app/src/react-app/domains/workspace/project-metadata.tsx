import { useState } from "react";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";
import { toast } from "sonner";
import { defaultAkteFields, useProjectDefaultsStore } from "./project-defaults-store";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { changeProjectFieldType, parseProjectOptions } from "./project-field-editing";

export function ProjectMetadata(props: {
  details: Pick<ProjectDetails, "fields">;
  definitionsOnly?: boolean;
  onSave: (fields: ProjectField[]) => Promise<void>;
  onCancel: () => void;
  onReload?: () => Promise<Pick<ProjectDetails, "fields">>;
}) {
  const savedDefaults = useProjectDefaultsStore((state) => state.fields);
  const saveFieldToDefaults = useProjectDefaultsStore((state) => state.addField);
  const defaults = savedDefaults ?? defaultAkteFields();
  const typeLabels = {
    text: t("projects.type_text"),
    number: t("projects.type_number"),
    date: t("projects.type_date"),
    select: t("projects.type_select"),
  };
  const [fields, setFields] = useState(props.details.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const change = (id: string, patch: Partial<ProjectField>) =>
    setFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...patch } : field,
      ),
    );
  const save = async () => {
    if (busy || conflict) return;
    if (fields.some((field) => field.type === "select" && field.value !== null && field.value !== "" && !field.options?.includes(String(field.value)))) {
      setError(t("projects.options_value_missing"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSave(fields);
    } catch (error) {
      setConflict(error instanceof LegalworkServerError && error.code === "project_changed");
      setError(projectErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {fields.map((field) => (
          <div
            key={field.id}
            className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_130px_auto]"
          >
            <Input
              aria-label={t("projects.field_name")}
              placeholder={t("projects.field_name")}
              required
              maxLength={100}
              value={field.label}
              onChange={(event) =>
                change(field.id, { label: event.target.value })
              }
            />
            <Select
              value={field.type}
              onValueChange={(value) => {
                if (
                  value === "text" ||
                  value === "number" ||
                  value === "date" ||
                  value === "select"
                ) {
                  const next = changeProjectFieldType(field, value);
                  if (!next) { setError(t("projects.type_preserve_value")); return; }
                  change(field.id, next);
                  setOptionDrafts((current) => ({ ...current, [field.id]: next.options?.join(", ") ?? "" }));
                  setError(null);
                }
              }}
            >
              <SelectTrigger
                aria-label={t("projects.field_type")}
                className="w-full"
              >
                <SelectValue>{typeLabels[field.type]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    "text",
                    "number",
                    "date",
                    "select",
                  ] satisfies ProjectField["type"][]
                ).map((type) => (
                  <SelectItem key={type} value={type}>
                    {typeLabels[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("projects.remove_field", { name: field.label })}
              onClick={() =>
                setFields((current) =>
                  current.filter((item) => item.id !== field.id),
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
            {field.type === "select" ? (
              <div className="grid gap-2 sm:col-span-3">
                <Input
                  aria-label={t("projects.options")}
                  placeholder={t("projects.options")}
                  value={optionDrafts[field.id] ?? field.options?.join(", ") ?? ""}
                  onChange={(event) => {
                    const draft = event.target.value;
                    setOptionDrafts((current) => ({ ...current, [field.id]: draft }));
                    change(field.id, { options: parseProjectOptions(draft) });
                  }}
                />
                {!props.definitionsOnly ? <Select
                  value={String(field.value ?? "")}
                  onValueChange={(value) =>
                    change(field.id, { value: value || null })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={field.label || t("projects.value")}
                  >
                    <SelectValue placeholder={t("projects.value")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      {t("projects.empty_value")}
                    </SelectItem>
                    {field.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select> : null}
              </div>
            ) : !props.definitionsOnly ? (
              <Input
                className="sm:col-span-3"
                aria-label={field.label || t("projects.value")}
                placeholder={t("projects.value")}
                type={
                  field.type === "number"
                    ? "number"
                    : field.type === "date"
                      ? "date"
                      : "text"
                }
                step="any"
                maxLength={4000}
                value={field.value ?? ""}
                onChange={(event) =>
                  change(field.id, {
                    value:
                      field.type === "number"
                        ? event.target.value === ""
                          ? null
                          : Number(event.target.value)
                        : event.target.value,
                  })
                }
              />
            ) : null}
            {!props.definitionsOnly && !defaults.some((entry) => entry.id === field.id) ? (
              <div className="flex justify-end sm:col-span-3">
                <Button type="button" variant="ghost" size="xs" disabled={!field.label.trim() || defaults.length >= 50} onClick={() => {
                  saveFieldToDefaults(field);
                  toast.success(t("projects.saved_to_defaults", { name: field.label.trim() }));
                }}>{t("projects.save_to_defaults")}</Button>
              </div>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={fields.length >= 50}
          onClick={() =>
            setFields((current) => [
              ...current,
              { id: crypto.randomUUID(), label: "", type: "text", value: null },
            ])
          }
        >
          <Plus className="size-4" />
          {t("projects.add_field")}
        </Button>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {conflict && props.onReload ? <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("projects.reload_fields_hint")}</p>
        <Button type="button" variant="outline" disabled={busy} onClick={async () => {
          if (!props.onReload) return;
          setBusy(true);
          try {
            const latest = await props.onReload();
            setFields(latest.fields);
            setOptionDrafts({});
            setConflict(false);
            setError(null);
          } catch (error) { setError(projectErrorMessage(error)); }
          finally { setBusy(false); }
        }}>{t("projects.reload_fields")}</Button>
      </div> : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={props.onCancel}
        >
          {t("projects.cancel")}
        </Button>
        <Button type="submit" disabled={busy || conflict}>
          {busy ? t("projects.saving") : t("projects.save")}
        </Button>
      </div>
    </form>
  );
}
