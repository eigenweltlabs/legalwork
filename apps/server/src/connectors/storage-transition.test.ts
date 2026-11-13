import { bootstrapRuntimeOpencodeConfig, closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorVault, prepareConnectorStorage, readConnectorConnections, writeConnectorConnections } from "./store.js";
import { connectorSettings, connectorSettingsPath, saveConnectorWriteSetting } from "./settings.js";
import { connectorStorageStatePath } from "./storage-state.js";
import { oauthVaultPath } from "../file-storage/oauth/vault.js";
import { openSqlite } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

const account = { id: "local-account", nangoConnectionId: "synthetic-private-capability", createdAt: "2026-10-10T01:02:03Z", needsReconnect: false };
async function fixture(run: (config: ServerConfig, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-connector-transition-"));
  const previous = { ...process.env };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  delete process.env.LEGALWORK_STORAGE_STORE;
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try { await bootstrapRuntimeOpencodeConfig(config); await run(config, root); }
  finally {
    await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}
async function seed(root: string, rows: Array<{ owner: string; id: string; value: string }>) {
  const db = await openSqlite(join(root, "runtime.sqlite"));
  db.exec("CREATE TABLE connector_connections (owner TEXT NOT NULL, connector_id TEXT NOT NULL, connections_json TEXT NOT NULL, PRIMARY KEY(owner, connector_id)); CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('retained')");
  for (const row of rows) db.run("INSERT INTO connector_connections VALUES (?, ?, ?)", [row.owner, row.id, row.value]);
  db.close();
}
async function absent(path: string) { return stat(path).then(() => false, error => error.code === "ENOENT"); }

test("explicit startup imports exact legacy credentials, retires the table and cold current reads/writes never recreate it", async () => fixture(async (config, root) => {
  const old = { id: "synthetic-old-private-id", createdAt: null, needsReconnect: true };
  await seed(root, [{ owner: "owner", id: "gmail", value: JSON.stringify([old]) }, { owner: "owner", id: "outlook", value: "encrypted:v1:preserved" }]);
  let unlocks = 0;
  config.decryptLegacyConnectorSecrets = value => { expect(value).toBe("preserved"); unlocks++; return JSON.stringify([account]); };
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "connector_storage_upgrade_required" });
  await prepareConnectorStorage(config);
  const gmail = await readConnectorConnections(config, "owner", "gmail");
  expect(gmail).toHaveLength(1); expect(gmail[0].id).not.toBe(old.id); expect(gmail[0]).toMatchObject({ nangoConnectionId: old.id, createdAt: null, needsReconnect: true });
  expect(await readConnectorConnections(config, "owner", "outlook")).toEqual([account]);
  const db = await openSqlite(join(root, "runtime.sqlite"));
  expect(db.get("SELECT name FROM sqlite_master WHERE name = 'connector_connections'")).toBeUndefined(); expect(db.get("SELECT value FROM unrelated")?.value).toBe("retained"); db.close();
  for (const suffix of ["", "-wal"]) {
    let bytes: Buffer;
    try { bytes = await readFile(join(root, "runtime.sqlite") + suffix); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    for (const secret of [old.id, "encrypted:v1:preserved"]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  }
  const state = await readFile(connectorStorageStatePath(config), "utf8");
  for (const secret of [old.id, account.nangoConnectionId, "owner"]) expect(state).not.toContain(secret);
  expect((await readFile(oauthVaultPath(config))).includes(Buffer.from(account.nangoConnectionId))).toBe(false);
  await closeRuntimeOpencodeConfig(config);
  await rename(join(root, "runtime.sqlite"), join(root, "retired-source.sqlite"));
  config.decryptLegacyConnectorSecrets = () => { throw new Error("Legacy loader must never run again"); };
  expect(await readConnectorConnections(config, "owner", "outlook")).toEqual([account]);
  expect(await writeConnectorConnections(config, "owner", "outlook", [{ ...account, needsReconnect: true }])).toBe(true);
  expect(await absent(join(root, "runtime.sqlite"))).toBe(true); expect(unlocks).toBe(1);
  const module = new URL("./store.ts", import.meta.url).href;
  const child = Bun.spawn([globalThis.process.execPath, "-e", `import {readConnectorConnections} from ${JSON.stringify(module)}; const result=await readConnectorConnections(${JSON.stringify(config)},"owner","outlook"); console.log(JSON.stringify({count:result.length,reconnect:result[0].needsReconnect}));`], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0); expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ count: 1, reconnect: true });
  expect(await absent(join(root, "runtime.sqlite"))).toBe(true);
}));

