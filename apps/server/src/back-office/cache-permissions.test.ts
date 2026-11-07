import { afterEach, expect, test } from "bun:test";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { memoryBackOfficeAuditStorage } from "./audit-storage.js";
import { BackOfficeRecordSchema, defaultBackOfficeModel, type BackOfficeActor, type BackOfficeRecord, type BackOfficeSnapshot } from "./schema.js";

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
