import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { currentLocale, type Locale, t } from "@/i18n";

/** A template defines fields only. Every project starts with empty, optional values. */
export function emptyProjectFields(fields: ProjectField[]): ProjectField[] {
  return fields.map((field) => ({ ...field, value: null, ...(field.options ? { options: [...field.options] } : {}) }));
}

/** Older projects inherit defaults until their first save, including an explicitly empty save. */
export function withInitialProjectFields(details: ProjectDetails, defaults: ProjectField[]): ProjectDetails {
  if (details.revision > 0 || details.fields.length > 0) return details;
  return { ...details, fields: emptyProjectFields(defaults) };
}

/** Resolve only our known presets. Legacy defaults are recognized by both id and original label. */
function suggestedLabels(locale: Locale): Record<string, string> {
  return {
    matter_number: t("projects.schema.matter_number", locale),
    client: t("projects.schema.client", locale),
    opposing_party: t("projects.schema.opposing_party", locale),
    subject: t("projects.schema.subject", locale),
    practice_area: t("projects.schema.practice_area", locale),
    responsible: t("projects.schema.responsible", locale),
    status: t("projects.schema.status", locale),
    opened_on: t("projects.schema.opened_on", locale),
    court: t("projects.schema.court", locale),
    external_reference: t("projects.schema.external_reference", locale),
  };
}

export function projectFieldLabel(field: ProjectField, locale = currentLocale()): string {
  const label = suggestedLabels(locale)[field.id];
  if (!label || field.labelSource === "custom") return field.label;
  if (field.labelSource === "suggested" ||
      ["en", "de"].some((language) =>
        suggestedLabels(language === "de" ? "de" : "en")[field.id] === field.label)) return label;
  return field.label;
}

/** Preserve label provenance when a field editor saves or copies defaults. */
export function localizedProjectFields(fields: ProjectField[], locale = currentLocale()): ProjectField[] {
  return fields.map((field) => ({
    ...field,
    label: projectFieldLabel(field, locale),
    labelSource: field.labelSource ?? (
      suggestedLabels("en")[field.id] === field.label || suggestedLabels("de")[field.id] === field.label
        ? "suggested" : "custom"
    ),
  }));
}

export function defaultAkteFields(): ProjectField[] {
  return [
    { id: "matter_number", labelSource: "suggested", label: t("projects.schema.matter_number"), type: "text", value: null },
    { id: "client", labelSource: "suggested", label: t("projects.schema.client"), type: "text", value: null },
    { id: "opposing_party", labelSource: "suggested", label: t("projects.schema.opposing_party"), type: "text", value: null },
    { id: "subject", labelSource: "suggested", label: t("projects.schema.subject"), type: "text", value: null },
    { id: "practice_area", labelSource: "suggested", label: t("projects.schema.practice_area"), type: "text", value: null },
    { id: "responsible", labelSource: "suggested", label: t("projects.schema.responsible"), type: "text", value: null },
    { id: "status", labelSource: "suggested", label: t("projects.schema.status"), type: "select", value: null,
      options: [t("projects.schema.status_open"), t("projects.schema.status_active"), t("projects.schema.status_waiting"), t("projects.schema.status_closed")] },
    { id: "opened_on", labelSource: "suggested", label: t("projects.schema.opened_on"), type: "date", value: null },
    { id: "court", labelSource: "suggested", label: t("projects.schema.court"), type: "text", value: null },
    { id: "external_reference", labelSource: "suggested", label: t("projects.schema.external_reference"), type: "text", value: null },
  ];
}

export const useProjectDefaultsStore = create<{
  fields: ProjectField[] | null;
  setFields: (fields: ProjectField[]) => void;
  addField: (field: ProjectField) => void;
  reset: () => void;
}>()(persist((set) => ({
  fields: null,
  setFields: (fields) => set({ fields: emptyProjectFields(fields) }),
  addField: (field) => set((state) => {
    const fields = state.fields ?? defaultAkteFields();
    if (!field.label.trim() || fields.length >= 50 || fields.some((entry) => entry.id === field.id)) return state;
    return { fields: emptyProjectFields([...fields, { ...field, label: field.label.trim() }]) };
  }),
  reset: () => set({ fields: null }),
}), { name: "legalwork.projectMetadataDefaults" }));

export function newProjectFields(): ProjectField[] {
  return emptyProjectFields(localizedProjectFields(useProjectDefaultsStore.getState().fields ?? defaultAkteFields()));
}
