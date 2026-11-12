import { expect, test } from "bun:test";
import { openSqlite } from "../runtime-db.js";
import { defaultProjectTemplates } from "../project-schema.js";
import { backOfficeRecordUrl } from "./schema.js";
import { BackOfficeStore } from "./store.js";
import { projectBackOfficeReferences } from "./project-references.js";

test("a matter-only project resolves current client, organisation and contact context with cycles deduplicated", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  const actor = { userId: "owner", model: true, edit: true, finance: false };
  try {
    const organisation = store.saveRecord("local", actor, { objectId: "companies", revision: 0, values: { name: "Organisation" } });
    const person = store.saveRecord("local", actor, { objectId: "people", revision: 0, values: { name: "Contact", company: organisation.id } });
    store.saveRecord("local", actor, { id: organisation.id, objectId: "companies", revision: organisation.revision, values: { contact: person.id } });
    const client = store.saveRecord("local", actor, { objectId: "clients", revision: 0, values: { name: "Client", company: organisation.id } });
    const matter = store.saveRecord("local", actor, { objectId: "matters", revision: 0, values: { name: "Matter", fileNumber: "MAT-42", clients: [client.id] } });
    store.saveRecord("local", actor, { objectId: "clients", revision: 0, values: { name: "Unrelated client" } });
    const fields = defaultProjectTemplates()[0].fields.filter(field => field.id === "matter").map(field => field.type === "backoffice" ? { ...field, value: { directoryId: "local:fixture", recordIds: [matter.id] } } : field);
    const context = { scope: "local", store, actor, directoryId: "local:fixture", model: store.model("local"), records: store.records("local", actor).map(record => ({ ...record, url: backOfficeRecordUrl(record) })) };
    const resolved = projectBackOfficeReferences(context, fields);
    expect(fields.map(field => field.id)).toEqual(["matter"]);
    expect(resolved.records.map(record => record.id).sort()).toEqual([matter.id, client.id, organisation.id, person.id].sort());
    expect(resolved.fields[0].records.map(record => record.id)).toEqual([matter.id]);
    expect(resolved.clients.map(record => record.id)).toEqual([client.id]);
    const restricted = projectBackOfficeReferences({ ...context, records: context.records.filter(record => record.id !== client.id) }, fields);
    expect(restricted.records.map(record => record.id)).toEqual([matter.id]);
    expect(restricted.clients).toEqual([]);
    expect(projectBackOfficeReferences(context, fields.map(field => field.type === "backoffice" ? { ...field, value: { directoryId: "local:other", recordIds: [matter.id] } } : field)).records).toEqual([]);
  } finally { store.close(); }
});
