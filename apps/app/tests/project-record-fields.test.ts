import legacyLegalMatter from "./fixtures/legal-matter-template-v6.json";
import { expect, test } from "bun:test";
import { BackOfficeRecordSchema } from "@legalwork/types/back-office";
import { defaultProjectTemplates, emptyProjectFields, projectFieldsSchema, upgradeProjectTemplateReferences } from "@legalwork/types/workspace";
import type { ProjectField, ProjectTemplateCatalog } from "@legalwork/types/workspace";
import { applyProjectTemplate } from "../src/react-app/domains/workspace/project-defaults-store";
import { changeProjectFieldType } from "../src/react-app/domains/workspace/project-field-editing";
import { collectProjectFilterFields, matchesProjectFilters, projectFilterFieldKey, projectReferenceFilterValue, type ProjectFilter } from "../src/react-app/domains/workspace/project-filters";

const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const reference: Extract<ProjectField, { type: "backoffice" }> = {
  id: "our_contacts", label: "Our contacts", labelSource: "custom", type: "backoffice", objectId: "customContacts", multiple: true,
  value: { directoryId: "team:firm-a", recordIds: [first, second] },
};
function record(id: string, name: string) {
  return BackOfficeRecordSchema.parse({ id, objectId: reference.objectId, values: { name }, revision: 1, schemaRevision: 1,
    ownerId: "lawyer", createdAt: "2026-11-07T10:00:00Z", updatedAt: "2026-11-07T10:00:00Z", archivedAt: null });
}
const filter = (values: string[], operator: ProjectFilter["operator"] = "is"): ProjectFilter => ({
  id: "filter", field: { key: projectFilterFieldKey(reference), label: reference.label, type: reference.type }, operator, values,
});

test("custom object references validate cardinality and IDs, while template copies keep definitions only", () => {
  expect(projectFieldsSchema.parse([reference])).toEqual([reference]);
  expect(emptyProjectFields([reference])).toEqual([{ ...reference, value: null }]);
  for (const field of [
    { ...reference, multiple: false },
    { ...reference, objectId: "" },
    { ...reference, value: { directoryId: "team:firm-a", recordIds: [first, first] } },
    { ...reference, value: { directoryId: "", recordIds: [first] } },
    { ...reference, value: "A name is not an identity" },
  ]) expect(projectFieldsSchema.safeParse([field]).success).toBe(false);
  expect(changeProjectFieldType(reference, "text")).toMatchObject({ type: "text", value: null });
  expect(changeProjectFieldType(reference, "backoffice", "companies")).toMatchObject({ type: "backoffice", objectId: "companies", value: null });
  expect(changeProjectFieldType({ id: "custom", label: "Custom", type: "text", value: "Acme" }, "backoffice", "companies")).toMatchObject({ type: "backoffice", objectId: "companies", value: null });
  expect(reference.value?.recordIds).toEqual([first, second]);
  expect(changeProjectFieldType({ ...reference, value: null }, "backoffice", "companies")).toMatchObject({ objectId: "companies", value: null });
});

test("reference filters match any selected ID, reject another directory or target, and handle empty and negative filters", () => {
  const selected = projectReferenceFilterValue("team:firm-a", second);
  expect(matchesProjectFilters([reference], [filter([selected])], "all")).toBe(true);
  expect(matchesProjectFilters([reference], [filter([selected], "is_not")], "all")).toBe(false);
  expect(matchesProjectFilters([reference], [filter([projectReferenceFilterValue("team:firm-b", second)])], "all")).toBe(false);
  expect(matchesProjectFilters([{ ...reference, objectId: "companies" }], [filter([selected])], "all")).toBe(false);
  expect(matchesProjectFilters([{ ...reference, value: null }], [filter([], "empty")], "all")).toBe(true);
  expect(matchesProjectFilters([reference], [filter([], "not_empty")], "all")).toBe(true);
});

