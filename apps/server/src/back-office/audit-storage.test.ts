import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileBackOfficeAuditStorage } from "./audit-storage.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-audit-storage-"));
  directories.push(directory);
  return { directory, storage: fileBackOfficeAuditStorage(directory, false) };
}

test("audit identity, encryption keys and checkpoints survive a restart separately from the database", async () => {
  const { directory, storage } = await fixture();
  const streamId = randomUUID();
  const key = storage.createKey(streamId);
  const head = {
    streamId,
    sequence: 3,
    hash: "a".repeat(64),
    publicKey: storage.identity.publicKey,
  };
  storage.checkpoint(head);
  const reopened = fileBackOfficeAuditStorage(directory, true);
  expect(reopened.identity).toEqual(storage.identity);
  expect(reopened.key(streamId)).toEqual(key);
  expect(reopened.head(streamId)).toEqual(head);
  expect(storage.identity.userId).not.toBe("local");
  if (process.platform !== "win32")
    expect((await stat(join(directory, "identity.json"))).mode & 0o077).toBe(0);
  expect(
    (await readdir(directory)).some((name) => name.endsWith(".pending")),
  ).toBe(false);
});

test("checkpoint persistence rejects older heads, conflicting hashes and replacement identities", async () => {
  const { storage } = await fixture();
  const head = {
    streamId: randomUUID(),
    sequence: 3,
    hash: "a".repeat(64),
    publicKey: storage.identity.publicKey,
  };
  storage.checkpoint(head);
  for (const changed of [
    { ...head, sequence: 2 },
    { ...head, hash: "b".repeat(64) },
    { ...head, publicKey: "YWJj" },
  ])
    expect(() => storage.checkpoint(changed)).toThrow("older or conflicting");
  storage.checkpoint(head);
  expect(storage.head(head.streamId)).toEqual(head);
});

test("an existing journal never silently regenerates a missing audit identity", async () => {
  const { directory } = await fixture();
  await unlink(join(directory, "identity.json"));
  expect(() => fileBackOfficeAuditStorage(directory, true)).toThrow(
    "cannot be reset automatically",
  );
});

test("erasing a revoked stream's content key retains its independent checkpoint", async () => {
  const { storage, directory } = await fixture();
  const streamId = randomUUID();
  storage.createKey(streamId);
  const head = {
    streamId,
    sequence: 1,
    hash: "a".repeat(64),
    publicKey: storage.identity.publicKey,
  };
  storage.checkpoint(head);
  storage.eraseKey(streamId);
  const reopened = fileBackOfficeAuditStorage(directory, true);
  expect(reopened.key(streamId)).toBeNull();
  expect(reopened.head(streamId)).toEqual(head);
});

test("corrupt persisted checkpoints fail closed instead of being replaced", async () => {
  const { storage, directory } = await fixture();
  const head = {
    streamId: randomUUID(),
    sequence: 1,
    hash: "a".repeat(64),
    publicKey: storage.identity.publicKey,
  };
  storage.checkpoint(head);
  const path = join(directory, `${head.streamId}.head.json`);
  await writeFile(path, "{broken checkpoint");
  expect(() => storage.head(head.streamId)).toThrow();
  expect(() => storage.checkpoint({ ...head, sequence: 2 })).toThrow();
  expect(await readFile(path, "utf8")).toBe("{broken checkpoint");
});
