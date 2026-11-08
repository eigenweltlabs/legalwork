import { expect, test } from "bun:test";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { applyProjectTemplate, defaultProjectTemplates, migrateProjectDefaults, projectTemplateName, defaultAkteFields, emptyProjectFields, localizedProjectFields, localizedTemplateFields, projectFieldLabel, withInitialProjectFields } from "../src/react-app/domains/workspace/project-defaults-store";

test("untouched projects inherit optional defaults while saved schemas, values and removals are preserved", () => {
  const defaults: ProjectField[] = [{ id: "client", label: "Client", type: "text", value: "Never copy a value" }];
  const untouched: ProjectDetails = { version: 1, revision: 0, fields: [] };
  expect(withInitialProjectFields(untouched, defaults)).toEqual({
    ...untouched, fields: [{ ...defaults[0], labelSource: "suggested", value: null }],
  });
  expect(untouched.fields).toEqual([]);
  expect(withInitialProjectFields(untouched, []).fields).toEqual([]);
  const configured: ProjectDetails = { version: 1, revision: 2, fields: [{ ...defaults[0], label: "My client", value: "Acme" }] };
  expect(withInitialProjectFields(configured, defaults)).toBe(configured);
  const cleared: ProjectDetails = { version: 1, revision: 3, fields: [] };
  expect(withInitialProjectFields(cleared, defaults)).toBe(cleared);
  const existing: ProjectDetails = { ...configured, revision: 0 };
  expect(withInitialProjectFields(existing, defaults)).toBe(existing);
});

test("Akte defaults start empty and every new project's values and options are independent", () => {
  const template = defaultAkteFields();
  expect(template.map(field => [field.id, field.type, field.type === "backoffice" ? field.objectId : null])).toEqual([["matter", "backoffice", "matters"]]);
  expect(new Set(template.map((field) => field.id)).size).toBe(template.length);
  expect(template.every((field) => field.value === null)).toBe(true);
  const customized = defaultProjectTemplates()[1].fields.filter((field) => field.type !== "backoffice").map((field) => ({ ...field, value: "old value" }));
  const first = emptyProjectFields(customized);
  const second = emptyProjectFields(customized);
  first[0].value = "Client A";
  first.find((field) => field.options)?.options?.push("Custom state");
  expect(second.every((field) => field.value === null)).toBe(true);
  expect(second.find((field) => field.options)?.options).not.toContain("Custom state");
  expect(customized.every((field) => field.value === "old value")).toBe(true);
  expect(emptyProjectFields([])).toEqual([]);
});



test("legacy custom and explicitly empty defaults migrate only into Legal Matter", () => {
  const field: ProjectField = { id: "custom", label: "Priority", type: "select", options: ["High", "Low"], value: "High" };
  const migrated = migrateProjectDefaults({ fields: [field] });
  expect(migrated.defaultTemplateId).toBe("legal_matter");
  expect(migrated.templates).toHaveLength(4);
  expect(migrated.templates[0].fields).toEqual([{ ...field, value: null }]);
  expect(migrated.templates[1].fields.some((field) => field.id === "objective")).toBe(true);
  expect(migrateProjectDefaults({ fields: [] }).templates[0].fields).toEqual([]);
  expect(migrateProjectDefaults({ fields: null }).templates[0].fields).toHaveLength(1);
});

test("migration preserves custom templates, their names, options and an explicitly absent default", () => {
  const fields: ProjectField[] = [{ id: "price", label: "Price", type: "number", value: null }];
  const templates = [...defaultProjectTemplates(), { id: "custom", name: "Our deals", fields }];
  const migrated = migrateProjectDefaults({ templates, defaultTemplateId: null });
  expect(migrated.templates).toEqual(templates);
  expect(migrated.defaultTemplateId).toBeNull();
  expect(migrated.hasLegacyDefaults).toBe(true);
});

test("template selection keeps values and custom fields while replacing empty suggested fields", () => {
  const fields = defaultAkteFields();
  fields.push({ id: "client", label: "Client", labelSource: "suggested", type: "text", value: "Acme" });
  fields.push({ id: "custom", label: "Our code", labelSource: "custom", type: "text", value: null });
  const template = defaultProjectTemplates()[1];
  const applied = applyProjectTemplate(fields, template);
  expect(applied.find((field) => field.id === "client")?.value).toBe("Acme");
  expect(applied.some((field) => field.id === "custom")).toBe(true);
  expect(applied.some((field) => field.id === "court")).toBe(false);
  expect(applied.some((field) => field.id === "objective")).toBe(true);
  const repeated = applyProjectTemplate(applied, template);
  expect(repeated).toEqual(applied);
  expect(fields.some((field) => field.id === "objective")).toBe(false);
});

test("built-in template names translate, user names remain literal, and schemas have independent values", () => {
  const templates = defaultProjectTemplates();
  expect(projectTemplateName(templates[0], "en")).toBe("Legal Matter");
  expect(projectTemplateName(templates[0], "de")).toBe("Akte");
  expect(projectTemplateName({ ...templates[0], name: "My matters", nameSource: "custom" }, "de")).toBe("My matters");
  for (const template of templates) {
    expect(template.fields.every((field) => field.value === null)).toBe(true);
    expect(new Set(template.fields.map((field) => field.id)).size).toBe(template.fields.length);
  }
  templates[1].fields.find((field) => field.id === "status")?.options?.push("Extra");
  expect(templates[2].fields.find((field) => field.id === "status")?.options).not.toContain("Extra");
});

test("suggested labels map between English and German without changing values or options", () => {
  const german: ProjectField = { id: "client", label: "Mandant", labelSource: "suggested", type: "text", value: "Acme" };
  expect(projectFieldLabel(german, "en")).toBe("Client");
  expect(projectFieldLabel(german, "de")).toBe("Mandant");
  const localized = localizedProjectFields([german], "en");
  expect(localized[0]).toEqual({ ...german, label: "Client" });
  expect(localizedProjectFields(localized, "de")[0]).toEqual(german);
  expect(german.label).toBe("Mandant");
});

test("legacy saved presets map only when their id and original label match", () => {
  const legacy: ProjectField = { id: "client", label: "Mandant", type: "text", value: null };
  expect(projectFieldLabel(legacy, "en")).toBe("Client");
  expect(localizedProjectFields([legacy], "en")[0].labelSource).toBe("suggested");
  expect(projectFieldLabel({ ...legacy, id: "custom-client" }, "en")).toBe("Mandant");
  expect(projectFieldLabel({ ...legacy, label: "My client" }, "de")).toBe("My client");
  expect(projectFieldLabel({ ...legacy, labelSource: "custom" }, "en")).toBe("Mandant");
  expect(localizedProjectFields([{ ...legacy, labelSource: "custom" }], "en")[0].label).toBe("Mandant");
});


test("preset choices localize when copying templates but customized options and saved values remain literal", () => {
  const template = defaultProjectTemplates().find((template) => template.id === "internal")!;
  const localized = localizedTemplateFields(template.fields, "de");
  expect(localized.find((field) => field.id === "priority")?.options).toEqual(["Niedrig", "Normal", "Hoch"]);
  const status = template.fields.find((field) => field.id === "status")!;
  const custom = { ...status, options: ["Our status", "Next status"] };
  expect(localizedTemplateFields([custom], "de")[0].options).toEqual(custom.options);
  const saved = { ...status, value: status.options![0] };
  expect(localizedProjectFields([saved], "de")[0].options).toEqual(saved.options);
  expect(localizedProjectFields([saved], "de")[0].value).toBe(saved.value);
});
