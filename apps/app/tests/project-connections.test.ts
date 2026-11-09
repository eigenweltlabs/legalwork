import { expect, test } from "bun:test";
import { BackOfficeRecordSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { projectFieldLabel, type ProjectField } from "@legalwork/types/workspace";
import { projectConnectionField, clientsFromProjectMatters } from "../src/react-app/domains/workspace/project-connections";

function record(objectId: string, name: string, values: Record<string, BackOfficeValue> = {}) {
  return BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId, values: { name, ...values }, revision: 1, schemaRevision: 1,
    ownerId: "owner", createdAt: "2026-11-09T10:00:00Z", updatedAt: "2026-11-09T10:00:00Z", archivedAt: null });
}

test("quick links preserve named custom roles, ID collisions and existing selection rules", () => {
  const fields: ProjectField[] = [{ id: "people", label: "Witnesses", labelSource: "custom", type: "backoffice", objectId: "people", multiple: true, value: null },
    { id: "client", label: "Internal client note", type: "text", value: "Keep this" }];
  expect(projectConnectionField(fields, "people", "People")).toMatchObject({ id: "people_2", label: "People", value: null });
  expect(projectConnectionField(fields, "clients", "Clients")).toMatchObject({ id: "client_2", label: "Clients" });
  const standard: ProjectField = { id: "matter", label: "Matters", labelSource: "suggested", type: "backoffice", objectId: "matters", multiple: false,
    filters: { mode: "all", conditions: [{ fieldId: "status", operator: "is", values: ["Active"] }] }, value: null };
  expect(projectConnectionField([...fields, standard], "matters", "Mandate")).toBe(standard);
  expect(fields[0].label).toBe("Witnesses");
  const people = projectConnectionField(fields, "people", "People");
  expect(projectConnectionField([...fields, people], "people", "Personen")).toBe(people);
  const responsible: ProjectField = { id: "responsible", label: "Responsible", labelSource: "suggested", type: "backoffice", objectId: "people", multiple: true, value: null };
  expect(projectConnectionField([responsible], "people", "People").id).toBe("people");
  const office = projectConnectionField([], "offices", "Offices");
  expect(projectFieldLabel(office)).toBe("Offices");
  expect(projectConnectionField([office], "offices", "Offices")).toBe(office);
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
