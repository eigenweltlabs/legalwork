import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopMailService } from "./mail-runtime.mjs";

test("desktop binding unlocks the built encrypted worker and reopens the same OS-wrapped store", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-desktop-mail-"));
  const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
  const userData = join(root, "profile");
  const wrapped = new Map();
  let vaultCalls = 0;
  /** @type {Pick<import("electron").SafeStorage, "isEncryptionAvailable"|"getSelectedStorageBackend"|"encryptString"|"decryptString">} */
  const safeStorage = {
    isEncryptionAvailable() { vaultCalls++; return true; },
    getSelectedStorageBackend() { return "gnome_libsecret"; },
    encryptString(text) { const bytes = randomBytes(64); wrapped.set(bytes.toString("base64"), text); return bytes; },
    decryptString(bytes) { const text = wrapped.get(bytes.toString("base64")); if (typeof text !== "string") throw new Error("fake_vault_locked"); return text; },
  };
  const app = { isReady: () => true, getPath: name => name === "exe" ? (process.env.LEGALWORK_MAIL_TEST_ELECTRON ?? process.execPath) : userData };
  let service;
  const originalGoogleConfig = process.env.LEGALWORK_MAIL_GOOGLE_CLIENT_CONFIG;
  try {
    await mkdir(userData, { mode: 0o700 });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await symlink(join(serverRoot, "node_modules"), join(root, "node_modules"));
    execFileSync("pnpm", ["exec", "tsc", "--outDir", join(root, "build"), "--rootDir", "src", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--types", "node,bun-types", "src/mail/service.ts", "src/mail/runtime/worker.ts", "src/mail/providers/development-config.ts"], { cwd: serverRoot, stdio: "pipe", timeout: 30_000 });
    const googleConfig = join(userData, "synthetic-google-client.json");
    await writeFile(googleConfig, JSON.stringify({ installed: { client_id: "123456-synthetic.apps.googleusercontent.com", project_id: "synthetic-mail-project",
      client_secret: "synthetic-private-client-marker", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] } }), { mode: 0o600 });
    process.env.LEGALWORK_MAIL_GOOGLE_CLIENT_CONFIG = googleConfig;
    const embeddedPath = join(root, "build/embedded.js");
    service = await createDesktopMailService({ app, embeddedPath, safeStorage });
    assert.equal(service.status().state, "locked");
    assert.equal(vaultCalls, 0);
    await assert.rejects(stat(join(userData, "mail")), { code: "ENOENT" });
    await service.unlock();
    assert.equal(service.status().state, "ready");
    assert.deepEqual(await service.listAccounts({}), { items: [], nextCursor: null });
    const connection = await service.beginConnection("gmail");
    assert.equal(new URL(connection.authorizationUrl).hostname, "accounts.google.com");
    assert.equal(JSON.stringify(connection).includes("synthetic-private-client-marker"), false);
    assert.equal((await service.connectionStatus(connection.connectionId)).state, "pending");
    await service.cancelConnection(connection.connectionId);
    assert.equal((await service.connectionStatus(connection.connectionId)).state, "cancelled");
    await service.stop();
    const envelope = await readFile(join(userData, "mail/mail-key-v1.json"));
    const database = await readFile(join(userData, "mail/mail.sqlite"));
    assert.notEqual(database.subarray(0, 16).toString(), "SQLite format 3\0");
    service = await createDesktopMailService({ app, embeddedPath, safeStorage });
    await service.unlock();
    assert.deepEqual(await service.listAccounts({}), { items: [], nextCursor: null });
    await service.stop();
    assert.deepEqual(await readFile(join(userData, "mail/mail-key-v1.json")), envelope);
  } finally {
    if (originalGoogleConfig === undefined) delete process.env.LEGALWORK_MAIL_GOOGLE_CLIENT_CONFIG;
    else process.env.LEGALWORK_MAIL_GOOGLE_CLIENT_CONFIG = originalGoogleConfig;
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
