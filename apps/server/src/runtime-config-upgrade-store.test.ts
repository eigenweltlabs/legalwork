import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyGlobalToolPermissions, closeRuntimeOpencodeConfig, GLOBAL_MCP_ID, GLOBAL_TOOL_PERMISSIONS_ID, readGlobalToolPermissions,
  readRuntimeConfigUpgradeBackups, readRuntimeOpencodeConfig, runtimeConfigUpgradeNotices, runtimeEngineConfiguration, writeRuntimeOpencodeConfig, onRuntimeOpencodeConfigWrite, writeSandboxRuntimeConfig, bootstrapRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { SANDBOX_DEFAULT_ID, sandboxSessionId, writeSandboxDefault, writeSessionSandbox } from "./agent-sandbox/settings.js";
import { openNativeConfigState } from "./native-config-state.js";
import { resetOrgPolicyRuntimeForTests } from "./org-policy.js";
import { closeEigenweltConnectionForTests } from "./eigenwelt-connection-store.js";

async function fixture(run: (config: ServerConfig, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-config-upgrade-"));
  const path = join(root, "runtime.sqlite"), previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = path;
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  try { await run(config, path); }
  finally {
    await resetOrgPolicyRuntimeForTests(config);
    await closeRuntimeOpencodeConfig(config);
    await closeEigenweltConnectionForTests(config);
    if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous;
    await rm(root, { recursive: true, force: true });
  }
}
function seed(path: string, id: string, json: string) {
  const db = new Database(path);
  try {
    db.run("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("INSERT INTO runtime_opencode_configs VALUES (?, ?, ?)", [id, json, 1]);
  } finally { db.close(); }
}
function row(path: string, id: string, retired = false) {
  const db = new Database(path, { readonly: true });
  try { return db.query<{ json: string; updatedAt: number }, [string]>(`SELECT config_json AS json, updated_at AS updatedAt FROM ${retired ? "runtime_opencode_configs" : "native_runtime_configs"} WHERE workspace_id = ?`).get(id); }
  finally { db.close(); }
}

test.each(["legacy", "blocked", "native"])("startup repairs %s MCP settings, retaining originals, credentials and restrictions", kind => fixture(async (config, path) => {
  const original = JSON.stringify({ configurationVersion: 2, permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    mcp: { servers: { fibery: { type: "remote", url: "https://fixture.invalid/mcp", enabled: false,
      headers: { Authorization: "Bearer synthetic-token" }, oauth: { client_id: "synthetic-client", client_secret: "synthetic-secret", scope: "read" } } } } });
  if (kind === "native") {
    const previousBuild = await openNativeConfigState(path);
    previousBuild.upsert({ workspaceId: GLOBAL_MCP_ID, configJson: original, updatedAt: 1 });
    previousBuild.close();
    await expect(readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).rejects.toMatchObject({ status: 409 });
    await closeRuntimeOpencodeConfig(config);
  } else {
    seed(path, GLOBAL_MCP_ID, original);
    if (kind === "blocked") {
      const previousBuild = await openNativeConfigState(path, () => { throw new Error("Historical MCP schema mismatch"); });
      expect(() => previousBuild.get(GLOBAL_MCP_ID)).toThrow();
      previousBuild.close();
    }
  }
  await bootstrapRuntimeOpencodeConfig(config);
  const imported = await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID);
  expect(imported.mcp?.servers?.fibery).toEqual({ type: "remote", url: "https://fixture.invalid/mcp", disabled: true,
    headers: { Authorization: "Bearer synthetic-token" }, oauth: { client_id: "synthetic-client", client_secret: "synthetic-secret", scope: "read" } });
  expect(imported.permissions).toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
  const backups = await readRuntimeConfigUpgradeBackups(config, GLOBAL_MCP_ID);
  expect(backups).toHaveLength(1);
  expect(backups[0]?.configJson).toBe(original);
  await writeRuntimeOpencodeConfig(config, GLOBAL_MCP_ID, current => ({ ...current,
    mcp: { ...current.mcp, servers: { ...current.mcp?.servers, fibery: { ...current.mcp?.servers?.fibery, type: "remote", url: "https://fixture.invalid/mcp", disabled: false } } } }));
  const edited = row(path, GLOBAL_MCP_ID);
  await closeRuntimeOpencodeConfig(config);
  await bootstrapRuntimeOpencodeConfig(config);
  expect((await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers?.fibery.disabled).toBe(false);
  expect(row(path, GLOBAL_MCP_ID)).toEqual(edited);
  expect(await readRuntimeConfigUpgradeBackups(config, GLOBAL_MCP_ID)).toEqual(backups);
}));

test("startup does not repair conflicting or otherwise invalid native settings", () => fixture(async (config, path) => {
  const original = JSON.stringify({ configurationVersion: 2, permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    mcp: { servers: { fibery: { type: "remote", url: "https://fixture.invalid/mcp", enabled: false, disabled: false } } } });
  const previousBuild = await openNativeConfigState(path);
  previousBuild.upsert({ workspaceId: GLOBAL_MCP_ID, configJson: original, updatedAt: 1 });
  previousBuild.close();
  await bootstrapRuntimeOpencodeConfig(config);
  await expect(readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).rejects.toMatchObject({ status: 409 });
  expect(row(path, GLOBAL_MCP_ID)).toEqual({ json: original, updatedAt: 1 });
  expect(await readRuntimeConfigUpgradeBackups(config, GLOBAL_MCP_ID)).toEqual([]);
}));

test.each([false, true])("v1 UI custom providers import with their exact selected models (previously blocked=%s)", async blocked => fixture(async (config, path) => {
  const original = JSON.stringify({ provider: { openai: { npm: "@ai-sdk/openai-compatible", name: "Custom endpoint", options: { baseURL: "https://example.invalid/v1" }, whitelist: ["selected"], models: { selected: { name: "Selected" }, excluded: { name: "Old definition" } } } } });
  seed(path, "project", original);
  if (blocked) {
    const previousBuild = await openNativeConfigState(path, () => { throw new Error("Unsupported model allowlist"); });
    expect(() => previousBuild.get("project")).toThrow();
    previousBuild.close();
  }
  await bootstrapRuntimeOpencodeConfig(config);
  const migrated = await readRuntimeOpencodeConfig(config, "project");
  expect(migrated.providerModelSelection).toEqual({ openai: ["selected"] });
  expect(Object.keys(migrated.providers?.openai.models ?? {})).toEqual(["selected"]);
  expect((await readRuntimeConfigUpgradeBackups(config, "project"))[0]?.configJson).toBe(original);
  await writeRuntimeOpencodeConfig(config, "project", current => ({ ...current, providerModelSelection: { openai: [] } }));
  await closeRuntimeOpencodeConfig(config);
  await bootstrapRuntimeOpencodeConfig(config);
  expect((await readRuntimeOpencodeConfig(config, "project")).providerModelSelection).toEqual({ openai: [] });
}));

for (const [oldID, id] of [["azure-cognitive-services", "azure"], ["google-vertex-anthropic", "google-vertex"]]) {
  test.each(["legacy", "blocked", "native"])(`startup repairs %s ${oldID} settings once and retains later edits`, kind => fixture(async (config, path) => {
    const settings = { apiKey: "synthetic-key", baseURL: "https://custom.example.invalid/v1" };
    const original = JSON.stringify(kind === "native" ? { configurationVersion: 2,
      providers: { [oldID]: { package: "@opencode/ai/providers/openai-compatible", settings, models: { selected: {}, excluded: { disabled: true } } } },
      agents: { legalwork: { model: { providerID: oldID, model: "selected" } } },
      policies: [{ action: "provider.use", resource: oldID, effect: "deny" }],
      providerActivation: { [oldID]: "deny" }, providerModelSelection: { [oldID]: ["selected"] },
    } : { provider: { [oldID]: { npm: "@ai-sdk/openai-compatible", options: settings, whitelist: ["selected"], models: { selected: {}, excluded: {} } } },
      agent: { legalwork: { model: `${oldID}/selected` } }, disabled_providers: [oldID], providerActivation: { [oldID]: "deny" } });
    if (kind === "native") {
      const previousBuild = await openNativeConfigState(path);
      previousBuild.upsert({ workspaceId: "project", configJson: original, updatedAt: 1 });
      previousBuild.close();
    } else {
      seed(path, "project", original);
      if (kind === "blocked") {
        const previousBuild = await openNativeConfigState(path, () => { throw new Error("Previous import failed"); });
        previousBuild.close();
      }
    }
    await bootstrapRuntimeOpencodeConfig(config);
    const imported = await readRuntimeOpencodeConfig(config, "project");
    expect(Object.keys(imported.providers ?? {})).toEqual([id]);
    expect(imported.providers?.[id].settings).toEqual(settings);
    expect(imported.agents?.legalwork.model).toMatchObject({ providerID: id, model: "selected" });
    expect(imported.policies).toEqual([{ action: "provider.use", resource: id, effect: "deny" }]);
    expect(imported.providerActivation).toEqual({ [id]: "deny" });
    expect(imported.providerModelSelection).toEqual({ [id]: ["selected"] });
    const backups = await readRuntimeConfigUpgradeBackups(config, "project");
    expect(backups).toHaveLength(1);
    expect(backups[0]?.configJson).toBe(original);
    await writeRuntimeOpencodeConfig(config, "project", current => ({ ...current,
      providers: { [id]: { ...current.providers?.[id], settings: { ...settings, apiKey: "synthetic-newer-key" } } }, providerModelSelection: { [id]: [] } }));
    const edited = row(path, "project");
    await closeRuntimeOpencodeConfig(config);
    await bootstrapRuntimeOpencodeConfig(config);
    expect(row(path, "project")).toEqual(edited);
    expect((await readRuntimeOpencodeConfig(config, "project")).providerModelSelection).toEqual({ [id]: [] });
    expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual(backups);
  }));
}

test.each(["normal", "sandbox-repair"])("%s writes notify every revocation listener before surfacing the first failure", async kind => fixture(async (config, path) => {
  const id = kind === "normal" ? "project" : SANDBOX_DEFAULT_ID;
  if (kind === "sandbox-repair") seed(path, id, "{ invalid original sandbox");
  await bootstrapRuntimeOpencodeConfig(config);
  const calls: string[] = [], first = new Error("First revocation failed"), second = new Error("Second revocation failed");
  const stops = [
    onRuntimeOpencodeConfigWrite((source, workspace) => { if (source === config && workspace === id) { calls.push("first"); throw first; } }),
    onRuntimeOpencodeConfigWrite((source, workspace) => { if (source === config && workspace === id) { calls.push("second"); throw second; } }),
    onRuntimeOpencodeConfigWrite((source, workspace, change) => { if (source === config && workspace === id) calls.push(`last:${change?.permissionsChanged}`); }),
  ];
  try {
    const operation = kind === "normal"
      ? writeRuntimeOpencodeConfig(config, id, () => ({ permissions: [{ action: "read", resource: "*", effect: "deny" }] }))
      : writeSandboxRuntimeConfig(config, { kind: "default" }, () => ({ sandbox: { enabled: true, networkMode: "block" } }));
    await expect(operation).rejects.toBe(first);
    expect(calls).toEqual(["first", "second", "last:true"]);
    expect((await readRuntimeOpencodeConfig(config, id)).configurationVersion).toBe(2);
    if (kind === "sandbox-repair") expect((await readRuntimeConfigUpgradeBackups(config, id))[0]?.configJson).toBe("{ invalid original sandbox");
  } finally { for (const stop of stops) stop(); }
}));

test("explicit bootstrap upgrades once, atomically retaining the exact original and explicit generation notices", async () => fixture(async (config, path) => {
  const original = '{\n "agent": {"restricted":{"prompt":"Keep","permission":"deny","temperature":0.2,"options":{"private":"synthetic-secret"}}}, "providers":{"openai":{"models":{"fixture":{"capabilities":{"temperature":false},"variants":[{"id":"high","settings":{"reasoningEffort":"high"}}]}}}}\n}';
  seed(path, "project", original);
  await bootstrapRuntimeOpencodeConfig(config);
  const migrated = await readRuntimeOpencodeConfig(config, "project");
  expect(migrated.configurationVersion).toBe(2);
  expect(migrated.agents?.restricted.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  expect(migrated.providers?.openai.models?.fixture.capabilities?.temperature).toBe(false);
  expect(migrated.providers?.openai.models?.fixture.variants).toMatchObject([{ id: "high", settings: { reasoningEffort: "high" } }]);
  expect(migrated).not.toHaveProperty("agent");
  const backups = await readRuntimeConfigUpgradeBackups(config, "project");
  expect(backups).toHaveLength(1); expect(backups[0]?.configJson).toBe(original);
  const notice = await runtimeConfigUpgradeNotices(config, "project");
  expect(notice).toEqual([{ code: "legacy_agent_generation_requires_native_support", agentId: "restricted", fields: ["private", "temperature"] }]);
  expect(JSON.stringify(notice)).not.toContain("synthetic-secret");
  const saved = row(path, "project");
  expect(JSON.parse(saved?.json ?? "null").configurationVersion).toBe(2);
  expect(await readRuntimeOpencodeConfig(config, "project")).toEqual(migrated);
  expect(row(path, "project")).toEqual(saved);
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual(backups);
}));

test("native save/reload and reopening retain native model-only overrides and project restrictions", async () => fixture(async (config, path) => {
  const providers = { openai: { models: { fixture: { capabilities: { temperature: false, reasoning: { supported: true, effort: ["low", "high"] } }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] } } } };
  await writeRuntimeOpencodeConfig(config, "project", () => ({ providers: runtimeEngineConfiguration({ providers }).providers, permissions: [{ action: "read", resource: "/outside/*", effect: "deny" }] }));
  await closeRuntimeOpencodeConfig(config);
  const reopened = await readRuntimeOpencodeConfig(config, "project");
  expect(reopened.providers).toMatchObject(providers);
  expect(reopened.permissions).toEqual([{ action: "read", resource: "/outside/*", effect: "deny" }]);
  expect(runtimeEngineConfiguration(reopened)).not.toHaveProperty("configurationVersion");
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual([]);
  expect(JSON.parse(row(path, "project")?.json ?? "null").configurationVersion).toBe(2);
}));

test("normal writes cannot reintroduce a legacy field or overwrite a failed restricted upgrade", async () => fixture(async (config, path) => {
  const malformed = '{"agent":{"restricted":{"permission":"invalid"}}}';
  seed(path, "invalid", malformed);
  await bootstrapRuntimeOpencodeConfig(config);
  await writeRuntimeOpencodeConfig(config, "native", () => ({ permissions: [{ action: "*", resource: "*", effect: "deny" }] }));
  const before = row(path, "native");
  await expect(writeRuntimeOpencodeConfig(config, "native", current => { Reflect.set(current, "permission", "allow"); return current; })).rejects.toThrow();
  expect(row(path, "native")).toEqual(before);
  await expect(readRuntimeOpencodeConfig(config, "invalid")).rejects.toMatchObject({ status: 409, code: "execution_settings_invalid" });
  await expect(writeRuntimeOpencodeConfig(config, "invalid", () => ({}))).rejects.toMatchObject({ status: 409 });
  expect(row(path, "invalid", true)?.json).toBe(malformed);
  expect((await readRuntimeConfigUpgradeBackups(config, "invalid"))[0]?.configJson).toBe(malformed);
}));

test("explicit sandbox repairs retain exact corrupt bytes and cannot reset an ordinary project", async () => fixture(async (config, path) => {
  seed(path, SANDBOX_DEFAULT_ID, "{ broken default");
  const sessionID = sandboxSessionId("project", "chat");
  seed(path, sessionID, '["broken session"]');
  seed(path, "project", '{"permissions":[{"action":"*","resource":"*","effect":"invalid"}]}');
  await bootstrapRuntimeOpencodeConfig(config);
  await expect(writeRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID, () => ({}))).rejects.toMatchObject({ status: 409 });
  await writeSandboxDefault(config, { enabled: true, networkMode: "block" });
  await writeSessionSandbox(config, "project", "chat", { enabled: true, networkMode: "approve" });
  expect((await readRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID)).sandbox).toEqual({ enabled: true, networkMode: "block" });
  expect((await readRuntimeOpencodeConfig(config, sessionID)).sandbox).toEqual({ enabled: true, networkMode: "approve" });
  expect((await readRuntimeConfigUpgradeBackups(config, SANDBOX_DEFAULT_ID))[0]?.configJson).toBe("{ broken default");
  expect((await readRuntimeConfigUpgradeBackups(config, sessionID))[0]?.configJson).toBe('["broken session"]');
  expect(await runtimeConfigUpgradeNotices(config, sessionID)).toEqual([{ code: "sandbox_settings_repaired", fields: ["sandbox"] }]);
  await expect(writeRuntimeOpencodeConfig(config, "project", () => ({}))).rejects.toMatchObject({ status: 409 });
  expect((await readRuntimeConfigUpgradeBackups(config, "project"))[0]?.configJson).toBe('{"permissions":[{"action":"*","resource":"*","effect":"invalid"}]}');
}));

