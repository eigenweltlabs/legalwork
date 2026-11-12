import { afterEach, expect, test } from "bun:test";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { memoryBackOfficeAuditStorage } from "./audit-storage.js";
import { z, BackOfficeRecordSchema, defaultBackOfficeModel, type BackOfficeActor, type BackOfficeRecord, type BackOfficeSnapshot } from "./schema.js";

const editor: BackOfficeActor = { userId: "lawyer", model: true, edit: true, finance: true };
const basic = { ...editor, finance: false };
const stores: BackOfficeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const snapshot = (records: BackOfficeRecord[], accepted: string[] = []): BackOfficeSnapshot => ({ protocol: 1, model: defaultBackOfficeModel(), records, views: [], cursor: 1, accepted, conflicts: [] });

async function fixture() {
  const storage = memoryBackOfficeAuditStorage();
  const store = new BackOfficeStore(await openSqlite(":memory:"), storage);
  stores.push(store);
  const created = store.saveRecord("firm", editor, { objectId: "companies", revision: 0, sourceId: "copied-source-reference", values: { name: "Copied client name", vatId: "Confidential tax reference", email: "old@example.test" }, access: "members", members: [editor.userId, "copied-member"] });
  const remote = { ...created, ownerId: "another-lawyer" };
  store.receive("firm", snapshot([remote], [store.pending("firm")[0].change.id]), editor);
  const head = storage.heads().at(-1)!;
  return { store, storage, remote, head };
}

test("queued edits keep actual changes without copied record values or unchanged sharing metadata", async () => {
  const { store, remote } = await fixture();
  store.saveRecord("firm", editor, { ...remote, values: { ...remote.values, email: "authored@example.test" } });
  const change = store.pending("firm")[0].change;
  expect(change.changedFields).toEqual(["email"]);
  expect(change.changedMetadata).toEqual([]);
  const proposed = BackOfficeRecordSchema.parse(change.data);
  expect(proposed.values).toEqual({ email: "authored@example.test" });
  expect(proposed.sourceId).toBeUndefined();
  expect(proposed.members).toEqual([]);
  expect(JSON.stringify(change)).not.toContain("Copied client name");
  expect(JSON.stringify(change)).not.toContain("Confidential tax reference");
});

test("field revocation replaces cached values, erases the old history key and preserves permitted authored work", async () => {
  const { store, storage, remote, head } = await fixture();
  store.saveRecord("firm", editor, { ...remote, values: { email: "authored@example.test" } });
  const values = { ...remote.values };
  delete values.vatId;
  store.receive("firm", snapshot([{ ...remote, values }]), basic);
  expect(store.raw("firm", remote.id)?.values).toEqual({ name: "Copied client name", email: "authored@example.test" });
  expect(storage.key(head.streamId)).toBeNull();
  expect(storage.head(head.streamId)!.sequence).toBeGreaterThan(head.sequence);
  expect(store.journal.entries(head.streamId)).toEqual([]);
  expect(store.pending("firm")[0].change.changedFields).toEqual(["email"]);
  expect(store.raw("firm", remote.id)?.revision).toBe(2);
  store.saveRecord("firm", basic, { id: remote.id, objectId: remote.objectId, revision: 2, values: { name: "Authored new name" } });
  expect(store.pending("firm").map(entry => entry.change.baseRevision)).toEqual([1, 2]);
  expect(store.queuedRecordIntent("firm", store.pending("firm")[0].change.id).record.values).toEqual({ email: "authored@example.test", name: "Authored new name" });
  const readable = storage.heads().flatMap(head => store.journal.entries(head.streamId));
  expect(JSON.stringify(readable)).not.toContain("Confidential tax reference");
  expect(store.checkIntegrity().locallyVerified).toBe(true);
  const count = readable.length;
  store.restrictTeamAccess("firm", basic);
  expect(storage.heads().flatMap(head => store.journal.entries(head.streamId))).toHaveLength(count);
});