test("unavailable legacy desktop decryption preserves original rows and never certifies a completed transition", async () => fixture(async (config, root) => {
  await seed(root, [{ owner: "owner", id: "gmail", value: "encrypted:v1:original" }]);
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_secure_storage_unavailable" });
  const db = await openSqlite(join(root, "runtime.sqlite")); expect(db.get("SELECT connections_json FROM connector_connections")?.connections_json).toBe("encrypted:v1:original"); db.close();
  expect(await absent(connectorStorageStatePath(config))).toBe(true);
  config.decryptLegacyConnectorSecrets = () => JSON.stringify([account]); await prepareConnectorStorage(config); expect(await readConnectorConnections(config, "owner", "gmail")).toEqual([account]);
}));

test("established missing vault, key or vault receipt fails closed without regenerating storage", async () => fixture(async (config) => {
  await prepareConnectorStorage(config); await writeConnectorConnections(config, "owner", "gmail", [account]);
  const path = oauthVaultPath(config), key = path + ".key";
  const original = await readFile(path), originalKey = await readFile(key);
  await rm(path);
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "storage_signin_missing" });
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "storage_signin_missing" }); expect(await absent(path)).toBe(true);
  await writeFile(path, original); await rm(key);
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "storage_signin_unreadable" }); expect(await absent(key)).toBe(true);
  await writeFile(key, originalKey); await rm(connectorVault(config).statePath);
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_storage_recovery_required" });
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "connector_storage_recovery_required" });
}));

test("a completed profile cannot silently recreate its missing connector component receipt", async () => fixture(async config => {
  await prepareConnectorStorage(config); await writeConnectorConnections(config, "owner", "gmail", [account]);
  await rm(connectorStorageStatePath(config));
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_storage_recovery_required" });
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "connector_storage_upgrade_required" });
  expect(await absent(connectorStorageStatePath(config))).toBe(true);
}));

test("missing expected account metadata and settings are recovery errors, while a truly fresh profile stays empty", async () => fixture(async config => {
  await prepareConnectorStorage(config); expect(await readConnectorConnections(config, "owner", "gmail")).toEqual([]);
  await writeConnectorConnections(config, "owner", "gmail", [account]);
  await connectorVault(config).setEntry(JSON.stringify(["nango", "owner", "gmail"]), { parse: value => value, safeParse: value => ({ success: true, data: value }) });
  await expect(readConnectorConnections(config, "owner", "gmail")).rejects.toMatchObject({ code: "connector_storage_recovery_required" });
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_storage_recovery_required" });
  await writeConnectorConnections(config, "other", "outlook", [account]);
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true }); await rm(connectorSettingsPath(config));
  await expect(connectorSettings(config)).rejects.toMatchObject({ code: "connector_settings_missing" });
  await expect(saveConnectorWriteSetting(config, "gmail", { writeAccess: false })).rejects.toMatchObject({ code: "connector_settings_missing" });
}));

test.each([false, true])("legacy global flag %s imports once with the exact same all-deny baseline behavior and a byte backup", async value => fixture(async (config, root) => {
  const path = connectorSettingsPath(config), original = `{
  "writeAccess": ${value}
}
`;
  await mkdir(root, { recursive: true }); await writeFile(path, original);
  await prepareConnectorStorage(config); expect(Object.values((await connectorSettings(config)).writeAccess).every(value => !value)).toBe(true);
  const hash = createHash("sha256").update(original).digest("hex");
  const backup = `${path}.legacy-${hash}.json`;
  expect(await readFile(backup, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(`${backup}.import.json`, "utf8"))).toMatchObject({ sourceDigest: hash, effectiveAccess: "all-deny", previousFormat: "global-write-access" });
  await writeFile(path, JSON.stringify({ writeAccess: true }));
  await expect(connectorSettings(config)).rejects.toMatchObject({ code: "connector_settings_unreadable" });
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_settings_unreadable" });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify({ writeAccess: true }));
}));
