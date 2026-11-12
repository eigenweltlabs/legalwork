import { expect, test } from "bun:test";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { BackOfficeFieldSchema, BackOfficeRecordSchema, BackOfficeViewSchema, defaultBackOfficeModel, upgradeBackOfficeModel, upgradeBackOfficeRecord } from "./schema.js";

const actor = { userId: "owner", edit: true, model: true, finance: true };

test("client preview upgrade retires redundant type and view settings while retaining links and signed history", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  try {
    const model = defaultBackOfficeModel(); model.templateVersion = 6;
    const clients = model.objects.find(object => object.id === "clients")!;
    clients.fields.push(BackOfficeFieldSchema.parse({ id: "clientType", label: "Client type", type: "select", protected: true, options: ["Organisation", "Individual"] }));
    clients.fields.push(BackOfficeFieldSchema.parse({ id: "firmReference", label: "Firm reference", type: "text" }));
    const now = "2026-11-08T16:00:00Z", company = crypto.randomUUID();
    const client = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: "clients", ownerId: actor.userId, revision: 1, schemaRevision: 1, values: { name: "Client", clientType: "Organisation", company, firmReference: "F-42" }, createdAt: now, updatedAt: now, archivedAt: null });
    const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: "clients", name: "Clients", type: "kanban", columns: ["name", "clientType", "company"], filters: { clientType: "Organisation", firmReference: "F-42" }, widths: { clientType: 140, name: 240 }, sortField: "clientType", groupField: "clientType" });
    store.transaction(() => {
      store.db.run("INSERT INTO bo_models VALUES(?,?)", ["local", JSON.stringify(model)]);
      store.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", ["local", client.id, client.objectId, JSON.stringify(client)]);
      store.db.run("INSERT INTO bo_views VALUES(?,?,?)", ["local", view.id, JSON.stringify(view)]);
    }, { action: "fixture.clients-v6" });
    const next = store.model("local");
    expect(next.templateVersion).toBe(7);
    expect(next.objects.find(object => object.id === "clients")?.fields.some(field => field.id === "clientType")).toBe(false);
    expect(store.records("local", actor)[0].values).toEqual({ name: "Client", company, firmReference: "F-42" });
    expect(store.records("local", actor)[0].revision).toBe(2);
    expect(store.views("local")[0]).toMatchObject({ columns: ["name", "company"], filters: { firmReference: "F-42" }, widths: { name: 240 }, sortField: "name", groupField: null, type: "table" });
    expect(store.journal.evidence("local").entries.some(entry => entry.payload.entityId === client.id && JSON.stringify(entry.payload.before).includes('"clientType":"Organisation"'))).toBe(true);
    expect(store.model("local").revision).toBe(next.revision);
    expect(store.records("local", actor)[0].revision).toBe(2);
  } finally { store.close(); }
});

test("the starter needs only a person or organisation link and preserves a firm's custom client type", () => {
  const current = defaultBackOfficeModel(), clients = current.objects.find(object => object.id === "clients")!;
  expect(clients.fields.filter(field => field.type === "relation").map(field => field.target)).toEqual(["companies", "people"]);
  expect(clients.fields.some(field => field.id === "clientType")).toBe(false);
  current.templateVersion = 6;
  clients.fields.push(BackOfficeFieldSchema.parse({ id: "clientType", label: "Firm category", type: "select", options: ["Strategic", "Standard"] }));
  const next = upgradeBackOfficeModel(current);
  expect(next.objects.find(object => object.id === "clients")?.fields.find(field => field.id === "clientType")?.label).toBe("Firm category");
  const record = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: "clients", ownerId: actor.userId, revision: 1, schemaRevision: 1, values: { name: "Client", clientType: "Strategic" }, createdAt: "2026-11-08T16:00:00Z", updatedAt: "2026-11-08T16:00:00Z", archivedAt: null });
  expect(upgradeBackOfficeRecord(current, next, record)).toBe(record);
});
