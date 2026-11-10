import { create } from "zustand";
import { persist } from "zustand/middleware";
import * as shared from "@legalwork/types/workspace";
import { emptyProjectFields } from "@legalwork/types/workspace";
import type { ProjectDetails, ProjectField, ProjectMetadataTemplate } from "@legalwork/types/workspace";
import { currentLocale } from "@/i18n";

export type { ProjectMetadataTemplate } from "@legalwork/types/workspace";
export { emptyProjectFields } from "@legalwork/types/workspace";
export const projectFieldLabel = (field: ProjectField, locale = currentLocale()) => shared.projectFieldLabel(field, locale);
export const localizedProjectFields = (fields: ProjectField[], locale = currentLocale()) => shared.localizedProjectFields(fields, locale);
export const localizedTemplateFields = (fields: ProjectField[], locale = currentLocale()) => shared.localizedTemplateFields(fields, locale);
export const defaultAkteFields = () => shared.defaultAkteFields(currentLocale());
export const defaultProjectTemplates = () => shared.defaultProjectTemplates(currentLocale());
export const projectTemplateName = (template: ProjectMetadataTemplate, locale = currentLocale()) => shared.projectTemplateName(template, locale);

/** Older projects inherit defaults until their first save, including an explicitly empty save. */
export function withInitialProjectFields(details: ProjectDetails, defaults: ProjectField[]): ProjectDetails {
  if (details.revision > 0 || details.fields.length > 0) return details;
  return { ...details, fields: localizedTemplateFields(defaults) };
}

/** Switching templates keeps entered values and custom fields, including their types. */
export function applyProjectTemplate(fields: ProjectField[], template: ProjectMetadataTemplate): ProjectField[] {
  const selected = new Set(template.fields.map((field) => field.id));
  const existing = new Map(fields.map((field) => [field.id, field]));
  return [
    ...localizedTemplateFields(template.fields).map(field => {
      const old = existing.get(field.id);
      if (!old || (old.value === null && old.labelSource === "suggested" && field.type === "backoffice")) return field;
      if (old.type === "backoffice" && field.type === "backoffice" && old.objectId === field.objectId) {
        if (field.multiple || (old.value?.recordIds.length ?? 0) <= 1) return { ...field, value: old.value };
      }
      return old.type === "backoffice" && old.quickAction ? { ...old, quickAction: false } : old;
    }),
    ...fields.filter(field => !selected.has(field.id) && (field.value !== null && field.value !== "" || field.labelSource !== "suggested"))
      .map(field => field.type === "backoffice" && field.quickAction ? { ...field, quickAction: false } : field),
  ];
}

type ProjectTemplatesState = {
  serverKey: string | null;
  migrated: boolean;
  hasLegacyDefaults: boolean;
  templates: ProjectMetadataTemplate[];
  defaultTemplateId: string | null;
};

/** Version 0 held a single schema. Preserve even an explicitly empty schema. */
export function migrateProjectDefaults(persisted: unknown): Pick<ProjectTemplatesState, "templates" | "defaultTemplateId" | "hasLegacyDefaults"> {
  const templates = defaultProjectTemplates();
  // Preserve saved catalogs when upgrading from the browser-only template picker.
  if (persisted && typeof persisted === "object" && "templates" in persisted) {
    const parsed = shared.projectTemplateCatalogSchema.safeParse({ ...persisted, revision: 0 });
    if (parsed.success) {
      const legacy = parsed.data.templates.find((entry) => entry.id === "administration");
      if (legacy && !parsed.data.templates.some((entry) => entry.id === "contracts")) {
        const pristine = legacy.nameSource === "suggested" &&
          shared.localizedTemplateFields(legacy.fields, "en").every((field) => {
            const type = field.id === "status" ? "select" : field.id === "renewal_date" ? "date" : field.id === "budget" ? "number" : "text";
            return field.labelSource === "suggested" && field.type === type && (field.id === "status"
              ? JSON.stringify(field.options) === JSON.stringify(["Open", "In progress", "Waiting", "Closed"]) : field.options === undefined);
          }) && legacy.fields.map((field) => field.id).join(",") === "process,reference,project_owner,department,vendor,status,renewal_date,budget";
        if (pristine) parsed.data.templates = parsed.data.templates.filter((entry) => entry !== legacy);
        parsed.data.templates.push(templates.find((entry) => entry.id === "contracts")!);
        if (pristine && parsed.data.defaultTemplateId === legacy.id) parsed.data.defaultTemplateId = "contracts";
      }
      const upgraded = shared.upgradeProjectTemplateReferences(parsed.data);
      return { templates: upgraded.templates, defaultTemplateId: upgraded.defaultTemplateId, hasLegacyDefaults: true };
    }
  }
  if (persisted && typeof persisted === "object" && "fields" in persisted && Array.isArray(persisted.fields)) {
    const fields = persisted.fields.filter((field): field is ProjectField =>
      field !== null && typeof field === "object" && typeof field.id === "string" && typeof field.label === "string" &&
      ["text", "number", "date", "select"].includes(field.type) &&
      (field.options === undefined || Array.isArray(field.options) && field.options.every((option: unknown) => typeof option === "string")),
    );
    templates[0].fields = emptyProjectFields(fields);
  }
  return { templates: shared.upgradeProjectTemplateReferences({ revision: 0, defaultTemplateId: "legal_matter", templates }).templates, defaultTemplateId: "legal_matter", hasLegacyDefaults: Boolean(persisted && typeof persisted === "object" && "fields" in persisted) };
}

export const useProjectDefaultsStore = create<ProjectTemplatesState>()(persist((): ProjectTemplatesState => ({
  serverKey: null,
  migrated: false,
  hasLegacyDefaults: false,
  templates: defaultProjectTemplates(),
  defaultTemplateId: "legal_matter",
}), {
  name: "legalwork.projectMetadataDefaults",
  version: 6,
  migrate: migrateProjectDefaults,
  partialize: ({ templates, defaultTemplateId, migrated, hasLegacyDefaults }) => ({ templates, defaultTemplateId, migrated, hasLegacyDefaults }),
}));

const NO_FIELDS: ProjectField[] = [];
export function defaultProjectFields(state: Pick<ProjectTemplatesState, "templates" | "defaultTemplateId">): ProjectField[] {
  return state.templates.find((template) => template.id === state.defaultTemplateId)?.fields ?? NO_FIELDS;
}
