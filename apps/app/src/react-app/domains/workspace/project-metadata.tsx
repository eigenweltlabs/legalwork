import { RecordCreationProvider } from "../back-office/record-creation-context";
import { projectReferenceFiltersSchema } from "@legalwork/types/workspace";
import { ProjectReferenceFilterEditor } from "./project-reference-filter-editor";
import { useState, type ReactNode } from "react";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { Checkbox } from "@/components/ui/checkbox";
import { projectReferenceObjects, useProjectBackOffice } from "./project-record-field";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
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
import { toast } from "@/components/ui/sonner";
import { applyProjectTemplate, localizedTemplateFields, localizedProjectFields, useProjectDefaultsStore } from "./project-defaults-store";
import { ProjectTemplateSelect } from "./project-template-select";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { changeProjectFieldType, parseProjectOptions } from "./project-field-editing";

export function ProjectMetadata(props: {
  client?: LegalworkServerClient | null;
  details: Pick<ProjectDetails, "fields">;
  definitionsOnly?: boolean;
  children?: ReactNode;
  saveDisabled?: boolean;
  onSave: (fields: ProjectField[]) => Promise<void>;
  onCancel: () => void;
  onReload?: () => Promise<Pick<ProjectDetails, "fields">>;
}) {
  const directory = useProjectBackOffice(props.client);
  const objects = projectReferenceObjects(directory.data);
  const templates = useProjectDefaultsStore((state) => state.templates);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const typeLabels = {
    text: t("projects.type_text"),
    number: t("projects.type_number"),
    date: t("projects.type_date"),
    select: t("projects.type_select"),
    backoffice: t("projects.reference.type"),
  };
  const [fields, setFields] = useState(() => props.definitionsOnly ? localizedTemplateFields(props.details.fields) : localizedProjectFields(props.details.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const replace = (next: ProjectField) => setFields(current => current.map(field => field.id === next.id ? next : field));
  const save = async () => {
    if (busy || conflict || props.saveDisabled) return;
    if (fields.some((field) => !field.label.trim())) return;
    if (fields.some((field) => field.type === "select" && field.value !== null && field.value !== "" && !field.options?.includes(String(field.value)))) {
      setError(t("projects.options_value_missing"));
      return;
    }
    if (fields.some(field => field.type === "backoffice" && field.filters && !projectReferenceFiltersSchema.safeParse(field.filters).success)) { setError(t("projects.reference.filters_incomplete")); return; }
    setBusy(true);
    setError(null);
    try {
      await props.onSave(fields);
    } catch (error) {
      setConflict(error instanceof LegalworkServerError && (error.code === "project_changed" || error.code === "project_templates_conflict"));
      setError(projectErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <RecordCreationProvider client={props.client} state={directory.data}><form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {props.children}
        {!props.definitionsOnly && templates.length > 0 ? <div className="space-y-2 rounded-xl border border-border p-3">
          <div className="text-sm font-medium">{t("projects.templates.template")}</div>
          <div className="flex items-center gap-2">
            <ProjectTemplateSelect value={templateId} onChange={setTemplateId} />
            <Button type="button" variant="outline" disabled={!templateId || conflict} onClick={() => {
              const template = templates.find((entry) => entry.id === templateId);
              if (!template) return;
              const next = applyProjectTemplate(fields, template);
              if (next.length > 50) { setError(t("projects.templates.too_many_fields")); return; }
              setFields(next);
              setOptionDrafts({});
              setError(null);
            }}>{t("projects.templates.apply")}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("projects.templates.apply_hint")}</p>
        </div> : null}
        {fields.map((field) => (
          <div
            key={field.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]"
          >
            <label className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t("projects.field_name")}</span>
            <Input
              className="rounded-md"
              aria-label={t("projects.field_name")}
              placeholder={t("projects.field_name")}
              required
              maxLength={100}
              value={field.label}
              onChange={(event) =>
                replace({ ...field, label: event.target.value, labelSource: "custom" })
              }
            />
            </label>
            <div className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t(field.type === "backoffice" ? "projects.reference.records_from" : "projects.field_type")}</span>
            <Select
              value={field.type === "backoffice" ? `backoffice:${field.objectId}` : field.type}
              onValueChange={(value) => {
                const object = objects.find(object => `backoffice:${object.id}` === value);
                const type = object ? "backoffice" : value === "text" || value === "number" || value === "date" || value === "select" ? value : null;
                if (!type) return;
                const next = changeProjectFieldType(field, type, object?.id);
                if (!next) return;
                if (field.value !== null && field.value !== "" && next.value === null)
                  toast.info(t("projects.value_overwrite_notice", { name: field.label }));
                replace(next);
                setOptionDrafts(current => ({ ...current, [field.id]: next.options?.join(", ") ?? "" }));
                setError(null);
              }}
            >
              <SelectTrigger
                aria-label={t("projects.field_type")}
                className="w-full rounded-md bg-transparent"
              >
                <SelectValue>{field.type === "backoffice" ? objects.find(object => object.id === field.objectId)?.plural ?? t("projects.reference.unavailable_object") : typeLabels[field.type]}</SelectValue>
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
                {objects.map(object => <SelectItem key={object.id} value={`backoffice:${object.id}`}>{object.plural}</SelectItem>)}
                {field.type === "backoffice" && !objects.some(object => object.id === field.objectId) && <SelectItem value={`backoffice:${field.objectId}`} disabled>{t("projects.reference.unavailable_object")}</SelectItem>}
              </SelectContent>
            </Select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="col-start-2 row-start-1 self-end text-muted-foreground sm:col-start-3"
              aria-label={t("projects.remove_field", { name: field.label })}
              onClick={() =>
                setFields((current) =>
                  current.filter((item) => item.id !== field.id),
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
            {field.type === "backoffice" ? <div className="col-span-2 space-y-2 sm:col-span-3">
              <label className="flex items-center gap-2 text-xs"><Checkbox checked={field.multiple} onCheckedChange={checked => {
                const clear = !checked && (field.value?.recordIds.length ?? 0) > 1;
                if (clear) toast.info(t("projects.value_overwrite_notice", { name: field.label }));
                replace({ ...field, multiple: checked === true, value: clear ? null : field.value });
                setError(null);
              }} />{t("projects.reference.multiple")}</label>
              <ProjectReferenceFilterEditor object={objects.find(object => object.id === field.objectId)} records={directory.data?.records ?? []} value={field.filters} onChange={filters => replace({ ...field, filters })} />
            </div> : field.type === "select" ? (
              <div className="col-span-2 grid gap-2 sm:col-span-3">
                <Input
                  aria-label={t("projects.options")}
                  placeholder={t("projects.options")}
                  value={optionDrafts[field.id] ?? field.options?.join(", ") ?? ""}
                  onChange={(event) => {
                    const draft = event.target.value;
                    setOptionDrafts((current) => ({ ...current, [field.id]: draft }));
                    replace({ ...field, options: parseProjectOptions(draft) });
                  }}
                />

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
              { id: crypto.randomUUID(), labelSource: "custom", label: "", type: "text", value: null },
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
            setFields(localizedProjectFields(latest.fields));
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
        <Button type="submit" disabled={busy || conflict || props.saveDisabled}>
          {busy ? t("projects.saving") : t("projects.save")}
        </Button>
      </div>
    </form></RecordCreationProvider>
  );
}
