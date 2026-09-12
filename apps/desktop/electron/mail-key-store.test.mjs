import {mailTestWindowsAcl} from '../../../scripts/mail/windows-test-acl.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailKeyStore } from "./mail-key-store.mjs";

/** Simulates an OS-owned wrapping key; not a production keychain substitute.
 * @returns {Pick<import("electron").SafeStorage, "isEncryptionAvailable"|"encryptString"|"decryptString"|"getSelectedStorageBackend">}
 */
function fakeStorage() {
  const wrappingKey = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", wrappingKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-mail-key-"));
  const directory = join(root, "mail");
  const safeStorage = fakeStorage();
  try { await run({ root, directory, safeStorage, store: createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, safeStorage }) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("fresh activation persists only wrapped key and reopened store returns same key", () => fixture(async ({ directory, safeStorage, store }) => {
  const first = await store.load({ allowCreate: true });
  assert.equal(first.length, 32);
  const file = await readFile(join(directory, "mail-key-v1.json"));
  assert.equal(file.includes(first), false);
  assert.equal(file.includes(first.toString("base64")), false);
  assert.deepEqual(await createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, safeStorage }).load(), first);
  assert.deepEqual(await readdir(directory), ["mail-key-v1.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "mail-key-v1.json"))).mode & 0o777, 0o600);
  }
  first.fill(0);
}));

test("concurrent creators all use the single published key", () => fixture(async ({ directory, safeStorage }) => {
  const keys = await Promise.all(Array.from({ length: 12 }, () => createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, safeStorage }).load({ allowCreate: true })));
  for (const key of keys) assert.deepEqual(key, keys[0]);
  assert.deepEqual(await readdir(directory), ["mail-key-v1.json"]);
  for (const key of keys) key.fill(0);
}));

test("missing key never creates storage without explicit activation", () => fixture(async ({ directory, store }) => {
  await assert.rejects(store.load(), /mail_key_missing/);
  await assert.rejects(stat(directory), { code: "ENOENT" });
}));

test("missing key for existing database or sidecar cannot be replaced", () => fixture(async ({ directory, store }) => {
  await store.load({ allowCreate: true });
  await rm(join(directory, "mail-key-v1.json"));
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = join(directory, `mail.sqlite${suffix}`);
    await writeFile(path, "existing-data", { mode: 0o600 });
    await assert.rejects(store.load({ allowCreate: true }), /mail_key_missing_for_existing_store/);
    assert.equal(await readFile(path, "utf8"), "existing-data");
    await assert.rejects(stat(join(directory, "mail-key-v1.json")), { code: "ENOENT" });
    await rm(path);
  }
}));

test("corrupt or foreign-key envelopes remain byte-identical and fail closed", () => fixture(async ({ directory, store }) => {
  await store.load({ allowCreate: true });
  const path = join(directory, "mail-key-v1.json");
  const valid = await readFile(path);
  for (const data of ["{", "", "x".repeat(17 * 1024), '{"version":2,"wrappedKey":"AAAA"}', '{"version":1,"wrappedKey":"***"}']) {
    await writeFile(path, data);
    await assert.rejects(store.load({ allowCreate: true }), /mail_key_corrupt/);
    assert.equal(await readFile(path, "utf8"), data);
  }
  await writeFile(path, valid);
  const foreign = createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, safeStorage: fakeStorage() });
  await assert.rejects(foreign.load({ allowCreate: true }), /mail_key_locked/);
  assert.deepEqual(await readFile(path), valid);
}));

test("unavailable and Linux plaintext backends fail before filesystem access", () => fixture(async ({ directory, safeStorage }) => {
  for (const overrides of [
    { isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => "basic_text" },
    { getSelectedStorageBackend: () => "unknown" },
    { isEncryptionAvailable() { throw new Error("secret backend details"); } },
  ]) {
    const store = createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, platform: "linux", safeStorage: { ...safeStorage, ...overrides } });
    await assert.rejects(store.load({ allowCreate: true }), { message: "mail_key_backend_unavailable" });
    await assert.rejects(stat(directory), { code: "ENOENT" });
  }
}));

test("wrapping failure creates no key and never reflects provider details", () => fixture(async ({ directory, safeStorage }) => {
  const store = createMailKeyStore({ windowsAcl:mailTestWindowsAcl, directory, safeStorage: { ...safeStorage, encryptString() { throw new Error("secret-provider-detail"); } } });
  await assert.rejects(store.load({ allowCreate: true }), { message: "mail_key_wrap_failed" });
  assert.deepEqual(await readdir(directory), []);
}));

test("symlink key and insecure directory/file permissions are refused", () => fixture(async ({ root, directory, store }) => {
  await store.load({ allowCreate: true });
  const path = join(directory, "mail-key-v1.json");
  const original = await readFile(path);
  const target = join(root, "foreign");
  await writeFile(target, original, { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(store.load(), process.platform==='win32'?/mail_permissions_unsafe/:/mail_key_unreadable/);
  assert.deepEqual(await readFile(target), original);
  await rm(path);
  await writeFile(path, original, { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o755);
    await assert.rejects(store.load(), /mail_key_permissions_unsafe/);
    await chmod(directory, 0o700);
    await chmod(path, 0o644);
    await assert.rejects(store.load(), /mail_key_permissions_unsafe/);
  }
}));
