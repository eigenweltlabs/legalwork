import { afterEach, expect, test } from "bun:test";
import { BackOfficeStore } from "./store.js";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeRecordSchema, defaultBackOfficeModel } from "./schema.js";
const stores: BackOfficeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const actor = { userId: "owner", model: true, edit: true, finance: true };

test("People Type is an editable select and new records have explicit active/external defaults", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:")); stores.push(store);
  const model = store.model("local"), people = model.objects.find(object => object.id === "people")!;
  people.fields.find(field => field.id === "personType")!.options.push("Research fellow");
  store.saveModel("local", actor, model, model.revision);
  const person = store.saveRecord("local", actor, { objectId: "people", revision: 0, values: { name: "New contact" } });
  expect(person.values).toMatchObject({ name: "New contact", active: true, personType: "External contact" });
  const updated = store.saveRecord("local", actor, { id: person.id, objectId: "people", revision: person.revision, values: { personType: "Research fellow", active: false } });
  expect(updated.values).toMatchObject({ personType: "Research fellow", active: false });
});

test("the preview upgrade enables Active without assigning a guessed person type or rewriting old identities", async () => {
  const store = new BackOfficeStore(await openSqlite(":memory:")); stores.push(store);
  const model = defaultBackOfficeModel(); model.templateVersion = 5;
  model.objects.find(object => object.id === "people")!.fields = model.objects.find(object => object.id === "people")!.fields.filter(field => !["active", "personType"].includes(field.id));
  const person = BackOfficeRecordSchema.parse({ id: crypto.randomUUID(), objectId: "people", values: { name: "Existing person", email: "person@example.test" }, revision: 1, schemaRevision: 1, ownerId: actor.userId, createdAt: "2026-11-08T09:00:00Z", updatedAt: "2026-11-08T09:00:00Z", archivedAt: null });
  store.transaction(() => {
    store.db.run("INSERT INTO bo_models VALUES(?,?)", ["local", JSON.stringify(model)]);
    store.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", ["local", person.id, person.objectId, JSON.stringify(person)]);
  }, { action: "fixture.people-v5" });
  expect(store.model("local").templateVersion).toBe(6);
  expect(store.records("local", actor)[0]).toMatchObject({ id: person.id, revision: 2, values: { name: "Existing person", email: "person@example.test", active: true } });
  expect(store.records("local", actor)[0].values.personType).toBeUndefined();
  expect(store.model("local").revision).toBe(2);
});
