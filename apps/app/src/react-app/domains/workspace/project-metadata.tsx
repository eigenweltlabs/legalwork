import { RecordCreationProvider } from "../back-office/record-creation-context";
import { projectFieldsSchema, projectReferenceFiltersSchema } from "@legalwork/types/workspace";
import { useRef, useState, type ReactNode } from "react";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { useProjectBackOffice } from "./project-record-field";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { applyProjectTemplate, localizedTemplateFields, localizedProjectFields, useProjectDefaultsStore } from "./project-defaults-store";
import { ProjectTemplateSelect } from "./project-template-select";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { ProjectFieldEditor } from "./project-field-editor";

export function ProjectMetadata(props: {
  client?: LegalworkServerClient | null;
  details: Pick<ProjectDetails, "fields">;
  isTemplate?: boolean;
  showTemplates?: boolean;
  children?: ReactNode;
  saveDisabled?: boolean;
  onSave: (fields: ProjectField[]) => Promise<void>;
  onCancel: () => void;
  onReload?: () => Promise<Pick<ProjectDetails, "fields">>;
}) {
  const directory = useProjectBackOffice(props.client);
  const templates = useProjectDefaultsStore((state) => state.templates);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [fields, setFields] = useState(() => props.isTemplate ? localizedTemplateFields(props.details.fields) : localizedProjectFields(props.details.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const [generation, setGeneration] = useState(0);
  const [newFieldId, setNewFieldId] = useState<string | null>(null);
  const replace = (next: ProjectField) => setFields(current => current.map(field => field.id === next.id ? next : field));
  const save = async () => {
    if (saving.current || conflict || props.saveDisabled) return;
    if (fields.some((field) => !field.label.trim())) { setError(t("projects.field_name_required")); return; }
    if (fields.some((field) => field.type === "select" && field.value !== null && field.value !== "" && !field.options?.includes(String(field.value)))) {
      setError(t("projects.options_value_missing"));
      return;
    }
    if (fields.some(field => field.type === "backoffice" && field.filters && !projectReferenceFiltersSchema.safeParse(field.filters).success)) { setError(t("projects.reference.filters_incomplete")); return; }
    saving.current = true; setBusy(true);
    setError(null);
    try {
      await props.onSave(projectFieldsSchema.parse(fields));
    } catch (error) {
      setConflict(error instanceof LegalworkServerError && (error.code === "project_changed" || error.code === "project_templates_conflict"));
      setError(projectErrorMessage(error));
    } finally {
      saving.current = false; setBusy(false);
    }
  };
  return (
    <RecordCreationProvider client={props.client} state={directory.data}><form
      className="mt-4 space-y-4"
      onKeyDown={event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); if (!event.repeat && event.currentTarget.reportValidity()) void save();
        }
      }}
      onSubmit={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault(); event.stopPropagation();
        void save();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {props.children}
        {!props.isTemplate && props.showTemplates !== false && templates.length > 0 ? <div className="space-y-2 rounded-xl border border-border p-3">
          <div className="text-sm font-medium">{t("projects.templates.apply_title")}</div>
          <div className="flex items-center gap-2">
            <ProjectTemplateSelect value={templateId} onChange={setTemplateId} emptyLabel={t("projects.templates.choose")} />
            <Button type="button" variant="outline" disabled={!templateId || conflict} onClick={() => {
              const template = templates.find((entry) => entry.id === templateId);
              if (!template) return;
              const next = applyProjectTemplate(fields, template);
              if (next.length > 50) { setError(t("projects.templates.too_many_fields")); return; }
              setFields(next); setGeneration(value => value + 1);
              setError(null);
            }}>{t("projects.templates.apply")}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("projects.templates.apply_hint")}</p>
        </div> : null}
        {fields.map(field => <div key={field.id} className="rounded-xl border border-border p-4">
          <ProjectFieldEditor key={`${field.id}:${generation}`} field={field} state={directory.data} disabled={busy} autoFocus={newFieldId === field.id}
            onChange={next => { replace(next); setError(null); }}
            action={<Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t("projects.remove_field", { name: field.label })}
              onClick={() => setFields(current => current.filter(item => item.id !== field.id))}><Trash2 className="size-4" /></Button>} />
        </div>)}
        <Button
          type="button"
          variant="outline"
          disabled={fields.length >= 50}
          onClick={() => {
            const id = crypto.randomUUID(); setNewFieldId(id);
            setFields(current => [...current, { id, labelSource: "custom", label: "", type: "text", value: null }]);
          }}
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
            setFields(props.isTemplate ? localizedTemplateFields(latest.fields) : localizedProjectFields(latest.fields));
            setGeneration(value => value + 1);
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