test("record revocation removes the replica and retains only the user's authored proposal", async () => {
  const { store, storage, remote, head } = await fixture();
  store.saveRecord("firm", editor, { ...remote, values: { email: "authored@example.test" } });
  store.receive("firm", snapshot([]), basic);
  expect(store.raw("firm", remote.id)).toBeNull();
  const pending = store.pending("firm")[0];
  expect(pending.error).toContain("Access changed");
  expect(BackOfficeRecordSchema.parse(pending.change.data).values).toEqual({ email: "authored@example.test" });
  expect(JSON.stringify(pending)).not.toContain("Copied client name");
  expect(JSON.stringify(pending)).not.toContain("Confidential tax reference");
  expect(JSON.stringify(pending)).not.toContain("copied-source-reference");
  expect(storage.key(head.streamId)).toBeNull();
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("current field policies scrub saved views and pending selection criteria before history is re-baselined", async () => {
  const { store, storage, head } = await fixture();
  store.saveView("firm", editor, { id: crypto.randomUUID(), objectId: "companies", name: "My view", columns: ["name", "vatId"], filters: { vatId: "Secret filter" }, query: "Secret search", sortField: "vatId" });
  store.restrictTeamAccess("firm", basic);
  const view = store.views("firm")[0];
  expect(view.filters).toEqual({});
  expect(view.query).toBe("");
  expect(view.columns).toEqual(["name"]);
  expect(view.sortField).toBe("name");
  expect(JSON.stringify(store.pending("firm"))).not.toContain("Secret filter");
  expect(JSON.stringify(store.pending("firm"))).not.toContain("Secret search");
  expect(storage.key(head.streamId)).toBeNull();
  expect(store.checkIntegrity().locallyVerified).toBe(true);
});

test("complete disconnection removes copied fields and blocks remaining authored work", async () => {
  const { store, storage, remote, head } = await fixture();
  store.saveRecord("firm", editor, { ...remote, values: { ...remote.values, email: "authored@example.test" } });
  store.suspendTeam("firm", "Membership removed");
  expect(store.raw("firm", remote.id)).toBeNull();
  const pending = store.pending("firm")[0];
  expect(pending.error).toBe("Membership removed");
  expect(BackOfficeRecordSchema.parse(pending.change.data).values).toEqual({ email: "authored@example.test" });
  expect(JSON.stringify(pending)).not.toContain("Copied client name");
  expect(JSON.stringify(pending)).not.toContain("Confidential tax reference");
  expect(storage.key(head.streamId)).toBeNull();
  expect(store.checkIntegrity().locallyVerified).toBe(true);
  const retained = JSON.stringify(store.pending("firm"));
  const checkpoints = storage.heads();
  store.suspendTeam("firm", "Membership removed");
  expect(JSON.stringify(store.pending("firm"))).toBe(retained);
  expect(storage.heads()).toEqual(checkpoints);
});

test("authored source and sharing changes survive a later separate field edit in conflict review", async () => {
  const { store, remote } = await fixture();
  const updated = store.saveRecord("firm", editor, { ...remote, sourceId: "authored-source", access: "org", members: [], values: {} });
  const operation = store.pending("firm")[0].change.id;
  expect(store.pending("firm")[0].change.changedMetadata).toEqual(["sourceId", "sharing"]);
  store.saveRecord("firm", editor, { ...updated, values: { email: "authored@example.test" } });
  const intent = store.queuedRecordIntent("firm", operation);
  expect(intent.metadata).toEqual(["sourceId", "sharing"]);
  expect(intent.record).toMatchObject({ sourceId: "authored-source", access: "org", members: [], values: { email: "authored@example.test" } });
});

test("record edits and archive merge independent revisions and preserve competing values", async () => {
  const { store, remote } = await fixture();
  const patch = (values: BackOfficeRecord["values"], expectedValues: BackOfficeRecord["values"], archived?: boolean) =>
    store.saveRecord("firm", editor, { id: remote.id, objectId: remote.objectId, revision: remote.revision, values, expectedValues, archived });
  const renamed = patch({ name: "New name" }, { name: remote.values.name });
  const email = patch({ email: "new@example.test" }, { email: remote.values.email });
  expect(email.values.name).toBe("New name");
  expect(email.revision).toBe(renamed.revision + 1);
  expect(() => patch({ name: "Competing" }, { name: remote.values.name })).toThrow("same field");
  const archived = patch({}, {}, true);
  expect(archived.values.email).toBe("new@example.test");
  expect(patch({}, {}, true).revision).toBe(archived.revision);
  expect(store.pending("firm").map(entry => entry.change.baseRevision)).toEqual([remote.revision, renamed.revision, email.revision]);
});

test("sync resubmits independent edits from the server revision and holds a competing field", async () => {
  const { store, remote } = await fixture();
  store.saveRecord("firm", editor, { id: remote.id, objectId: remote.objectId, revision: remote.revision, values: { email: "mine@example.test" } });
  const operation = store.pending("firm")[0].change.id;
  const reject = (revision: number, values: BackOfficeRecord["values"]) => store.receive("firm", {
    ...snapshot([{ ...remote, revision, values: { ...remote.values, ...values } }]),
    conflicts: [{ id: operation, message: "The record changed on another device." }],
  }, editor);
  store.restrictTeamAccess("firm", editor);
  reject(2, { name: "Updated elsewhere" });
  expect(store.pending("firm")[0].error).toBeNull();
  expect(store.pending("firm")[0].change.baseRevision).toBe(2);
  expect(store.raw("firm", remote.id)?.values.email).toBe("mine@example.test");
  reject(3, { email: "theirs@example.test" });
  expect(store.pending("firm")[0].error).toBeTruthy();
  expect(store.raw("firm", remote.id)?.values.email).toBe("theirs@example.test");
});

test("independent client selections converge across pending local clicks and a concurrent team edit", async () => {
  const { store, remote } = await fixture();
  const create = (objectId: string, name: string) => store.saveRecord("firm", editor, { objectId, revision: 0, values: { name } });
  const clients = ["Existing", "First click", "Other device", "Second click"].map(name => create("clients", name));
  const [existing, first, other, second] = clients.map(record => record.id);
  const matter = create("matters", "Matter");
  const baseline = { ...matter, values: { ...matter.values, clients: [existing] } };
  const others = [remote, ...clients];
  store.receive("firm", snapshot([...others, baseline], store.pending("firm").map(row => row.change.id)), editor);
  const click = (before: string[], after: string[]) => store.saveRecord("firm", editor, { id: matter.id, objectId: "matters",
    revision: baseline.revision, expectedValues: { clients: before }, values: { clients: after } });
  click([existing], [existing, first]);
  click([existing, first], [first, second]);
  const [one, two] = store.pending("firm").map(row => row.change.id);
  const team = { ...baseline, revision: 2, values: { ...baseline.values, clients: [existing, other] } };
  const rejected = (id: string) => [{ id, message: "Concurrent edit" }];
  store.receive("firm", { ...snapshot([...others, team]), conflicts: rejected(one) }, editor);
  expect(new Set(z.array(z.string()).parse(store.raw("firm", matter.id)?.values.clients))).toEqual(new Set([first, second, other]));
  const acknowledged = { ...team, revision: 3, values: { ...team.values, clients: [existing, other, first] } };
  store.receive("firm", { ...snapshot([...others, acknowledged], [one]), conflicts: rejected(two) }, editor);
  const [remaining] = store.pending("firm");
  expect(remaining.error).toBeNull();
  expect(remaining.change.baseRevision).toBe(3);
  const next = BackOfficeRecordSchema.parse(remaining.change.data);
  expect(new Set(z.array(z.string()).parse(next.values.clients))).toEqual(new Set([first, second, other]));
  store.receive("firm", snapshot([...others, { ...acknowledged, revision: 4, values: { ...acknowledged.values, ...next.values } }], [two]), editor);
  expect(store.pending("firm")).toHaveLength(0);
});
