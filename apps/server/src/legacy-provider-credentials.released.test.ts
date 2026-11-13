import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OpenCode } from "@opencode/client";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { createConfiguredManagedEngine } from "./managed-engine-lifecycle.js";
import { nativeMcpBinary } from "./native-mcp-engine.test-support.js";
import { importLegacyProviderCredentials } from "./legacy-provider-credentials.js";
import type { ServerConfig } from "./types.js";

const legacy = {
  openai: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1893456000000, accountId: "synthetic-account" },
  "custom-provider/": { type: "api", key: "synthetic-api-key", metadata: { region: "eu" } },
};

test.skipIf(!nativeMcpBinary)("imports retired Azure and Vertex connections under their current IDs once", async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({
      "azure-cognitive-services/": { type: "api", key: "synthetic-azure-key", metadata: { resourceName: "synthetic-resource" } },
      "google-vertex-anthropic": { type: "oauth", access: "synthetic-vertex-access", refresh: "synthetic-vertex-refresh", expires: 1893456000000, accountId: "synthetic-vertex-account" },
    });
    await writeFile(f.auth, source, { mode: 0o600 });
    let client = await f.start();
    const credentials = await client.credential.list();
    expect(credentials.map(item => item.integrationID).sort()).toEqual(["azure", "google-vertex"]);
    expect(credentials.find(item => item.integrationID === "azure")).toMatchObject({ active: true, value: { type: "key", key: "synthetic-azure-key", metadata: { resourceName: "synthetic-resource" } } });
    expect(credentials.find(item => item.integrationID === "google-vertex")).toMatchObject({ active: true, value: { type: "oauth", methodID: "oauth", access: "synthetic-vertex-access", refresh: "synthetic-vertex-refresh", expires: 1893456000000, metadata: { accountID: "synthetic-vertex-account" } } });
    const azure = (await client.integration.list({ location: { directory: f.options.cwd } })).data.find(item => item.id === "azure");
    expect(azure?.connections).toHaveLength(1);
    for (const credential of credentials) await client.credential.remove({ credentialID: credential.id });
    client = await f.start();
    expect(await client.credential.list()).toEqual([]);
    expect(await readFile(f.auth, "utf8")).toBe(source);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary).each([false, true])("current provider IDs win over retired aliases regardless of source order (reverse=%s)", async reverse => {
  const f = await fixture();
  try {
    const entries = [
      ["azure-cognitive-services", { type: "api", key: "synthetic-old-azure" }],
      ["azure/", { type: "api", key: "synthetic-current-azure" }],
      ["google-vertex-anthropic/", { type: "api", key: "synthetic-old-vertex" }],
      ["google-vertex", { type: "api", key: "synthetic-current-vertex" }],
    ];
    await writeFile(f.auth, JSON.stringify(Object.fromEntries(reverse ? entries.reverse() : entries)));
    const client = await f.start();
    expect((await client.credential.list()).map(item => ({ integrationID: item.integrationID, value: item.value })).sort((a, b) => a.integrationID.localeCompare(b.integrationID))).toEqual([
      { integrationID: "azure", value: { type: "key", key: "synthetic-current-azure" } },
      { integrationID: "google-vertex", value: { type: "key", key: "synthetic-current-vertex" } },
    ]);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("retired aliases preserve newer native credentials, including inactive connections", async () => {
  const f = await fixture();
  try {
    await writeFile(f.auth, JSON.stringify({
      "azure-cognitive-services": { type: "api", key: "synthetic-old-azure" },
      "google-vertex-anthropic": { type: "api", key: "synthetic-old-vertex" },
    }));
    let client = await f.start(false);
    await client.credential.create({ integrationID: "azure", value: { type: "key", key: "synthetic-selected-azure" }, activate: true });
    const inactive = await client.credential.create({ integrationID: "azure", value: { type: "key", key: "synthetic-native-azure" }, activate: false });
    expect(inactive.active).toBe(false);
    await client.credential.create({ integrationID: "google-vertex", value: { type: "key", key: "synthetic-native-vertex" }, activate: true });
    const credentials = await client.credential.list();
    client = await f.start();
    expect(await client.credential.list()).toEqual(credentials);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("completes the native v1 credential import through the unchanged engine API", async () => {
  const f = await fixture();
  try {
    const client = await f.start(false);
    // Match the native legacy importer's rows, including its unset active flag.
    const db = new Database(f.database);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, 1, 1)");
    insert.run("cred_native_azure", "azure-cognitive-services", "API key", JSON.stringify({ type: "key", key: "synthetic-native-azure", metadata: { resourceName: "synthetic-resource" } }));
    insert.run("cred_native_vertex", "google-vertex-anthropic", "OAuth", JSON.stringify({ type: "oauth", methodID: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1893456000000, metadata: { accountID: "synthetic-account" } }));
    db.close();
    // A v1 upgrade must use the credentials already imported by the engine.
    const source = "invalid JSON that must not be reread";
    await writeFile(f.auth, source);
    const originals = await client.credential.list();
    await importLegacyProviderCredentials(client, f.options);
    const imported = await client.credential.list();
    const azure = imported.find(item => item.integrationID === "azure"), vertex = imported.find(item => item.integrationID === "google-vertex");
    expect(azure).toMatchObject({ label: "API key", active: true, value: originals.find(item => item.id === "cred_native_azure")?.value });
    expect(vertex).toMatchObject({ label: "OAuth", active: true, value: originals.find(item => item.id === "cred_native_vertex")?.value });
    expect(imported.filter(item => originals.some(original => original.id === item.id))).toEqual(originals);
    expect((await client.integration.list({ location: { directory: f.options.cwd } })).data.find(item => item.id === "azure")?.connections).toHaveLength(1);
    if (!azure || !vertex) throw new Error("Expected migrated connections");
    await client.credential.remove({ credentialID: azure.id });
    await client.credential.remove({ credentialID: vertex.id });
    await importLegacyProviderCredentials(client, f.options);
    expect(await client.credential.list()).toEqual(originals);
    expect(await readFile(f.auth, "utf8")).toBe(source);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("native legacy aliases keep existing current accounts and their selection", async () => {
  const f = await fixture();
  try {
    const client = await f.start(false);
    for (const integrationID of ["azure-cognitive-services", "google-vertex-anthropic", "azure", "google-vertex"]) {
      await client.credential.create({ integrationID, label: "Selected account", value: { type: "key", key: `synthetic-${integrationID}` }, activate: true });
      await client.credential.create({ integrationID, label: "Other account", value: { type: "key", key: `synthetic-other-${integrationID}` }, activate: false });
    }
    const db = new Database(f.database); db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)"); db.close();
    const originals = await client.credential.list();
    expect(originals.filter(item => !item.active)).toHaveLength(4);
    await importLegacyProviderCredentials(client, f.options);
    expect(await client.credential.list()).toEqual(originals);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("interrupted native credential handoff resumes without duplicate accounts or lost selection", async () => {
  const f = await fixture();
  try {
    const client = await f.start(false);
    for (const integrationID of ["azure-cognitive-services", "google-vertex-anthropic"]) {
      await client.credential.create({ integrationID, label: "Selected account", value: { type: "key", key: `synthetic-selected-${integrationID}` }, activate: true });
      await client.credential.create({ integrationID, label: "Other account", value: { type: "key", key: `synthetic-other-${integrationID}`, metadata: { region: "eu" } }, activate: false });
    }
    const db = new Database(f.database); db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)"); db.close();
    const originals = await client.credential.list();
    // Lose the response after the engine commits the first copied credential.
    const interrupted = new Proxy(client, { get(target, key) {
      if (key !== "credential") return Reflect.get(target, key);
      return new Proxy(target.credential, { get(credentials, action) {
        if (action !== "create") return Reflect.get(credentials, action);
        return async (input: Parameters<typeof client.credential.create>[0]) => {
          await credentials.create(input);
          throw new Error("Synthetic lost import response");
        };
      } });
    } });
    await expect(importLegacyProviderCredentials(interrupted, f.options)).rejects.toThrow("Synthetic lost import response");
    await importLegacyProviderCredentials(client, f.options);
    const imported = await client.credential.list();
    expect(imported).toHaveLength(8);
    expect(imported.filter(item => originals.some(original => original.id === item.id))).toEqual(originals);
    for (const [retired, current] of [["azure-cognitive-services", "azure"], ["google-vertex-anthropic", "google-vertex"]]) {
      expect(imported.filter(item => item.integrationID === current).map(item => ({ label: item.label, active: item.active, value: item.value })))
        .toEqual(originals.filter(item => item.integrationID === retired).map(item => ({ label: item.label, active: item.active, value: item.value })));
    }
    await importLegacyProviderCredentials(client, f.options);
    expect(await client.credential.list()).toEqual(imported);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("a completed LegalWork import never repairs already-migrated retired credentials", async () => {
  const f = await fixture();
  try {
    const client = await f.start();
    await client.credential.create({ integrationID: "azure-cognitive-services", value: { type: "key", key: "synthetic-completed-import" } });
    const db = new Database(f.database); db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)"); db.close();
    const originals = await client.credential.list();
    await importLegacyProviderCredentials(client, f.options);
    expect(await client.credential.list()).toEqual(originals);
  } finally { await f.close(); }
}, 60_000);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-provider-import-"));
  for (const name of ["home", "config", "data/opencode", "cache", "state", "project"]) await mkdir(join(root, name), { recursive: true });
  const auth = join(root, "data/opencode/auth.json"), database = join(root, "engine.db");
  const options = { bin: nativeMcpBinary, cwd: join(root, "project"), timeoutMs: 30_000, parentLease: true, env: {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DB: database, OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false }),
  } };
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  return { root, auth, database, options,
    async stop() { await engine?.close(); engine = undefined; },
    async start(repair = true) {
      await engine?.close();
      engine = repair ? await createConfiguredManagedEngine(config, options) : await createManagedOpencodeServer(options);
      return OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    },
    async close() { await engine?.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test.skipIf(!nativeMcpBinary)("fresh managed databases import saved OAuth and keys once, preserving disconnects after restart", async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify(legacy);
    await writeFile(f.auth, source, { mode: 0o600 });
    let client = await f.start();
    const credentials = await client.credential.list();
    expect(credentials).toHaveLength(2);
    expect(credentials.find(item => item.integrationID === "openai")).toMatchObject({ active: true, value: { type: "oauth", methodID: "chatgpt-browser", access: legacy.openai.access, refresh: legacy.openai.refresh, expires: legacy.openai.expires, metadata: { accountID: legacy.openai.accountId } } });
    expect(credentials.find(item => item.integrationID === "custom-provider")).toMatchObject({ active: true, value: { type: "key", key: legacy["custom-provider/"].key, metadata: { region: "eu" } } });
    client = await f.start();
    expect((await client.credential.list()).map(item => item.id).sort()).toEqual(credentials.map(item => item.id).sort());
    for (const item of credentials) await client.credential.remove({ credentialID: item.id });
    client = await f.start();
    expect(await client.credential.list()).toEqual([]);
    expect(await readFile(f.auth, "utf8")).toBe(source);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("repairs a previously skipped import without replacing newer native accounts", async () => {
  const f = await fixture();
  try {
    await writeFile(f.auth, JSON.stringify(legacy));
    let client = await f.start(false);
    expect(await client.credential.list()).toEqual([]);
    const current = await client.credential.create({ integrationID: "openai", value: { type: "key", key: "synthetic-newer-key" }, activate: true });
    client = await f.start();
    expect(await client.credential.list()).toHaveLength(2);
    expect((await client.credential.list()).find(item => item.integrationID === "openai")).toMatchObject({ id: current.id, value: { type: "key", key: "synthetic-newer-key" } });
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("respects completed v1 upgrades and absent files, and retries malformed files safely", async () => {
  const f = await fixture();
  try {
    await writeFile(f.auth, "invalid JSON");
    await expect(f.start()).rejects.toThrow("legacy file is invalid");
    await writeFile(f.auth, JSON.stringify(legacy));
    let client = await f.start();
    expect(await client.credential.list()).toHaveLength(2);
    const db = new Database(f.database);
    db.exec("DROP TABLE _legalwork_legacy_provider_import; CREATE TABLE session (id TEXT PRIMARY KEY); DELETE FROM credential");
    db.close();
    // A retained v1 table distinguishes an upgrade from schema bootstrap.
    await importLegacyProviderCredentials(client, f.options);
    expect(await client.credential.list()).toEqual([]);
  } finally { await f.close(); }
  const empty = await fixture();
  try {
    await empty.start();
    await writeFile(empty.auth, JSON.stringify(legacy));
    expect(await (await empty.start()).credential.list()).toEqual([]);
  } finally { await empty.close(); }
}, 60_000);
