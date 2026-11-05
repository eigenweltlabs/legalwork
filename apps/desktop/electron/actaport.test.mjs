import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActaportConnection, prepareActaportRuntime } from "./actaport.mjs";
import { createRuntimeManager } from "./runtime.mjs";

const credentials = { realm: "test-firm", clientId: "client", clientSecret: "private-secret", username: "api-user", password: "private-password" };
const loadAuth = () => import(new URL("../../../packages/actaport-mcp/dist/auth.mjs", import.meta.url).href);
const vaultPath = (directory) => path.join(directory, "server", "storage-oauth.vault");
const credentialKey = (directory) => JSON.stringify(["actaport", path.resolve(directory)]);
async function loadVault(directory) {
  const { OAuthVault, vaultLock } = await import("../../server/dist/file-storage/oauth/vault.js");
  return { vault: new OAuthVault(vaultPath(directory)), lock: vaultLock };
}
/** @returns {Pick<typeof import('electron').safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'>} */
function storage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(buffer) {
      const cipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
      cipher.setAuthTag(buffer.subarray(buffer.length - 16));
      return Buffer.concat([cipher.update(buffer.subarray(12, buffer.length - 16)), cipher.final()]).toString("utf8");
    },
  };
}
const providerFetch = async (url, init) => {
  assert.equal(init.redirect, "error");
  if (String(url).includes("/openid-connect/token")) return Response.json({ access_token: "private-token", expires_in: 300 });
  assert.equal(init.headers.Authorization, "Bearer private-token");
  return Response.json({ id: "user" });
};