test("filter choices show current names and counts without changing identity or exposing unavailable names", () => {
  const directory = { directoryId: "team:firm-a", records: [record(first, "Renamed contact"), record(second, "Second contact")] };
  const choices = collectProjectFilterFields([[reference], [{ ...reference, value: null }]], directory)[0].options;
  expect(choices).toContainEqual({ value: projectReferenceFilterValue(directory.directoryId, first), label: "Renamed contact", count: 1 });
  expect(collectProjectFilterFields([[reference]], { ...directory, directoryId: "team:firm-b" })[0].options.every(option => option.count === 0)).toBe(true);
  expect(collectProjectFilterFields([[reference]], { ...directory, records: [] })[0].options).toEqual([]);
});

test("untouched starter templates upgrade to reference fields while custom schemas and existing text values survive", () => {
  const current = defaultProjectTemplates();
  const legacy: ProjectTemplateCatalog = { revision: 5, defaultTemplateId: "legal_matter", templates: current.map(template => ({ ...template,
    fields: (template.id === "legal_matter" ? projectFieldsSchema.parse(legacyLegalMatter) : template.fields).filter(field => field.id !== "matter").map((field): ProjectField => field.type === "backoffice"
      ? { id: field.id, label: field.label, labelSource: field.labelSource, type: "text", value: null } : field),
  })) };
  expect(upgradeProjectTemplateReferences(legacy).templates).toEqual(current);
  const custom = { ...legacy, templates: legacy.templates.map(template => ({ ...template, nameSource: "custom" satisfies "custom" })) };
  expect(upgradeProjectTemplateReferences(custom)).toEqual(custom);
  const client: ProjectField = { id: "client", label: "Client", labelSource: "suggested", type: "text", value: "Existing free text" };
  expect(applyProjectTemplate([client, reference], current[0])).toContainEqual(client);
  expect(applyProjectTemplate([client, reference], current[0])).toContainEqual(reference);
  expect(applyProjectTemplate([{ ...client, value: null }], current[0])).toEqual(current[0].fields);
});

test("the legal starter offers optional matter and client links while contract counterparties remain organisation references", () => {
  const templates = defaultProjectTemplates(), legal = templates.find(template => template.id === "legal_matter")!;
  expect(legal.fields.map(field => field.id)).toEqual(["matter", "client"]);
  expect(templates.find(template => template.id === "contracts")?.fields.find(field => field.id === "counterparty")).toMatchObject({ type: "backoffice", objectId: "companies" });
  const previous = { ...legal, fields: projectFieldsSchema.parse(legacyLegalMatter).map((field): ProjectField => ["court", "opposing_party"].includes(field.id) ? { id: field.id, label: field.label, labelSource: field.labelSource, type: "text", value: null } : field) };
  const catalog = { revision: 7, defaultTemplateId: legal.id, templates: [previous] };
  expect(upgradeProjectTemplateReferences(catalog).templates[0]).toEqual(legal);
  const custom = { ...catalog, templates: [{ ...previous, nameSource: "custom" satisfies "custom" }] };
  expect(upgradeProjectTemplateReferences(custom)).toEqual(custom);
});

test("an untouched matter-only preset upgrades once and an explicit quick action preference survives reload", () => {
  const [legal] = defaultProjectTemplates("de");
  const previous = { ...legal, fields: legal.fields.slice(0, 1).map(field => ({ ...field, quickAction: undefined })) };
  const catalog = { revision: 5, defaultTemplateId: legal.id, templates: [previous] };
  expect(upgradeProjectTemplateReferences(catalog).templates[0].fields.map(field => [field.id, field.type === "backoffice" && field.quickAction]))
    .toEqual([["matter", true], ["client", true]]);
  const customized = { ...catalog, templates: [{ ...previous, fields: previous.fields.map(field => ({ ...field, quickAction: false })) }] };
  expect(upgradeProjectTemplateReferences(customized)).toEqual(customized);
});
