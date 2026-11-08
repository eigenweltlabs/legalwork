import { afterEach, expect, test } from "bun:test";
import { BackOfficeRecordSchema, BackOfficeViewSchema, defaultBackOfficeModel, upgradeBackOfficeModel } from "./schema.js";
import { BackOfficeStore } from "./store.js";
import { openSqlite } from "../runtime-db.js";

const stores: BackOfficeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function legacyModel() {
  const model = defaultBackOfficeModel();
  model.templateVersion = 4;
  for (const object of model.objects) {
    if (object.id === "companies") {
      object.label = "Company"; object.plural = "Companies"; object.icon = "company";
      object.fields = object.fields.filter(field => field.id !== "organisationType");
    }
    if (object.id === "clients") object.fields.push({ ...object.fields[0], id: "clientType", label: "Client type", type: "select", required: false, options: ["Company", "Individual"] });
    for (const field of object.fields) {
      if (field.id === "company" && field.target === "companies") field.label = "Company";
      if (object.id === "clients" && field.id === "clientType") field.options = ["Company", "Individual"];
    }
  }
  return model;
}

test("the starter covers courts, authorities and firms as organisations while preserving customized names on upgrade", () => {
  const model = defaultBackOfficeModel(), organisation = model.objects.find(object => object.id === "companies");
  expect(organisation).toMatchObject({ label: "Organisation", plural: "Organisations" });
  expect(organisation?.fields.find(field => field.id === "organisationType")?.options).toEqual(["Company", "Court", "Public authority", "Law firm", "Association / nonprofit", "Other"]);
  const old = legacyModel();
  old.objects.find(object => object.id === "companies")!.plural = "Our institutions";
  const next = upgradeBackOfficeModel(old);
  expect(next.objects.find(object => object.id === "companies")).toMatchObject({ label: "Organisation", plural: "Our institutions" });
  expect(next.objects.find(object => object.id === "people")?.fields.find(field => field.id === "company")?.label).toBe("Organisation");
  expect(old.objects.find(object => object.id === "companies")?.label).toBe("Company");
});

test("a stored preview removes redundant client classification atomically without breaking organisation links", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:")); stores.push(store);
  const model = legacyModel(), now = "2026-11-07T12:00:00Z";
  const organisation = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: "companies", values: { name: "District Court" }, revision: 1, schemaRevision: 1, ownerId: "owner", createdAt: now, updatedAt: now, archivedAt: null });
  const client = BackOfficeRecordSchema.parse({ ...organisation, id: crypto.randomUUID(), objectId: "clients", values: { name: "Public client", company: organisation.id, clientType: "Company" } });
  const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: "clients", name: "Organisations", columns: ["name", "clientType"], filters: { clientType: "Company" } });
  store.transaction(() => {
    store.db.run("INSERT INTO bo_models VALUES(?,?)", ["local", JSON.stringify(model)]);
    for (const record of [organisation, client]) store.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", ["local", record.id, record.objectId, JSON.stringify(record)]);
    store.db.run("INSERT INTO bo_views VALUES(?,?,?)", ["local", view.id, JSON.stringify(view)]);
  }, { action: "fixture.preview-v4" });
  expect(store.model("local").templateVersion).toBe(7);
  const actor = { userId: "owner", edit: true, model: true, finance: true };
  expect(store.records("local", actor).find(record => record.id === client.id)).toMatchObject({ revision: 2, values: { company: organisation.id } });
  expect(store.records("local", actor).find(record => record.id === client.id)?.values.clientType).toBeUndefined();
  expect(store.records("local", actor).find(record => record.id === organisation.id)?.revision).toBe(1);
  expect(store.views("local")[0].filters).toEqual({});
  expect(store.views("local")[0].columns).toEqual(["name"]);
  expect(store.model("local").revision).toBe(2);
  expect(store.records("local", actor).find(record => record.id === client.id)?.revision).toBe(2);
});
