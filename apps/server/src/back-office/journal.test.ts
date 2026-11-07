import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackOfficeStore } from "./store.js";
import { openSqlite } from "../runtime-db.js";
import {
  fileBackOfficeAuditStorage,
  memoryBackOfficeAuditStorage,
} from "./audit-storage.js";
import { defaultBackOfficeModel, type BackOfficeActor } from "./schema.js";

const owner: BackOfficeActor = {
  userId: "local",
  model: true,
  edit: true,
  finance: true,
};
const stores: BackOfficeStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const storage = memoryBackOfficeAuditStorage();
  const store = new BackOfficeStore(await openSqlite(":memory:"), storage);
  stores.push(store);
  const person = store.saveRecord("local", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Confidential client" },
  });
  return { storage, store, person };
}

test("record, relationship, model and view changes produce signed encrypted history", async () => {
  const { store, storage, person } = await fixture();
  const company = store.saveRecord("local", owner, {
    objectId: "companies",
    revision: 0,
    values: { name: "Firm" },
  });
  store.saveRecord("local", owner, {
    id: person.id,
    objectId: "people",
    revision: person.revision,
    values: { company: company.id },
  });
  const model = store.model("local");
  model.objects.find((object) => object.id === "people")!.plural = "Contacts";
  store.saveModel("local", owner, model, model.revision);
  store.saveView("local", owner, {
    id: crypto.randomUUID(),
    objectId: "people",
    name: "My view",
    columns: ["name"],
  });
  expect(store.journal.verify().locallyVerified).toBe(true);
  expect(store.history("local", owner, person.id)).toHaveLength(2);
  expect(store.history("local", owner, person.id)[0]).toMatchObject({
    actor: storage.identity.userId,
  });
  const bytes = JSON.stringify(
    store.db.all("SELECT * FROM bo_journal_entries"),
  );
  expect(bytes).not.toContain("Confidential client");
  expect(bytes).not.toContain("Contacts");
  const stream = storage.heads()[0];
  expect(
    store.journal
      .entries(stream.streamId)
      .map((entry) => entry.payload.entityType),
  ).toEqual(expect.arrayContaining(["record", "model", "view", "directory"]));
});

test("application SQL cannot update or delete accepted journal entries or bypass capture", async () => {
  const { store, person } = await fixture();
  expect(() =>
    store.db.run("UPDATE bo_journal_entries SET sealed='changed'"),
  ).toThrow("append-only");
  expect(() => store.db.run("DELETE FROM bo_journal_entries")).toThrow(
    "append-only",
  );
  expect(() => store.db.run("DELETE FROM bo_journal_streams")).toThrow(
    "immutable",
  );
  expect(() =>
    store.db.run("UPDATE bo_records SET data=? WHERE id=?", [
      JSON.stringify({ ...person, values: { name: "Unlogged" } }),
      person.id,
    ]),
  ).toThrow("audited transaction");
  expect(store.raw("local", person.id)?.values.name).toBe(
    "Confidential client",
  );
});

test("an audit-write failure rolls back both business data and queued proposals", async () => {
  const { store } = await fixture();
  const before = store.records("firm", owner);
  store.db.exec(
    "CREATE TRIGGER inject_journal_failure BEFORE INSERT ON bo_journal_entries BEGIN SELECT RAISE(ABORT,'audit disk unavailable'); END",
  );
  expect(() =>
    store.saveRecord("firm", owner, {
      objectId: "people",
      revision: 0,
      values: { name: "Must not commit" },
    }),
  ).toThrow("audit disk unavailable");
  expect(store.pending("firm")).toHaveLength(0);
  expect(store.records("firm", owner)).toEqual(before);
  expect(store.journal.verify().locallyVerified).toBe(true);
});

test("projection tampering is detected even when an administrator bypasses the SQL guard", async () => {
  const { store, person } = await fixture();
  store.db.exec("DROP TRIGGER bo_records_journal_guard_UPDATE");
  store.db.run("UPDATE bo_records SET data=? WHERE id=?", [
    JSON.stringify({
      ...person,
      values: { name: "Altered outside LegalWork" },
    }),
    person.id,
  ]);
  expect(() => store.journal.verify()).toThrow(
    "differ from their recorded history",
  );
  expect(() =>
    store.saveRecord("local", owner, {
      id: person.id,
      objectId: "people",
      revision: person.revision,
      values: { name: "Do not hide evidence" },
    }),
  ).toThrow();
  expect(store.raw("local", person.id)?.values.name).toBe(
    "Altered outside LegalWork",
  );
});

test("retiring a team cache removes readable historical payloads but preserves verifiable proofs", async () => {
  const { store, storage } = await fixture();
  const person = store.saveRecord("firm", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Restricted team client" },
  });
  const head = storage
    .heads()
    .find((head) =>
      store.journal
        .entries(head.streamId)
        .some((entry) => entry.payload.entityId === person.id),
    )!;
  store.suspendTeam("firm", "Access revoked");
  expect(storage.key(head.streamId)).toBeNull();
  expect(store.journal.entries(head.streamId)).toEqual([]);
  expect(storage.head(head.streamId)!.sequence).toBeGreaterThan(head.sequence);
  expect(store.journal.verify().locallyVerified).toBe(true);
  expect(store.pending("firm")).toHaveLength(1);
  const ciphertext = JSON.stringify(
    store.db.all("SELECT sealed FROM bo_journal_entries"),
  );
  expect(ciphertext).not.toContain("Restricted team client");
});

