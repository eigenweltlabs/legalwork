import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createConfiguredManagedEngine, startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { legalworkMandatoryRuntimeConfigContent, legalworkRuntimeConfigFilePath, writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { startServer } from "./server.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { closeRuntimeOpencodeConfig, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { rememberNativeChatApproval, removeNativeProjectApproval } from "./native-folder-approval.js";
import { readManagedEngineSettings } from "./managed-engine-settings.js";
import { managedEngineSettingsFilePath } from "./legalwork-runtime-config.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("managed startup stops its actual service before preserving identifiable Saved grants and reconfirming unknown origins", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-saved-startup-"))), previous = { ...process.env };
  const folders = ["known", "foreign", "unregistered"].map(name => join(root, name)), home = join(root, "home");
  for (const folder of [...folders, home]) await mkdir(folder);
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite"); process.env.XDG_CONFIG_HOME = join(root, "library");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "private", "server.json"),
    managedEngineStorageDirectory: join(root, "private"), engineConfigurationMode: "native-project", engineProjectTrustRequired: true,
    workspaces: folders.map((path, index) => ({ id: String(index), path, name: "Matter", preset: "starter", workspaceType: "local" })),
    authorizedRoots: folders, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const database = join(root, "private", "engine.db"), service = { configDirectory: orgPolicyEngineDir(config), stateDirectory: join(root, "state"), executablePath: binary };
  let original: Awaited<ReturnType<typeof createConfiguredManagedEngine>> | undefined, lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const connect = async (engine: Awaited<ReturnType<typeof createConfiguredManagedEngine>>) => {
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    // Native integrations are lazy. Initialize each registered location before
    // creating a chat with its configured agent, as the app's catalog does.
    for (const workspace of config.workspaces) {
      const location = { directory: workspace.path };
      await client.location.get({ location });
      await client.model.list({ location });
    }
    return client;
  };
  const action = "fixture.review";
  try {
    for (const workspace of config.workspaces) await writeRuntimeOpencodeConfig(config, workspace.id, () => ({ permissions: [{ action, resource: "*", effect: "ask" }] }));
    await writeLegalworkRuntimeConfigFile(config, "0");
    server = await startServer(config);
    const options = { bin: binary, cwd: home, timeoutMs: 30_000, env: {
      LEGALWORK_SERVER_URL: `http://127.0.0.1:${server.port}`, LEGALWORK_SERVER_TOKEN: config.token,
      HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: service.stateDirectory,
      OPENCODE_DB: database, OPENCODE_CONFIG: legalworkRuntimeConfigFilePath(config), OPENCODE_CONFIG_DIR: service.configDirectory, OPENCODE_CONFIG_PROJECT_DISABLE: "", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    } };
    const create = async (mode: "service" | "recovery", beforeSpawn?: () => Promise<void>) => {
      expect(original?.running() ?? false).toBe(false);
      const published = await readManagedEngineSettings(managedEngineSettingsFilePath(config), folders[0]);
      expect(published.projectPermissionApprovals.some(item => item.action === action && item.resources.includes("known-record"))).toBe(true);
      return createConfiguredManagedEngine(config, { ...options, beforeSpawn, ...(mode === "service" ? { service } : { parentLease: true }), env: { ...options.env, OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config) } });
    };
    original = await createConfiguredManagedEngine(config, { ...options, service, env: { ...options.env, OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config) } });
    let client = await connect(original);
    const known = await client.session.create({ location: { directory: folders[0] }, agent: "legalwork", permissions: [{ action, resource: "chat-denied", effect: "deny" }] });
    const unknown = await client.session.create({ location: { directory: folders[2] }, agent: "legalwork" });
    expect(known.projectID).not.toBe(unknown.projectID);
    // The native Saved API defaults to the engine's current project (home),
    // not every project. Inspect the two actual grant owners explicitly.
    const saved = async () => (await Promise.all([known.projectID, unknown.projectID].map(projectID => client.permission.saved.list({ projectID })))).flat();
    for (const [sessionID, resource] of [[known.id, "known-record"], [unknown.id, "unknown-record"]]) {
      const request = await client.permission.create({ sessionID, action, resources: [resource], save: [resource], agent: "legalwork" });
      expect(request.effect).toBe("ask"); await client.permission.reply({ sessionID, requestID: request.id, decision: "always" });
    }
    expect(await saved()).toHaveLength(2); expect(original.running()).toBe(true);
    config.workspaces = config.workspaces.slice(0, 2); config.authorizedRoots = folders.slice(0, 2);
    lifecycle = await startManagedEngineLifecycle({ config, database, service, create }); client = await connect(lifecycle.engine);
    expect(original.running()).toBe(false); expect(await saved()).toEqual([]);
    const request = (sessionID: string, resource: string) => client.permission.create({ sessionID, action, resources: [resource], save: [resource], agent: "legalwork" });
    expect((await request(known.id, "known-record")).effect).toBe("allow");
    expect((await request(known.id, "chat-denied")).effect).toBe("deny");
    const foreign = await client.session.create({ location: { directory: folders[1] }, agent: "legalwork" });
    const refused = await request(foreign.id, "known-record"); expect(refused.effect).toBe("ask"); await client.permission.reply({ sessionID: foreign.id, requestID: refused.id, decision: "reject" });
    const unknownAgain = await request(known.id, "unknown-record"); expect(unknownAgain.effect).toBe("ask");
    await rememberNativeChatApproval(config, config.workspaces[0], known.id, unknownAgain.id);
    await client.permission.reply({ sessionID: known.id, requestID: unknownAgain.id, decision: "once" });
    expect((await request(known.id, "unknown-record")).effect).toBe("allow");
    const settings = await readRuntimeOpencodeConfig(config, "0"), imported = settings.projectPermissionApprovals?.find(item => item.resources.includes("known-record"));
    expect(imported).toBeDefined(); if (!imported) throw new Error("Imported approval missing");
    await removeNativeProjectApproval(config, config.workspaces[0], imported.id);
    await lifecycle.close(); lifecycle = undefined;
    // The next startup must not replay a completed import after revocation.
    const restart = async (mode: "service" | "recovery", beforeSpawn?: () => Promise<void>) => createConfiguredManagedEngine(config, { ...options, beforeSpawn, ...(mode === "service" ? { service } : { parentLease: true }), env: { ...options.env, OPENCODE_CONFIG_CONTENT: await legalworkMandatoryRuntimeConfigContent(config) } });
    lifecycle = await startManagedEngineLifecycle({ config, database, service, create: restart }); client = await connect(lifecycle.engine);
    const revoked = await request(known.id, "known-record"); expect(revoked.effect).toBe("ask"); await client.permission.reply({ sessionID: known.id, requestID: revoked.id, decision: "reject" });
    expect((await request(known.id, "unknown-record")).effect).toBe("allow"); expect((await request(known.id, "chat-denied")).effect).toBe("deny");
    expect(await saved()).toEqual([]);
    const directory = join(root, "private", "saved-permission-originals"), files = await readdir(directory);
    const archives = files.filter(name => name.endsWith(".json") && !name.endsWith(".activated.json"));
    expect(archives).toHaveLength(1); expect(JSON.parse(await readFile(join(directory, archives[0]), "utf8")).original.rows).toHaveLength(2);
    expect(files.some(name => name.endsWith(".pending.json"))).toBe(false);
  } finally {
    await lifecycle?.close(); await original?.close(); await server?.stop(); await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
