import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackOfficeStore } from "./store.js";
import { openSqlite } from "../runtime-db.js";
import {
  openBackOfficeAuditStorage,
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
  const run = store.db.run;
  const failure = spyOn(store.db, "run").mockImplementation((sql, params) => {
    if (sql.startsWith("INSERT INTO bo_journal_entries"))
      throw new Error("audit disk unavailable");
    run(sql, params);
  });
  try {
    expect(() =>
      store.saveRecord("firm", owner, {
        objectId: "people",
        revision: 0,
        values: { name: "Must not commit" },
      }),
    ).toThrow("audit disk unavailable");
  } finally {
    failure.mockRestore();
  }
  expect(store.pending("firm")).toHaveLength(0);
  expect(store.records("firm", owner)).toEqual(before);
  expect(store.journal.verify().locallyVerified).toBe(true);
});

test("projection tampering is detected even when an administrator bypasses the SQL guard", async () => {
  const { store, person } = await fixture();
  const guard = String(
    store.db.get(
      "SELECT sql FROM sqlite_master WHERE name='bo_records_journal_guard_UPDATE'",
    )!.sql,
  );
  store.db.exec("DROP TRIGGER bo_records_journal_guard_UPDATE");
  store.db.run("UPDATE bo_records SET data=? WHERE id=?", [
    JSON.stringify({
      ...person,
      values: { name: "Altered outside LegalWork" },
    }),
    person.id,
  ]);
  store.db.exec(guard);
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
    await openBackOfficeAuditStorage(directory, false),
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
    await openBackOfficeAuditStorage(directory, true),
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
  const restoredStorage = await openBackOfficeAuditStorage(directory, true);
  try {
    expect(() => new BackOfficeStore(db, restoredStorage)).toThrow(
      "truncated or replaced",
    );
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

test("removed and altered SQL guards block reads and are not silently recreated", async () => {
  for (const sql of [
    "DROP TRIGGER bo_records_journal_guard_UPDATE",
    "DROP TRIGGER bo_records_journal_guard_UPDATE; CREATE TRIGGER bo_records_journal_guard_UPDATE BEFORE UPDATE ON bo_records BEGIN SELECT 1; END",
    "CREATE TRIGGER unexpected_audit_write AFTER INSERT ON bo_records BEGIN SELECT 1; END",
    "DELETE FROM bo_migrations WHERE version=2",
  ]) {
    const { store, storage } = await fixture();
    store.db.exec(sql);
    if (sql.startsWith("DELETE")) {
      expect(() => store.checkIntegrity()).toThrow("migration evidence");
      expect(() => new BackOfficeStore(store.db, storage)).toThrow(
        "migration evidence",
      );
    } else {
      expect(() => store.checkIntegrity()).toThrow("audit security trigger");
      expect(() => new BackOfficeStore(store.db, storage)).toThrow(
        "audit security trigger",
      );
    }
    if (sql === "DROP TRIGGER bo_records_journal_guard_UPDATE")
      expect(
        store.db.get(
          "SELECT name FROM sqlite_master WHERE name='bo_records_journal_guard_UPDATE'",
        ),
      ).toBeUndefined();
  }
});

test("cached verification detects independent database, key and checkpoint changes", async () => {
  const { store, storage } = await fixture();
  expect(store.checkIntegrity().locallyVerified).toBe(true);
  const key = spyOn(storage, "key").mockImplementation(() =>
    Buffer.alloc(32, 42),
  );
  try {
    expect(() => store.checkIntegrity()).toThrow();
  } finally {
    key.mockRestore();
  }
  expect(store.checkIntegrity().locallyVerified).toBe(true);
  const head = storage.heads()[0];
  storage.checkpoint({ ...head, sequence: head.sequence + 1 });
  expect(() => store.checkIntegrity()).toThrow("truncated or replaced");
});

test("a checkpoint changed while persistence runs cannot be admitted to the verification cache", async () => {
  const { store, storage } = await fixture();
  const checkpoint = storage.checkpoint;
  const corrupt = spyOn(storage, "checkpoint").mockImplementation((head) => {
    checkpoint({ ...head, sequence: head.sequence + 1 });
  });
  try {
    expect(() =>
      store.saveRecord("local", owner, {
        objectId: "people",
        revision: 0,
        values: { name: "Committed but checkpoint damaged" },
      }),
    ).toThrow("checkpoints changed during persistence");
  } finally {
    corrupt.mockRestore();
  }
  expect(() => store.checkIntegrity()).toThrow();
});

test("a failed checkpoint blocks further writes and a valid committed extension survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-audit-checkpoint-"));
  directories.push(root);
  const path = join(root, "runtime.sqlite");
  const directory = join(root, "audit");
  const storage = await openBackOfficeAuditStorage(directory, false);
  const store = new BackOfficeStore(await openSqlite(path), storage);
  const person = store.saveRecord("local", owner, {
    objectId: "people",
    revision: 0,
    values: { name: "Before" },
  });
  const head = storage.heads()[0];
  const failure = spyOn(storage, "checkpoint").mockImplementation(() => {
    throw new Error("checkpoint volume unavailable");
  });
  try {
    expect(() =>
      store.saveRecord("local", owner, {
        id: person.id,
        objectId: "people",
        revision: person.revision,
        values: { name: "After" },
      }),
    ).toThrow("checkpoint volume unavailable");
    expect(() =>
      store.saveRecord("local", owner, {
        objectId: "people",
        revision: 0,
        values: { name: "Unsecured" },
      }),
    ).toThrow("checkpoint volume unavailable");
    expect(storage.head(head.streamId)).toEqual(head);
  } finally {
    failure.mockRestore();
    store.close();
  }
  const reopenedStorage = await openBackOfficeAuditStorage(directory, true);
  const reopened = new BackOfficeStore(await openSqlite(path), reopenedStorage);
  stores.push(reopened);
  expect(reopened.raw("local", person.id)?.values.name).toBe("After");
  expect(reopenedStorage.head(head.streamId)!.sequence).toBeGreaterThan(
    head.sequence,
  );
  expect(reopened.checkIntegrity().locallyVerified).toBe(true);
});

test("independent processes serialize the business commit and durable checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-audit-processes-"));
  directories.push(root);
  const storage = await openBackOfficeAuditStorage(join(root, "audit"), false);
  const initial = new BackOfficeStore(
    await openSqlite(join(root, "runtime.sqlite")),
    storage,
  );
  initial.model("local");
  initial.close();
  const script = fileURLToPath(
    new URL("./journal-process.fixture.ts", import.meta.url),
  );
  const first = Bun.spawn(
    [process.execPath, script, root, "First writer", "pause"],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(join(root, "checkpoint-gap")) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(existsSync(join(root, "checkpoint-gap"))).toBe(true);
    const second = Bun.spawn(
      [process.execPath, script, root, "Second writer"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const outcomes = await Promise.all([
      first.exited,
      second.exited,
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ]);
    expect(outcomes).toEqual([0, 0, "", ""]);
  } finally {
    first.kill();
  }
  const final = new BackOfficeStore(
    await openSqlite(join(root, "runtime.sqlite")),
    await openBackOfficeAuditStorage(join(root, "audit"), true),
  );
  stores.push(final);
  expect(
    final
      .records("local", owner)
      .map((record) => record.values.name)
      .sort(),
  ).toEqual(["First writer", "Second writer"]);
  expect(final.checkIntegrity().locallyVerified).toBe(true);
}, 10000);
