import { expect, test } from "bun:test";
import legacyLegalMatter from "./fixtures/legal-matter-template-v6.json";
import { defaultProjectTemplates, localizedTemplateFields, projectFieldsSchema, upgradeProjectTemplateReferences } from "@legalwork/types/workspace";

test("saved English and German legal presets drop duplicated facts and keep only the matter reference", () => {
  const current = defaultProjectTemplates()[0];
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    const previous = { ...current, fields: localizedTemplateFields(projectFieldsSchema.parse(legacyLegalMatter), locale) };
    const catalog = { revision: 8, defaultTemplateId: current.id, templates: [previous] };
    const upgraded = upgradeProjectTemplateReferences(catalog);
    expect(upgraded.templates[0].fields).toEqual(current.fields);
    expect(upgraded.revision).toBe(8);
    expect(catalog.templates[0].fields).toHaveLength(11);
    expect(upgradeProjectTemplateReferences(upgraded)).toEqual(upgraded);
  }
});

test("explicit empty schemas and customized template definitions stay intact", () => {
  const current = defaultProjectTemplates()[0];
  for (const template of [
    { ...current, fields: [] },
    { ...current, name: "Our matter workflow", nameSource: "custom" satisfies "custom", fields: projectFieldsSchema.parse(legacyLegalMatter) },
    { ...current, fields: projectFieldsSchema.parse(legacyLegalMatter).map(field => field.id === "subject" ? { ...field, label: "Project objective", labelSource: "custom" satisfies "custom" } : field) },
  ]) {
    const catalog = { revision: 8, defaultTemplateId: current.id, templates: [template] };
    expect(upgradeProjectTemplateReferences(catalog)).toEqual(catalog);
  }
});