test("an unknown future version is retained and blocked rather than guessed or downgraded", async () => fixture(async (config, path) => {
  const original = '{"configurationVersion":3,"permissions":[{"action":"*","resource":"*","effect":"deny"}]}';
  seed(path, "future", original);
  await bootstrapRuntimeOpencodeConfig(config);
  await expect(readRuntimeOpencodeConfig(config, "future")).rejects.toMatchObject({ status: 409 });
  expect(row(path, "future", true)?.json).toBe(original);
}));

test("concurrent native edits preserve each change without repeating an upgrade", async () => fixture(async (config, path) => {
  seed(path, "project", '{"permission":{"read":"ask"}}');
  await bootstrapRuntimeOpencodeConfig(config);
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeRuntimeOpencodeConfig(config, "project", current => ({
    ...current, providers: { ...current.providers, [`provider_${index}`]: { name: `Provider ${index}` } },
  }))));
  const result = await readRuntimeOpencodeConfig(config, "project");
  expect(Object.keys(result.providers ?? {})).toHaveLength(20);
  expect(result.permissions).toEqual([]);
  expect(await runtimeConfigUpgradeNotices(config, "project")).toEqual([{ code: "legacy_workspace_tool_permissions_inactive", fields: ["read"] }]);
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toHaveLength(1);
}));

