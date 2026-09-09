import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";
import { MAIL_SCHEMA_VERSION, migrateMailSchema } from "./schema.js";
import { MailRepository } from "./repository.js";

/** TEST ONLY: in-memory stock SQLite. Never exported as a production factory. */
function testDatabase(): MailDatabase {
  const sqlite = new Database(":memory:");
  const row = z.record(z.string(), z.unknown());
  return {
    exec(sql) { sqlite.exec(sql); },
    run(sql, parameters = []) { return sqlite.query(sql).run(...parameters); },
    get(sql, parameters = []) { const value = sqlite.query(sql).get(...parameters); return value === null ? undefined : row.parse(value); },
    all(sql, parameters = []) { return sqlite.query(sql).all(...parameters).map(value => row.parse(value)); },
    transaction<T>(body: () => T): T {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Synchronous transaction required");
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    close() { sqlite.close(); },
  };
}
function setup(run: (db: MailDatabase, repository: MailRepository) => void) {
  const db = testDatabase();
  try { migrateMailSchema(db); run(db, new MailRepository(db, "owner-a")); } finally { db.close(); }
}
const gmail = (messageId: string): ProviderMessageLocator => ({ provider: "gmail", messageId });
const reference = { id: "blob-one", bytes: 15, sha256: "a".repeat(64) };
function seed(repository: MailRepository) {
  repository.createAccount({ id: "a", provider: "gmail", displayName: "Synthetic" });
  repository.putFolder("a", { id: "inbox", name: "Inbox", kind: "label" });
  repository.putFolder("a", { id: "contracts", name: "Verträge", kind: "label" });
}
function ingest(repository: MailRepository, messageId = "one") {
  repository.ingestMessage("a", { locator: gmail(messageId), rfcMessageId: "<duplicate@example.invalid>", subject: "Prüfung", memberships: ["inbox", "contracts"] });
}

describe("versioned mail schema", () => {
  test("migration is atomic and idempotent and preserves existing data", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    const before = db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name");
    migrateMailSchema(db);
    expect(db.all("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(before);
    expect(db.all("SELECT * FROM mail_schema_version")).toEqual([{ singleton: 1, version: MAIL_SCHEMA_VERSION }]);
    expect(repository.readMessage("a", gmail("one"))?.subject).toBe("Prüfung");
  }));
  test("failed migration rolls back all DDL and may retry", () => {
    const db = testDatabase();
    let fail = true;
    const faulty: MailDatabase = { ...db, exec(sql) { db.exec(sql); if (fail && sql.includes("CREATE TABLE mail_accounts")) throw new Error("injected migration failure"); } };
    try {
      expect(() => migrateMailSchema(faulty)).toThrow("injected migration failure");
      expect(db.all("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
      fail = false;
      migrateMailSchema(faulty);
      expect(db.get("SELECT version FROM mail_schema_version")?.version).toBe(MAIL_SCHEMA_VERSION);
    } finally { db.close(); }
  });
  test("newer version is rejected without deleting or downgrading anything", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    db.run("UPDATE mail_schema_version SET version=?", [MAIL_SCHEMA_VERSION + 1]);
    expect(() => migrateMailSchema(db)).toThrow("Unsupported mail schema version");
    expect(db.get("SELECT version FROM mail_schema_version")?.version).toBe(MAIL_SCHEMA_VERSION + 1);
    expect(repository.readMessage("a", gmail("one"))?.subject).toBe("Prüfung");
  }));
});

describe("owned canonical mail repository", () => {
  test("duplicate RFC IDs/hashes remain distinct and Gmail labels share one content reference", () => setup((db, repository) => {
    seed(repository);
    for (const messageId of ["one", "two"]) {
      ingest(repository, messageId);
      repository.putContent("a", gmail(messageId), { kind: "raw", state: "stored", reference });
    }
    expect(db.get("SELECT count(*) AS count FROM mail_messages")?.count).toBe(2);
    expect(db.get("SELECT count(*) AS count FROM mail_content_refs")?.count).toBe(1);
    expect(db.get("SELECT count(*) AS count FROM mail_memberships")?.count).toBe(4);
    expect(repository.readMessage("a", gmail("one"))?.memberships).toEqual(["contracts", "inbox"]);
    repository.ingestMessage("a", { locator: gmail("one"), rfcMessageId: null, subject: "Updated", memberships: ["contracts", "contracts"] });
    expect(repository.readMessage("a", gmail("one"))?.content[0]?.ref_id).toBe("blob-one");
    expect(repository.readMessage("a", gmail("one"))?.memberships).toEqual(["contracts"]);
    expect(repository.readMessage("a", gmail("one"))?.rfc_message_id).toBeNull();
  }));
  test("ownership and account-composite foreign keys reject cross-account links", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    const other = new MailRepository(db, "owner-b");
    other.createAccount({ id: "b", provider: "gmail", displayName: "Other" });
    other.putFolder("b", { id: "private-b", name: "Private", kind: "label" });
    other.ingestMessage("b", { locator: gmail("one"), rfcMessageId: null, subject: "Other account", memberships: ["private-b"] });
    expect(repository.listAccounts().map(account => account.id)).toEqual(["a"]);
    expect(() => repository.readMessage("b", gmail("one"))).toThrow("Mail account not found");
    expect(() => other.putContent("a", gmail("one"), { kind: "raw", state: "stored", reference })).toThrow("Mail account not found");
    expect(() => db.run("INSERT INTO mail_memberships VALUES(?,?,?)", ["a", providerMessageKey(gmail("one")), "private-b"])).toThrow();
    expect(() => repository.putFolder("a", { id: "child", name: "Child", kind: "folder", parentId: "private-b" })).toThrow();
    expect(other.readMessage("b", gmail("one"))?.subject).toBe("Other account");
  }));
  test("content, threads and nested folders cannot reference another account", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    repository.createAccount({ id: "b", provider: "gmail", displayName: "B" });
    repository.putFolder("b", { id: "b-folder", name: "B", kind: "label" });
    repository.ingestMessage("b", { locator: gmail("one"), rfcMessageId: null, subject: "B", memberships: ["b-folder"], threadId: "b-thread" });
    repository.putContent("b", gmail("one"), { kind: "raw", state: "stored", reference: { ...reference, id: "b-blob" } });
    expect(() => db.run("UPDATE mail_messages SET thread_id=? WHERE account_id=?", ["b-thread", "a"])).toThrow();
    expect(() => db.run("INSERT INTO mail_content_manifests VALUES(?,?,?,?,?,?)", ["a", providerMessageKey(gmail("one")), "raw", "", "stored", "b-blob"])).toThrow();
    repository.putFolder("a", { id: "child", name: "Child", kind: "folder", parentId: "inbox" });
    expect(() => repository.putFolder("a", { id: "inbox", name: "Inbox", kind: "label", parentId: "child" })).toThrow("cycle");
  }));
  test("IMAP UIDVALIDITY changes, copies and moves create distinct identities", () => setup((db, repository) => {
    repository.createAccount({ id: "imap", provider: "imap", displayName: "IMAP" });
    for (const folder of ["inbox", "archive"]) repository.putFolder("imap", { id: folder, name: folder, kind: "folder" });
    const locators: ProviderMessageLocator[] = [
      { provider: "imap", mailboxId: "inbox", uidValidity: 1, uid: 7 },
      { provider: "imap", mailboxId: "inbox", uidValidity: 2, uid: 7 },
      { provider: "imap", mailboxId: "archive", uidValidity: 1, uid: 7 },
      { provider: "imap", mailboxId: "inbox", uidValidity: 1, uid: 8 },
    ];
    for (const locator of locators) {
      if (locator.provider !== "imap") throw new Error("Invalid test locator");
      repository.ingestMessage("imap", { locator, rfcMessageId: "same", subject: "same", memberships: [locator.mailboxId] });
    }
    expect(db.get("SELECT count(*) AS count FROM mail_messages")?.count).toBe(4);
    expect(() => repository.ingestMessage("imap", { locator: locators[0]!, rfcMessageId: null, subject: "wrong folder", memberships: ["archive"] })).toThrow("own mailbox");
    expect(() => repository.ingestMessage("imap", { locator: gmail("one"), rfcMessageId: null, subject: "wrong provider", memberships: ["inbox"] })).toThrow("Provider identity");
  }));
  test("invalid membership rolls back metadata, membership snapshot and new thread", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    expect(() => repository.ingestMessage("a", { locator: gmail("one"), rfcMessageId: null, subject: "Must rollback", memberships: ["missing"], threadId: "new-thread" })).toThrow();
    expect(repository.readMessage("a", gmail("one"))?.subject).toBe("Prüfung");
    expect(repository.readMessage("a", gmail("one"))?.memberships).toEqual(["contracts", "inbox"]);
    expect(db.get("SELECT count(*) AS count FROM mail_threads")?.count).toBe(0);
  }));
  test("content completeness requires raw, body, enumerated attachments and all stored parts", () => setup((_, repository) => {
    seed(repository); ingest(repository);
    const read = () => repository.readMessage("a", gmail("one"));
    expect(read()?.contentState).toBe("downloading");
    for (const kind of ["raw", "body"]) {
      if (kind !== "raw" && kind !== "body") throw new Error("Invalid test kind");
      repository.putContent("a", gmail("one"), { kind, state: "stored", reference });
    }
    expect(read()?.contentState).toBe("downloading");
    repository.putContent("a", gmail("one"), { kind: "attachment", partId: "part-1", state: "pending" });
    repository.setAttachmentsEnumerated("a", gmail("one"), true);
    expect(read()?.contentState).toBe("downloading");
    repository.putContent("a", gmail("one"), { kind: "attachment", partId: "part-1", state: "unavailable" });
    expect(read()?.contentState).toBe("attention");
    repository.putContent("a", gmail("one"), { kind: "attachment", partId: "part-1", state: "stored", reference });
    expect(read()?.contentState).toBe("complete");
    repository.setAttachmentsEnumerated("a", gmail("one"), false);
    expect(read()?.contentState).toBe("downloading");
  }));
  test("manifest failures do not leave orphan references or mutate existing durable refs", () => setup((db, repository) => {
    seed(repository); ingest(repository);
    expect(() => repository.putContent("a", gmail("missing"), { kind: "raw", state: "stored", reference })).toThrow();
    expect(db.get("SELECT count(*) AS count FROM mail_content_refs")?.count).toBe(0);
    repository.putContent("a", gmail("one"), { kind: "raw", state: "stored", reference });
    expect(() => repository.putContent("a", gmail("one"), { kind: "raw", state: "stored", reference: { ...reference, bytes: 16 } })).toThrow("cannot change");
    expect(() => repository.putContent("a", gmail("one"), { kind: "raw", state: "stored" })).toThrow();
    expect(repository.readMessage("a", gmail("one"))?.content[0]?.bytes).toBe(15);
  }));
  test("opaque SQL-shaped IDs and maximal provider IDs are values, not SQL", () => setup((_, repository) => {
    seed(repository);
    for (const messageId of ["'; DROP TABLE mail_accounts; --", "x".repeat(4096)]) {
      ingest(repository, messageId);
      expect(repository.readMessage("a", gmail(messageId))?.subject).toBe("Prüfung");
    }
    expect(repository.listAccounts()).toHaveLength(1);
  }));
});

