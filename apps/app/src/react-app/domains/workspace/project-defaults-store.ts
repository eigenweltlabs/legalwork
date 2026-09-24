import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProjectField } from "@legalwork/types/workspace";
import { t } from "@/i18n";

/** A template defines fields only. Every project starts with empty, optional values. */
export function emptyProjectFields(fields: ProjectField[]): ProjectField[] {
  return fields.map((field) => ({ ...field, value: null, ...(field.options ? { options: [...field.options] } : {}) }));
}

export function defaultAkteFields(): ProjectField[] {
  return [
    { id: "matter_number", label: t("projects.schema.matter_number"), type: "text", value: null },
    { id: "client", label: t("projects.schema.client"), type: "text", value: null },
    { id: "opposing_party", label: t("projects.schema.opposing_party"), type: "text", value: null },
    { id: "subject", label: t("projects.schema.subject"), type: "text", value: null },
    { id: "practice_area", label: t("projects.schema.practice_area"), type: "text", value: null },
    { id: "responsible", label: t("projects.schema.responsible"), type: "text", value: null },
    { id: "status", label: t("projects.schema.status"), type: "select", value: null,
      options: [t("projects.schema.status_open"), t("projects.schema.status_active"), t("projects.schema.status_waiting"), t("projects.schema.status_closed")] },
    { id: "opened_on", label: t("projects.schema.opened_on"), type: "date", value: null },
    { id: "court", label: t("projects.schema.court"), type: "text", value: null },
    { id: "external_reference", label: t("projects.schema.external_reference"), type: "text", value: null },
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
  return emptyProjectFields(useProjectDefaultsStore.getState().fields ?? defaultAkteFields());
}
