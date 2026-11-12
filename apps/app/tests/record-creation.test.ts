import { expect, test } from "bun:test";
import { BackOfficeRecordSchema, defaultBackOfficeModel } from "@legalwork/types/back-office";
import { internalPeopleFilters, matchesProjectReferenceFilters } from "@legalwork/types/workspace";
import { BackOfficeStateSchema } from "../src/react-app/domains/back-office/api";
import { creatableRecordObject, recordCreationValues } from "../src/react-app/domains/back-office/record-creation-values";

test("filtered creation supplies unambiguous defaults without guessing an internal person's type", () => {
  const object = defaultBackOfficeModel().objects.find(object => object.id === "people")!;
  const filters = internalPeopleFilters(), values = recordCreationValues(object, "New colleague", filters);
  expect(values).toEqual({ name: "New colleague", active: true });
  const record = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: object.id, revision: 0, schemaRevision: 1, ownerId: "local", values, archivedAt: null, createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z" });
  expect(matchesProjectReferenceFilters(record, object, filters)).toBe(false);
  expect(matchesProjectReferenceFilters({ ...record, values: { ...values, personType: "Associate" } }, object, filters)).toBe(true);
  const partner = { ...filters, conditions: filters.conditions.map(condition => condition.fieldId === "personType" ? { ...condition, values: ["Partner"] } : condition) };
  expect(recordCreationValues(object, "Named partner", partner)).toEqual({ name: "Named partner", active: true, personType: "Partner" });
  expect(recordCreationValues(object, "External", { ...filters, mode: "any" })).toEqual({ name: "External", active: true, personType: "External contact" });
});

test("entity creation is unavailable for read-only, hidden, archived and unauthorized financial targets", () => {
  const model = defaultBackOfficeModel();
  const state = BackOfficeStateSchema.parse({ directoryId: "local:fixture", model, records: [], views: [], permissions: { userId: "local", edit: true, model: false, finance: false }, sync: { enabled: false, cursor: 0, pending: 0, error: null } });
  expect(creatableRecordObject(state, "clients")?.id).toBe("clients");
  expect(creatableRecordObject(state, "projectLinks")).toBeUndefined();
  expect(creatableRecordObject(state, "invoices")).toBeUndefined();
  expect(creatableRecordObject({ ...state, directoryId: undefined }, "clients")).toBeUndefined();
  expect(creatableRecordObject({ ...state, permissions: { ...state.permissions, edit: false } }, "clients")).toBeUndefined();
  const custom = { ...model.objects[0], id: "custom", protected: false, archived: true };
  const customState = { ...state, model: { ...model, objects: [...model.objects, custom] } };
  expect(creatableRecordObject(customState, "custom")).toBeUndefined();
});
