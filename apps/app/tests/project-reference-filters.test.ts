import { expect, test } from "bun:test";
import { BackOfficeRecordSchema, defaultBackOfficeModel, validateBackOfficeValues } from "@legalwork/types/back-office";
import { defaultProjectTemplates, internalPeopleFilters, matchesProjectReferenceFilters, projectReferenceFilterError, projectReferenceFiltersSchema } from "@legalwork/types/workspace";

const people = defaultBackOfficeModel().objects.find(object => object.id === "people")!;
function person(personType: string, active = true) {
  return BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: "people", revision: 1, schemaRevision: 1, ownerId: "local", archivedAt: null, createdAt: "2026-11-08T09:00:00Z", updatedAt: "2026-11-08T09:00:00Z", values: { name: "Person", personType, active } });
}

test("internal-people filters use editable select options and active status, with all/any semantics", () => {
  const filters = internalPeopleFilters();
  expect(matchesProjectReferenceFilters(person("Partner"), people, filters)).toBe(true);
  expect(matchesProjectReferenceFilters(person("Partner", false), people, filters)).toBe(false);
  expect(matchesProjectReferenceFilters(person("External contact"), people, filters)).toBe(false);
  expect(matchesProjectReferenceFilters(person("External contact"), people, { ...filters, mode: "any" })).toBe(true);
  const custom = { ...people, fields: people.fields.map(field => field.id === "personType" ? { ...field, options: [...field.options, "Research fellow"] } : field) };
  const record = person("Research fellow");
  expect(() => validateBackOfficeValues(custom, record.values)).not.toThrow();
  const customFilter = projectReferenceFiltersSchema.parse({ mode: "all", conditions: [{ fieldId: "personType", operator: "is", values: ["Research fellow"] }] });
  expect(projectReferenceFilterError(custom, customFilter)).toBeNull();
  expect(matchesProjectReferenceFilters(record, custom, customFilter)).toBe(true);
});

test("generic filters support custom object fields, typed comparisons and unavailable-field isolation", () => {
  const custom = { ...people, fields: [...people.fields, { ...people.fields[0], id: "score", type: "number" satisfies "number" }, { ...people.fields[0], id: "stamp", type: "datetime" satisfies "datetime" }] };
  const record = { ...person("Partner"), values: { name: "Acme Legal", score: 3, stamp: "2026-11-08T12:00:00+02:00" } };
  const condition = (fieldId: string, operator: "contains" | "gte" | "lt" | "is" | "empty", values: Array<string | number | boolean>) => projectReferenceFiltersSchema.parse({ mode: "all", conditions: [{ fieldId, operator, values }] });
  expect(matchesProjectReferenceFilters(record, custom, condition("name", "contains", ["LEGAL"]))).toBe(true);
  expect(matchesProjectReferenceFilters(record, custom, condition("score", "gte", [3]))).toBe(true);
  expect(matchesProjectReferenceFilters(record, custom, condition("stamp", "lt", ["2026-11-08T11:00:00Z"]))).toBe(true);
  expect(matchesProjectReferenceFilters(record, custom, condition("stamp", "is", ["2026-11-08T10:00:00Z"]))).toBe(true);
  expect(matchesProjectReferenceFilters(record, custom, condition("unknown", "empty", []))).toBe(false);
  expect(projectReferenceFilterError(people, condition("taxNumber", "is", ["secret"]))).not.toBeNull();
  expect(projectReferenceFilterError(people, condition("active", "is", ["true"]))).not.toBeNull();
  expect(projectReferenceFiltersSchema.safeParse({ mode: "all", conditions: [{ fieldId: "name", operator: "is", values: [] }] }).success).toBe(false);
});

test("starter responsibility and court filters are stored in field definitions", () => {
  const templates = defaultProjectTemplates();
  const legal = templates.find(template => template.id === "legal_matter")!;
  expect(legal.fields.find(field => field.id === "responsible")).toMatchObject({ filters: internalPeopleFilters() });
  expect(legal.fields.find(field => field.id === "court")).toMatchObject({ filters: { mode: "all", conditions: [{ fieldId: "organisationType", operator: "is", values: ["Court", "Public authority"] }] } });
  for (const template of templates.filter(template => template.id !== "legal_matter")) expect(template.fields.find(field => field.id === "project_owner")).toMatchObject({ filters: internalPeopleFilters() });
});