test("nested rollback cannot retire an otherwise valid directory", async () => {
  const { store, storage } = await fixture();
  store.saveRecord("firm", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Retained" },
  });
  const heads = storage.heads().length;
  store.transaction(() => {
    try {
      store.transaction(() => {
        store.suspendTeam("firm", "Temporary");
        throw new Error("Cancel nested operation");
      });
    } catch {
      /* The outer transaction intentionally continues. */
    }
  });
  expect(
    store.records("firm", owner).map((record) => record.values.name),
  ).toEqual(["Retained"]);
  expect(storage.heads()).toHaveLength(heads);
  expect(store.journal.verify().locallyVerified).toBe(true);
});

test("restoring an older database is rejected against its separately retained checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-audit-rollback-"));
  directories.push(root);
  const path = join(root, "runtime.sqlite");
  const directory = join(root, "audit");
  let store = new BackOfficeStore(
    await openSqlite(path),
    fileBackOfficeAuditStorage(directory, false),
  );
  const person = store.saveRecord("local", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "First revision" },
  });
  store.close();
  await copyFile(path, join(root, "older.sqlite"));
  store = new BackOfficeStore(
    await openSqlite(path),
    fileBackOfficeAuditStorage(directory, true),
  );
  store.saveRecord("local", owner, {
    id: person.id,
    objectId: "people",
    revision: person.revision,
    values: { name: "Second revision" },
  });
  store.close();
  await copyFile(join(root, "older.sqlite"), path);
  const db = await openSqlite(path);
  try {
    expect(
      () =>
        new BackOfficeStore(db, fileBackOfficeAuditStorage(directory, true)),
    ).toThrow("truncated or replaced");
  } finally {
    db.close();
  }
});

test("legacy history is captured as a dated encrypted baseline without inventing retrospective verification", async () => {
  const db = await openSqlite(":memory:");
  db.exec(
    "CREATE TABLE bo_models(scope TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE bo_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,record_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)",
  );
  db.run("INSERT INTO bo_models VALUES('local',?)", [
    JSON.stringify(defaultBackOfficeModel()),
  ]);
  db.run(
    "INSERT INTO bo_audit(scope,actor,action,record_id,data,created_at) VALUES('local','old-lawyer','record.update','model',?,?)",
    [
      JSON.stringify({
        before: { name: "Historical private content" },
        after: { name: "Changed" },
      }),
      "2024-01-01T00:00:00.000Z",
    ],
  );
  const storage = memoryBackOfficeAuditStorage();
  const store = new BackOfficeStore(db, storage);
  stores.push(store);
  expect(store.history("local", owner, "model")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: "old-lawyer",
        legacy: true,
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ]),
  );
  expect(db.all("SELECT * FROM bo_audit")).toEqual([]);
  expect(
    JSON.stringify(db.all("SELECT * FROM bo_journal_entries")),
  ).not.toContain("Historical private content");
  const entries = store.journal.entries(storage.heads()[0].streamId);
  expect(entries[0].payload.action).toBe("directory.baseline");
  expect(entries[0].payload.recordedAt).not.toBe("2024-01-01T00:00:00.000Z");
  expect(JSON.stringify(entries[0].payload.after)).toContain(
    "Historical private content",
  );
  expect(() =>
    db.run(
      "INSERT INTO bo_audit(scope,actor,action,record_id,data,created_at) VALUES('local','fake','record.update','model','{}','2020')",
    ),
  ).toThrow("immutable");
});

test("agent and user attribution follows nested writes and their queued changes", async () => {
  const { store, storage } = await fixture();
  const agent = { ...owner, userId: "lawyer-a", agentId: "review-agent" };
  const user = { ...owner, userId: "lawyer-b" };
  let first = "",
    second = "";
  store.transaction(() => {
    first = store.saveRecord("firm", agent, {
      objectId: "companies",
      revision: 0,
      values: { name: "Agent-created" },
    }).id;
    second = store.saveRecord("firm", user, {
      objectId: "companies",
      revision: 0,
      values: { name: "User-created" },
    }).id;
  });
  const entries = storage
    .heads()
    .flatMap((head) => store.journal.entries(head.streamId));
  const agentEntries = entries.filter(
    (entry) =>
      entry.payload.entityId === first ||
      (entry.payload.entityType === "proposal" &&
        JSON.stringify(entry.payload.after).includes(first)),
  );
  const userEntries = entries.filter(
    (entry) =>
      entry.payload.entityId === second ||
      (entry.payload.entityType === "proposal" &&
        JSON.stringify(entry.payload.after).includes(second)),
  );
  expect(agentEntries).toHaveLength(2);
  expect(userEntries).toHaveLength(2);
  expect(
    agentEntries.every(
      (entry) =>
        entry.payload.actor.id === "lawyer-a" &&
        entry.payload.actor.agentId === "review-agent",
    ),
  ).toBe(true);
  expect(
    userEntries.every(
      (entry) =>
        entry.payload.actor.id === "lawyer-b" &&
        entry.payload.actor.agentId === null,
    ),
  ).toBe(true);
});