test("credentials share the encrypted OAuth vault; the private bridge releases tokens only and revokes on disconnect", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-"));
  const safeStorage = storage();
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch });
  try {
    assert.equal((await connection.status()).configured, false);
    const { vault } = await loadVault(directory);
    const grant = { accessToken: "drive-access", refreshToken: "drive-refresh", expiresAt: 123 };
    await Promise.all([vault.set("drive", grant), connection.connect(credentials)]);
    const connected = await connection.status();
    assert.equal(connected.configured, true);
    assert.equal(connected.allowWrites, false);
    assert.deepEqual(connected.enabledToolsets, []);
    assert.equal(connected.coreToolCount, 15);
    assert.equal(connected.toolsets.length, 4);
    await assert.rejects(readFile(path.join(directory, "actaport-credentials.enc")), { code: "ENOENT" });
    const encrypted = await readFile(vaultPath(directory));
    assert.equal(encrypted.includes(Buffer.from("private-password")), false);
    assert.equal(encrypted.includes(Buffer.from("private-secret")), false);
    if (process.platform !== "win32") assert.equal((await stat(vaultPath(directory))).mode & 0o777, 0o600);
    const environment = await connection.environment();
    assert.equal(environment.ACTAPORT_ALLOW_WRITES, "0");
    assert.equal(JSON.stringify(environment).includes("private-password"), false);
    const descriptor = JSON.parse(await readFile(environment.ACTAPORT_CONNECTION_FILE, "utf8"));
    assert.equal((await fetch(`${descriptor.baseUrl}token`, { method: "POST" })).status, 401);
    const headers = { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${descriptor.baseUrl}token`, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" } })).status, 401);
    let response = await fetch(`${descriptor.baseUrl}token`, { method: "POST", headers, body: "{}" });
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ["accessToken", "allowWrites", "expiresAt", "toolsets"]);
    assert.equal(result.accessToken, "private-token");
    assert.equal(result.allowWrites, false);
    await connection.setWriteAccess(true);
    assert.equal((await connection.environment()).ACTAPORT_ALLOW_WRITES, "1");
    response = await fetch(`${descriptor.baseUrl}token`, { method: "POST", headers, body: "{}" });
    assert.equal((await response.json()).allowWrites, true);
    const restored = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch });
    assert.equal((await restored.status()).configured, true);
    await connection.disconnect();
    assert.equal((await restored.status()).configured, false);
    assert.deepEqual(await vault.get("drive"), grant);
    assert.equal(await vault.getEntry(credentialKey(directory), (await loadAuth()).connectionSchema), undefined);
    assert.equal((await fetch(`${descriptor.baseUrl}token`, { method: "POST", headers, body: "{}" })).status, 409);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("new connections use the shared vault without an OS keychain; invalid credentials cannot be saved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-shared-"));
  /** @type {ReturnType<typeof storage>} */
  const safeStorage = { ...storage(), isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "basic_text",
    encryptString: () => { throw new Error("New credentials must not use safeStorage"); } };
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch, platform: "linux" });
  try {
    assert.equal((await connection.status()).secureStorage, true);
    assert.equal((await connection.connect(credentials)).configured, true);
    await assert.rejects(connection.connect({ ...credentials, realm: "bad/realm" }), /all five Actaport API credentials/);
    assert.equal((await connection.status()).configured, true);
    await assert.rejects(readFile(path.join(directory, "actaport-credentials.enc")), { code: "ENOENT" });
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("tool groups persist privately, survive permission changes and revoke through the bridge", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-groups-"));
  const safeStorage = storage();
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch });
  try {
    await connection.connect(credentials);
    const environment = await connection.environment();
    assert.equal(environment.ACTAPORT_TOOLSETS, "");
    const descriptor = JSON.parse(await readFile(environment.ACTAPORT_CONNECTION_FILE, "utf8"));
    const access = async () => (await fetch(`${descriptor.baseUrl}token`, { method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` }, body: "{}" })).json();
    await access(); // Initialise the live token cache before changing settings.
    assert.deepEqual((await connection.setToolsets(["finance", "uploads"])).enabledToolsets, ["finance", "uploads"]);
    assert.deepEqual((await access()).toolsets, ["finance", "uploads"]);
    assert.equal((await connection.environment()).ACTAPORT_TOOLSETS, "finance,uploads");
    const changed = await connection.setWriteAccess(true);
    assert.deepEqual(changed.enabledToolsets, ["finance", "uploads"]);
    const restored = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch });
    assert.deepEqual((await restored.status()).enabledToolsets, ["finance", "uploads"]);
    await assert.rejects(connection.setToolsets(["unknown"]), /valid Actaport tool groups/);
    await assert.rejects(connection.setToolsets(["finance", "finance"]), /valid Actaport tool groups/);
    assert.deepEqual((await connection.status()).enabledToolsets, ["finance", "uploads"]);
    await connection.setToolsets([]);
    assert.deepEqual((await access()).toolsets, []);
    assert.equal((await access()).allowWrites, true);
    // Replacing credentials starts again with the small read-only set.
    const replaced = await connection.connect(credentials);
    assert.deepEqual(replaced.enabledToolsets, []);
    assert.equal(replaced.allowWrites, false);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("credentials saved before tool groups were introduced migrate to the minimal set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-legacy-"));
  const safeStorage = storage();
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch });
  try {
    await writeFile(path.join(directory, "actaport-credentials.enc"), safeStorage.encryptString(JSON.stringify({ credentials, allowWrites: true })), { mode: 0o600 });
    const saved = await connection.status();
    assert.equal(saved.configured, true);
    assert.equal(saved.allowWrites, true);
    assert.deepEqual(saved.enabledToolsets, []);
    assert.equal((await connection.environment()).ACTAPORT_TOOLSETS, "");
    await assert.rejects(readFile(path.join(directory, "actaport-credentials.enc")), { code: "ENOENT" });
    const { vault } = await loadVault(directory);
    assert.equal((await vault.getEntry(credentialKey(directory), (await loadAuth()).connectionSchema)).allowWrites, true);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("macOS does not call the Linux-only storage backend API", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-macos-"));
  const safeStorage = { ...storage(), getSelectedStorageBackend: () => { throw new Error("Linux only"); } };
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage, loadAuth, fetch: providerFetch, platform: "darwin" });
  try {
    await writeFile(path.join(directory, "actaport-credentials.enc"), safeStorage.encryptString(JSON.stringify({ credentials, allowWrites: true, toolsets: ["finance"] })));
    const migrated = await connection.status();
    assert.equal(migrated.configured, true);
    assert.deepEqual(migrated.enabledToolsets, ["finance"]);
  }
  finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed migration keeps the original credentials and permissions for a later retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-retry-"));
  const safeStorage = storage();
  const previous = { credentials, allowWrites: true, toolsets: ["records", "finance"] };
  const legacy = path.join(directory, "actaport-credentials.enc");
  const encrypted = safeStorage.encryptString(JSON.stringify(previous));
  const { vault, lock } = await loadVault(directory);
  const blocked = Object.create(vault);
  blocked.setEntry = async () => { throw new Error("Vault write blocked"); };
  const connection = createActaportConnection({ directory, safeStorage, loadAuth, loadVault: async () => ({ vault: blocked, lock }), fetch: providerFetch });
  try {
    await writeFile(legacy, encrypted);
    assert.equal((await connection.status()).secureStorage, false);
    assert.deepEqual(await readFile(legacy), encrypted);
    assert.equal(await vault.getEntry(credentialKey(directory), (await loadAuth()).connectionSchema), undefined);
    const restored = createActaportConnection({ directory, safeStorage, loadAuth, loadVault: () => loadVault(directory), fetch: providerFetch });
    const migrated = await restored.status();
    assert.equal(migrated.configured, true);
    assert.equal(migrated.allowWrites, true);
    assert.deepEqual(migrated.enabledToolsets, previous.toolsets);
    await assert.rejects(readFile(legacy), { code: "ENOENT" });
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unavailable legacy keychains do not import or erase old credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-locked-"));
  const safeStorage = storage();
  const legacy = path.join(directory, "actaport-credentials.enc");
  const encrypted = safeStorage.encryptString(JSON.stringify({ credentials }));
  const locked = { ...safeStorage, isEncryptionAvailable: () => false };
  const connection = createActaportConnection({ directory, safeStorage: locked, loadAuth, loadVault: () => loadVault(directory), fetch: providerFetch });
  try {
    await writeFile(legacy, encrypted);
    assert.equal((await connection.status()).secureStorage, false);
    await assert.rejects(connection.test(), /operating system keychain/);
    assert.deepEqual(await readFile(legacy), encrypted);
    const { vault } = await loadVault(directory);
    assert.equal(await vault.getEntry(credentialKey(directory), (await loadAuth()).connectionSchema), undefined);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the vault entry wins over a leftover legacy file and disconnect cannot reimport it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-cleanup-"));
  const safeStorage = storage();
  const legacy = path.join(directory, "actaport-credentials.enc");
  const connection = createActaportConnection({ directory, safeStorage, loadAuth, loadVault: () => loadVault(directory), fetch: providerFetch });
  try {
    await connection.connect(credentials);
    await writeFile(legacy, safeStorage.encryptString(JSON.stringify({ credentials: { ...credentials, password: "old-password" }, allowWrites: true })));
    assert.equal((await connection.status()).allowWrites, false);
    const { vault } = await loadVault(directory);
    assert.deepEqual((await vault.getEntry(credentialKey(directory), (await loadAuth()).connectionSchema)).credentials, credentials);
    await assert.rejects(readFile(legacy), { code: "ENOENT" });
    await writeFile(legacy, safeStorage.encryptString(JSON.stringify({ credentials })));
    await connection.disconnect();
    assert.equal((await connection.status()).configured, false);
    await assert.rejects(readFile(legacy), { code: "ENOENT" });
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent cloud credential writes and separate desktop profiles retain their entries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-coexist-"));
  const safeStorage = storage();
  const loadShared = () => loadVault(directory);
  const first = createActaportConnection({ directory: path.join(directory, "one"), safeStorage, loadAuth, loadVault: loadShared, fetch: providerFetch });
  const second = createActaportConnection({ directory: path.join(directory, "two"), safeStorage, loadAuth, loadVault: loadShared, fetch: providerFetch });
  try {
    const { vault } = await loadShared();
    const grant = { accessToken: "other-access", refreshToken: "other-refresh", expiresAt: 123 };
    await Promise.all([first.connect(credentials), second.connect({ ...credentials, username: "second-api-user" }),
      ...Array.from({ length: 10 }, (_, index) => vault.set(`cloud-${index}`, grant))]);
    await first.setToolsets(["finance"]);
    assert.deepEqual((await second.status()).enabledToolsets, []);
    await first.disconnect();
    assert.equal((await second.status()).configured, true);
    for (let index = 0; index < 10; index++) assert.deepEqual(await vault.get(`cloud-${index}`), grant);
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a corrupt shared vault blocks new authentication without erasing the vault", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-corrupt-"));
  const connection = createActaportConnection({ directory, safeStorage: storage(), loadAuth, loadVault: () => loadVault(directory),
    fetch: async () => { throw new Error("Authentication must not run with an unreadable vault"); } });
  try {
    await mkdir(path.dirname(vaultPath(directory)), { recursive: true });
    await writeFile(vaultPath(directory), "corrupt vault");
    assert.equal((await connection.status()).secureStorage, false);
    await assert.rejects(connection.connect(credentials), /Saved sign-ins could not be opened/);
    assert.equal(await readFile(vaultPath(directory), "utf8"), "corrupt vault");
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the desktop loader uses the server vault module, config override and write lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-loader-"));
  const previous = { ...process.env };
  try {
    process.env.LEGALWORK_DEV_MODE = "1";
    process.env.LEGALWORK_SERVER_CONFIG = path.join(directory, "config", "server.json");
    process.env.LEGALWORK_STORAGE_STORE = path.join(directory, "shared", "file-storage.json");
    process.env.LEGALWORK_ENV_STORE = path.join(directory, "env.json");
    process.env.LEGALWORK_ENCRYPTION_KEY = "fixture-only-vault-key";
    const manager = createRuntimeManager({ app: { isPackaged: false, getPath: (name) => path.join(directory, name) },
      desktopRoot: path.resolve(import.meta.dirname, ".."), listLocalWorkspacePaths: async () => [], recorder: null,
      onSidecarExit: () => {}, getApprovalWindow: () => null, modelDownloadFetch: undefined });
    const loaded = await manager.credentialVault();
    const shared = await import("../../server/dist/file-storage/oauth/vault.js");
    assert.equal(loaded.lock, shared.vaultLock);
    assert.equal(loaded.vault.path, shared.oauthVaultPath({ configPath: process.env.LEGALWORK_SERVER_CONFIG }));
    assert.equal(loaded.vault.path, path.join(directory, "shared", "storage-oauth.vault"));
    const grant = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 123 };
    await loaded.vault.set("loader-test", grant);
    assert.deepEqual(await new shared.OAuthVault(loaded.vault.path).get("loader-test"), grant);
    await assert.rejects(stat(`${loaded.vault.path}.key`), { code: "ENOENT" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled runtime has a stable path and updates when the application moves or upgrades", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-runtime-"));
  try {
    const first = path.join(root, "app-v1");
    const second = path.join(root, "app-v2");
    const destination = path.join(root, "user-data", "mcp", "actaport");
    for (const [source, version] of [[first, "v1"], [second, "v2"]]) {
      await mkdir(source);
      await writeFile(path.join(source, "index.mjs"), version);
      await writeFile(path.join(source, "auth.mjs"), version);
    }
    const entry = await prepareActaportRuntime(first, destination);
    assert.equal(await readFile(entry, "utf8"), "v1");
    assert.equal(await prepareActaportRuntime(second, destination), entry);
    assert.equal(await readFile(entry, "utf8"), "v2");
    assert.equal(await readFile(path.join(destination, "auth.mjs"), "utf8"), "v2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishing the private discovery file replaces a symlink without writing its target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-actaport-discovery-"));
  const outside = path.join(directory, "other-file.json");
  const discovery = path.join(directory, "actaport-connection.json");
  const connection = createActaportConnection({ directory, loadVault: () => loadVault(directory), safeStorage: storage(), loadAuth, fetch: providerFetch });
  try {
    await writeFile(outside, "preserve this file", { mode: 0o644 });
    await symlink(outside, discovery);
    await connection.environment();
    assert.equal(await readFile(outside, "utf8"), "preserve this file");
    assert.equal(typeof JSON.parse(await readFile(discovery, "utf8")).token, "string");
    if (process.platform !== "win32") assert.equal((await stat(discovery)).mode & 0o777, 0o600);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});