describe("bounded owner-scoped mailbox pagination", () => {
  test("pages accounts and folders without crossing owners or skipping rows", () => setup((db, repository) => {
    const other = new MailRepository(db, "owner-b");
    other.createAccount({ id: "foreign", provider: "graph", displayName: "Private" });
    for (const id of ["a", "b", "c"]) repository.createAccount({ id, provider: "gmail", displayName: id });
    expect(repository.listAccountsPage({ limit: 2 }).items.map(row => row.id)).toEqual(["a", "b"]);
    expect(repository.listAccountsPage({ limit: 2 }).hasMore).toBe(true);
    expect(repository.listAccountsPage({ limit: 2, after: "b" }).items.map(row => row.id)).toEqual(["c"]);
    expect(repository.listAccountsPage({ limit: 2, after: "b" }).hasMore).toBe(false);
    for (const id of ["f1", "f2", "f3"]) repository.putFolder("a", { id, name: id, kind: "folder" });
    expect(repository.listFoldersPage("a", { limit: 1 }).items.map(row => row.id)).toEqual(["f1"]);
    expect(repository.listFoldersPage("a", { limit: 2, after: "f1" }).items.map(row => row.id)).toEqual(["f2", "f3"]);
    expect(() => repository.listFoldersPage("foreign")).toThrow("Mail account not found");
    expect(() => repository.listFoldersPage("absent")).toThrow("Mail account not found");
  }));
  test("invalid page bounds are rejected", () => setup((_, repository) => {
    for (const limit of [0, -1, 101, 1.5, NaN]) expect(() => repository.listAccountsPage({ limit })).toThrow();
  }));
});
