import { expect, test } from "bun:test";
import { BackOfficeRecordSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { type ProjectField } from "@legalwork/types/workspace";
import { isProjectQuickAction, clientsFromProjectMatters, projectQuickActionLabel } from "../src/react-app/domains/workspace/project-connections";

function record(objectId: string, name: string, values: Record<string, BackOfficeValue> = {}) {
  return BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId, values: { name, ...values }, revision: 1, schemaRevision: 1,
    ownerId: "owner", createdAt: "2026-11-09T10:00:00Z", updatedAt: "2026-11-09T10:00:00Z", archivedAt: null });
}

test("a quick action belongs to its field, even when two roles point to the same object", () => {
  const role: ProjectField = { id: "witness", label: "Witness", labelSource: "custom", type: "backoffice", objectId: "people", multiple: false, quickAction: true, value: null };
  const other = { ...role, id: "owner", label: "Project owner", quickAction: false };
  expect([role, other].filter(isProjectQuickAction)).toEqual([role]);
  expect(projectQuickActionLabel(role)).toBe("Add Witness");
});

test("inherited clients retain source matters, deduplicate and do not cross directories or disclose unavailable records", () => {
  const client = record("clients", "ABC"), hidden = crypto.randomUUID(), person = record("people", "Not a client");
  const a = record("matters", "Acquisition", { clients: [client.id, hidden, person.id] });
  const b = record("matters", "Finance", { clients: [client.id] });
  const field: ProjectField = { id: "matter", label: "Matters", type: "backoffice", objectId: "matters", multiple: true, value: { directoryId: "firm-a", recordIds: [a.id, b.id] } };
  const records = [client, person, a, b];
  expect(clientsFromProjectMatters([field, { ...field, id: "otherRole" }], "firm-a", records)).toEqual([{ client, matters: [a, b] }]);
  expect(clientsFromProjectMatters([field], "firm-b", records)).toEqual([]);
  expect(clientsFromProjectMatters([field], "firm-a", records.filter(row => row.id !== client.id))).toEqual([]);
  expect(clientsFromProjectMatters([field], undefined, records)).toEqual([]);
  expect(clientsFromProjectMatters([field], "firm-a", records.map(row => row.id === client.id ? { ...row, archivedAt: "2026-11-09T12:00:00Z" } : row))).toEqual([]);
});

test("inherited clients omit direct project links but keep additional clients and foreign-directory distinctions", () => {
  const direct = record("clients", "ABC"), additional = record("clients", "DEF");
  const matter = record("matters", "Acquisition", { clients: [direct.id, additional.id] });
  const records = [direct, additional, matter];
  const source: ProjectField = { id: "matter", label: "Matters", type: "backoffice", objectId: "matters", multiple: true,
    value: { directoryId: "firm-a", recordIds: [matter.id] } };
  const assigned: ProjectField = { id: "client", label: "Clients", type: "backoffice", objectId: "clients", multiple: true,
    value: { directoryId: "firm-a", recordIds: [direct.id] } };
  expect(clientsFromProjectMatters([source, assigned], "firm-a", records)).toEqual([{ client: additional, matters: [matter] }]);
  expect(clientsFromProjectMatters([source, { ...assigned, value: { directoryId: "firm-a", recordIds: [direct.id, additional.id] } }], "firm-a", records)).toEqual([]);
  expect(clientsFromProjectMatters([source, { ...assigned, value: { directoryId: "firm-b", recordIds: [direct.id] } }], "firm-a", records)).toHaveLength(2);
  expect(clientsFromProjectMatters([source, { ...assigned, value: null }], "firm-a", records)).toHaveLength(2);
});