test("upgrading old workspace tool rules cannot activate formerly ignored grants over global restrictions", async () => fixture(async (config, path) => {
  seed(path, GLOBAL_TOOL_PERMISSIONS_ID, '{"permission":{"bash":"deny"}}');
  seed(path, "project", '{"permission":{"bash":"allow","external_directory":{"/case/*":"allow"}},"permissions":[{"action":"read","resource":"/private/*","effect":"deny"}]}');
  await bootstrapRuntimeOpencodeConfig(config);
  const global = await readGlobalToolPermissions(config);
  const workspace = await readRuntimeOpencodeConfig(config, "project");
  expect(global).toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
  expect(workspace.permissions).toEqual([{ action: "external_directory", resource: "/case/*", effect: "allow" }, { action: "read", resource: "/private/*", effect: "deny" }]);
  expect(applyGlobalToolPermissions(workspace, global).permissions).toEqual([...global, ...workspace.permissions ?? []]);
  expect(await runtimeConfigUpgradeNotices(config, "project")).toEqual([{ code: "legacy_workspace_tool_permissions_inactive", fields: ["shell"] }]);
}));

test("global host rules and project rules remain ordered native rules", async () => fixture(async (config) => {
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "shell", resource: "*", effect: "ask" }, { action: "external_directory", resource: "/not-global/*", effect: "allow" }] }));
  const global = await readGlobalToolPermissions(config);
  expect(global).toEqual([{ action: "shell", resource: "*", effect: "ask" }]);
  expect(applyGlobalToolPermissions({ permissions: [{ action: "shell", resource: "rm *", effect: "deny" }, { action: "external_directory", resource: "/case/*", effect: "allow" }] }, global).permissions).toEqual([
    { action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "rm *", effect: "deny" }, { action: "external_directory", resource: "/case/*", effect: "allow" },
  ]);
}));
