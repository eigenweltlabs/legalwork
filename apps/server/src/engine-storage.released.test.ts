import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { engineStorageDir } from "./engine-storage.js";
import { engineProjectStatus, nativeEngineProjectRegistryPath } from "./engine-project.js";
import { closeRuntimeOpencodeConfig, GLOBAL_MCP_ID, GLOBAL_TOOL_PERMISSIONS_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, managedEngineSettingsFilePath, mandatoryRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { readManagedEngineSettings } from "./managed-engine-settings.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { createConfiguredManagedEngine, startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { prepareManagedOpencodeEngineDb } from "./managed-opencode-db.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("desktop and CLI share live settings and project selections while engine artifacts and service ownership stay isolated", async () => {
  const root = await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-engine-storage-"));
  const previous = { ...process.env };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "shared", "runtime.sqlite");
  process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.LEGALWORK_DEV_MODE = "1"; delete process.env.OPENCODE_DB;
  const directory = join(root, "matter"); await mkdir(directory);
  const desktop: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "shared", "server.json"), token: "fixture", hostToken: "fixture-host", workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [directory], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, agentSandboxEnabled: true, engineProjectTrustRequired: true };
  const cli: ServerConfig = { ...desktop, managedEngineStorageDirectory: join(root, "cli-engine"), agentSandboxEnabled: false };
  const engines: Array<Awaited<ReturnType<typeof startManagedEngineLifecycle>>> = [];
  try {
    await writeRuntimeOpencodeConfig(desktop, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "shell", resource: "*", effect: "ask" }, { action: "webfetch", resource: "*", effect: "deny" }] }));
    await writeRuntimeOpencodeConfig(desktop, "matter", () => ({ agents: { custom: { system: "Shared authored agent", permissions: [{ action: "shell", resource: "*", effect: "deny" }, { action: "webfetch", resource: "*", effect: "ask" }] } } }));
    await writeLegalworkRuntimeConfigFile(desktop, "matter");
    const projection = (await engineProjectStatus(desktop, desktop.workspaces[0]!)).projection.path;
    if (!projection) throw new Error("Missing shared selection document");
    const before = await readFile(projection, "utf8"), identity = await stat(projection);
    const protectedPaths = [legalworkRuntimeConfigFilePath(desktop), mandatoryRuntimeConfigFilePath(desktop), managedEngineSettingsFilePath(desktop), join(orgPolicyEngineDir(desktop), "opencode.json"), nativeEngineProjectRegistryPath(desktop)];
    const protectedBytes = await Promise.all(protectedPaths.map(path => readFile(path, "utf8")));
    await writeLegalworkRuntimeConfigFile(cli, "matter");
    expect(await Promise.all(protectedPaths.map(path => readFile(path, "utf8")))).toEqual(protectedBytes);
    expect(await readFile(projection, "utf8")).toBe(before);
    expect((await stat(projection)).ino).toBe(identity.ino);
    expect((await stat(projection)).mtimeMs).toBe(identity.mtimeMs);
    expect(engineStorageDir(desktop)).not.toBe(engineStorageDir(cli));
    const protectedPolicy = JSON.parse(await readFile(join(orgPolicyEngineDir(desktop), "opencode.json"), "utf8"));
    expect(protectedPolicy.policies).toContainEqual({ action: "tool.use", resource: "shell:*", effect: "deny" });
    const hostPolicy = JSON.parse(await readFile(join(orgPolicyEngineDir(cli), "opencode.json"), "utf8"));
    expect(hostPolicy.policies).not.toContainEqual({ action: "tool.use", resource: "shell:*", effect: "deny" });
    expect((await engineProjectStatus(cli, cli.workspaces[0]!)).state).toBe("ready");
    await writeRuntimeOpencodeConfig(cli, GLOBAL_MCP_ID, () => ({ mcp: { servers: { shared: { type: "remote", url: "http://127.0.0.1:7/mcp", disabled: true } } } }));
    expect((await readRuntimeOpencodeConfig(desktop, GLOBAL_MCP_ID)).mcp?.servers).toHaveProperty("shared");
    await Promise.all([writeLegalworkRuntimeConfigFile(desktop, "matter"), writeLegalworkRuntimeConfigFile(cli, "matter")]);
    for (const config of [desktop, cli]) expect((await readManagedEngineSettings(managedEngineSettingsFilePath(config), directory)).configuration).toMatchObject({ mcp: { servers: { shared: { disabled: true } } } });
    for (const [index, config] of [desktop, cli].entries()) {
      const database = await prepareManagedOpencodeEngineDb(config);
      if (!database) throw new Error("A private engine database is required");
      expect(database.path.startsWith(engineStorageDir(config))).toBe(true);
      const home = join(engineStorageDir(config), "engine-home"); await mkdir(home, { recursive: true });
      const service = { configDirectory: orgPolicyEngineDir(config), stateDirectory: join(home, "state") };
      engines.push(await startManagedEngineLifecycle({ config, database: database.path, service, create: async (mode, beforeSpawn) => createConfiguredManagedEngine(config, { bin: binary, cwd: home, beforeSpawn, ...(mode === "service" ? { service } : { parentLease: true }), timeoutMs: 30_000,
        env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(root, `native-data-${index}`), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: service.stateDirectory,
          OPENCODE_DB: database.path, OPENCODE_CONFIG_DIR: orgPolicyEngineDir(config), OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config), OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      }) }));
    }
    const first = engines[0], second = engines[1]; if (!first || !second) throw new Error("Both isolated engine owners are required");
    expect(first.engine.pid).not.toBe(second.engine.pid);
    const client = OpenCode.make({ baseUrl: first.engine.url, headers: { authorization: `Basic ${Buffer.from(`${first.engine.username}:${first.engine.password}`).toString("base64")}` } });
    expect((await client.server.info()).pid).toBe(first.engine.pid!);
    await second.close(); engines.pop();
    expect((await client.server.info()).pid).toBe(first.engine.pid!);
    process.env.OPENCODE_DB = join(root, "explicit.db");
    expect(await prepareManagedOpencodeEngineDb(cli)).toBeNull();
  } finally {
    for (const engine of engines.reverse()) await engine.close();
    await closeRuntimeOpencodeConfig(desktop);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
