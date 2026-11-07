import { Database } from "bun:sqlite";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { createEngineClient } from "./engine-client.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { prepareLocalProjects } from "./project-storage.js";
import { migrateLocalProjectSessions, projectSessionMovesPending } from "./project-storage-sessions.js";
import type { ServerConfig } from "./types.js";
import { runtimeDbPath } from "./runtime-db.js";
import { benchmarksDbPath, openBenchmarkStore } from "./benchmarks/store.js";
import { grantWikiAgentSession, currentWikiAgentSession } from "./wiki/agent-access.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("pinned engine moves existing parent/child chats and scoped permissions without a model turn", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-project-move-")));
  const source = join(root, "connected");
  for (const name of ["connected/.legalwork/attachments", "connected/.opencode", "home", "config", "data", "state", "cache"]) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(source, ".legalwork/attachments/mail.txt"), "Retained attachment");
  await writeFile(join(source, "contract.txt"), "Retained document");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", configPath: join(root, "private/server.json"),
    projectsDirectory: join(root, "local"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "ws_retained", name: "Matter", path: source, workspaceType: "local", preset: "starter" }], authorizedRoots: [source],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    engine = await createManagedOpencodeServer({ bin: binary, cwd: source, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "0",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const parent = await client.session.create({ location: { directory: source }, title: "Saved matter", permissions: [{ action: "read", resource: "private/*", effect: "deny" }, { action: "*", resource: "curl *", effect: "deny" }] });
    const child = await client.session.create({ parentID: parent.id, title: "Saved helper" });
    expect(child.location.directory).toBe(source);
    const benchmarkDirectory = join(source, ".legalwork/benchmarks/run/item");
    await mkdir(benchmarkDirectory, { recursive: true });
    const benchmark = await client.session.create({ location: { directory: benchmarkDirectory }, title: "Saved benchmark", permissions: [{ action: "edit", resource: "private/*", effect: "deny" }] });
    await mkdir(join(root, "private"), { recursive: true });
    const state = new Database(runtimeDbPath(config));
    const reference = join(source, ".opencode/skills/chosen/SKILL.md"), resourceId = JSON.stringify(["skill", "ws_retained", reference]);
    state.exec("CREATE TABLE assistant_session_access (session_id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE assistant_proactivity_state (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE assistant_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, routing TEXT NOT NULL)");
    const authority = { scope: "collaborator", scheduledProjects: ["ws_retained"] };
    await grantWikiAgentSession(config, { sessionId: parent.id, directory: source, scope: "collaborator", scheduledProjects: authority.scheduledProjects });
    state.query("INSERT INTO assistant_session_access VALUES (?, ?)").run(parent.id, JSON.stringify({ directory: source, authority, revoked: false }));
    state.query("INSERT INTO assistant_session_access VALUES (?, ?)").run(child.id, JSON.stringify({ directory: source, authority, revoked: true }));
    state.query("INSERT INTO assistant_proactivity_state VALUES ('scratchpad-source', ?)").run(JSON.stringify({ sessionId: parent.id, directory: source, authority }));
    state.query("INSERT INTO assistant_settings VALUES (1, ?, ?)").run(JSON.stringify({ systemPromptAddition: source, resourceIds: [resourceId], projectAccess: { mode: "include", projectIds: ["ws_retained"] } }), JSON.stringify([{ id: resourceId, kind: "skill", reference, name: "Chosen", description: "Saved choice", projectId: "ws_retained", projectName: "Matter" }]));
    state.close();
    await openBenchmarkStore(config);
    const benchmarks = new Database(benchmarksDbPath(config));
    benchmarks.query("INSERT INTO benchmark_runs (id, workspace_id, status, judge_provider_id, judge_model_id, created_at) VALUES ('run', 'ws_retained', 'completed', 'fixture', 'fixture', 1)").run();
    benchmarks.query("INSERT INTO benchmark_run_items (id, run_id, task_source, task_key, task_title, work_type, vertical, task_json, provider_id, model_id, status, session_id, work_dir) VALUES ('item', 'run', 'local', 'task', 'Task', 'drafting', 'legal', '{}', 'fixture', 'fixture', 'completed', ?, ?)").run(benchmark.id, benchmarkDirectory);
    expect(await prepareLocalProjects(config)).toBe(true);
    expect(await projectSessionMovesPending(config)).toBe(true);
    config.readOnly = true;
    await migrateLocalProjectSessions(config, client);
    expect((await client.session.get({ sessionID: parent.id })).location.directory).toBe(source);
    expect(await projectSessionMovesPending(config)).toBe(true);
    config.readOnly = false;
    await migrateLocalProjectSessions(config, client);
    const local = config.workspaces[0]!;
    for (const id of [parent.id, child.id]) expect((await client.session.get({ sessionID: id })).location.directory).toBe(local.path);
    const moved = await client.session.get({ sessionID: parent.id });
    expect(moved.id).toBe(parent.id); expect(moved.title).toBe(parent.title); expect(moved.time.created).toBe(parent.time.created);
    expect(moved.permissions).toContainEqual({ action: "read", resource: `${source}/private/*`, effect: "deny" });
    expect(moved.permissions).toContainEqual({ action: "*", resource: "curl *", effect: "deny" });
    const nested = await client.session.get({ sessionID: benchmark.id });
    expect(nested.location.directory).toBe(join(local.path, ".legalwork/benchmarks/run/item"));
    expect(nested.permissions).toContainEqual({ action: "edit", resource: join(local.path, ".legalwork/benchmarks/run/item/private/*"), effect: "deny" });
    expect(benchmarks.query("SELECT work_dir FROM benchmark_run_items WHERE id = 'item'").get()).toEqual({ work_dir: nested.location.directory });
    benchmarks.close();
    const saved = new Database(runtimeDbPath(config));
    expect(currentWikiAgentSession(config, parent.id)).toMatchObject({ directory: local.path, scope: "collaborator", scheduledProjects: authority.scheduledProjects });
    const dataRow = z.object({ data: z.string() });
    const access = dataRow.array().parse(saved.query("SELECT data FROM assistant_session_access ORDER BY session_id").all()).map(row => JSON.parse(row.data));
    expect(access).toEqual(expect.arrayContaining([{ directory: local.path, authority, revoked: false }, { directory: local.path, authority, revoked: true }]));
    expect(JSON.parse(dataRow.parse(saved.query("SELECT data FROM assistant_proactivity_state").get()).data)).toEqual({ sessionId: parent.id, directory: local.path, authority });
    const settings = z.object({ settings: z.string(), routing: z.string() }).parse(saved.query("SELECT settings, routing FROM assistant_settings").get());
    const newReference = join(local.path, ".opencode/skills/chosen/SKILL.md");
    expect(JSON.parse(String(settings?.settings))).toEqual({ systemPromptAddition: source, resourceIds: [JSON.stringify(["skill", "ws_retained", newReference])], projectAccess: { mode: "include", projectIds: ["ws_retained"] } });
    expect(JSON.parse(String(settings?.routing))[0].reference).toBe(newReference);
    saved.close();
    expect(await projectSessionMovesPending(config)).toBe(false);
    await migrateLocalProjectSessions(config, client);
    expect(await readFile(join(local.path, ".legalwork/attachments/mail.txt"), "utf8")).toBe("Retained attachment");
    expect(await readFile(join(source, "contract.txt"), "utf8")).toBe("Retained document");
    expect(await client.session.active()).toEqual({});
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const scoped = createEngineClient(config, local);
    const admitted = await scoped.session.prompt({ sessionID: parent.id, text: "Retained queued attachment", resume: false,
      files: [{ uri: pathToFileURL(join(source, ".legalwork/attachments/mail.txt")).href }] });
    expect(admitted.id).toBeTruthy();
    expect(await client.session.active()).toEqual({});
  } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

// Minimal V1 tables and records follow the pinned engine's V1 database fixture.
// The real native migration, startup coordinator and filesystem run below.
function seedLegacyHistory(path: string, directory: string, projectID: string, broken: boolean) {
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT,
      cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
    const now = Date.now() - 1000;
    db.query("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)")
      .run("ses_storage_v1", projectID, "storage-v1", directory, "Before upgrade", "1", now, now);
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("msg_storage_v1", "ses_storage_v1", now, now,
      JSON.stringify({ role: "user", time: { created: now }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } }));
    db.query("INSERT INTO part VALUES (?,?,?,?,?,?)").run("prt_storage_v1", "msg_storage_v1", "ses_storage_v1", now, now,
      JSON.stringify({ type: "text", text: "Original V1 message" }));
    db.query("DELETE FROM kv WHERE key=?").run("migration.v1-v2");
    if (broken) db.exec("ALTER TABLE session DROP COLUMN cost");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
}

test.skipIf(!binary).each([false, true])("managed startup completes V1 migration before folder cutover (migration fails: %s)", async broken => {
  const { startEmbeddedServer } = await import("./embedded.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-managed-storage-")));
  const source = join(root, "connected"), engineRoot = join(root, "engine");
  for (const name of ["connected/.legalwork/attachments", "connected/.opencode", "engine", "home", "config", "data", "state", "cache"]) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(source, ".legalwork/attachments/mail.txt"), "Offline attachment");
  await writeFile(join(source, "contract.txt"), "External document");
  const changes = { XDG_CONFIG_HOME: join(root, "config"), OPENCODE_DB: undefined, LEGALWORK_RUNTIME_DB: undefined, LEGALWORK_OPENCODE_BIN: binary, OPENCODE_DISABLE_MODELS_FETCH: "1" };
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  let seed: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    seed = await createManagedOpencodeServer({ bin: binary, cwd: source, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(engineRoot, "opencode-engine-v2.db"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
    } });
    const seedClient = OpenCode.make({ baseUrl: seed.url, headers: { authorization: `Basic ${Buffer.from(`${seed.username}:${seed.password}`).toString("base64")}` } });
    const schemaChat = await seedClient.session.create({ location: { directory: source }, title: "Schema bootstrap" });
    await seedClient.session.remove({ sessionID: schemaChat.id });
    await seed.close(); seed = undefined;
    seedLegacyHistory(join(engineRoot, "opencode-engine-v2.db"), source, schemaChat.projectID, broken);
    const chat = { id: "ses_storage_v1" };
    const configPath = join(root, "server.json");
    await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "ws_managed", name: "Matter", path: source, workspaceType: "local" }], authorizedRoots: [source], token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 } }));
    const options = { configPath, workspaces: [], host: "127.0.0.1", port: 0, manageOpencode: true, opencodeBin: binary,
      projectsDirectory: join(root, "local"), managedEngineStorageDirectory: engineRoot, opencodeCwd: join(root, "home"), opencodeDirectory: source };
    if (broken) {
      await expect(startEmbeddedServer(options)).rejects.toThrow("migration failed");
      expect((await stat(join(source, ".legalwork"))).isDirectory()).toBe(true);
      expect(await readFile(join(source, ".legalwork/attachments/mail.txt"), "utf8")).toBe("Offline attachment");
      expect(await stat(join(root, "local")).catch(() => null)).toBeNull();
      expect(JSON.parse(await readFile(configPath, "utf8")).workspaces[0].path).toBe(source);
      return;
    }
    server = await startEmbeddedServer(options);
    const workspace = server.config.workspaces[0]!;
    expect(server.selectedWorkspaceId).toBe(workspace.id);
    expect(workspace.path).toBe(join(root, "local", "ws_managed"));
    expect(workspace.contentPath).toBe(source);
    expect((await createEngineClient(server.config, workspace).session.get({ sessionID: chat.id })).location.directory, JSON.stringify(server.config.managedEngineRecoveryState?.())).toBe(workspace.path);
    expect(server.config.managedEngineRecoveryState?.().mode).toBe("service");
    const migrated = createEngineClient(server.config, workspace);
    expect((await migrated.migration.v1.status()).status).toBe("completed");
    expect(JSON.stringify(await migrated.message.list({ sessionID: chat.id }))).toContain("Original V1 message");
    await server.stop(); server = undefined;
    await rm(source, { recursive: true });
    server = await startEmbeddedServer(options);
    const restored = server.config.workspaces[0]!;
    expect(server.selectedWorkspaceId).toBe(restored.id);
    expect(restored.path).toBe(workspace.path);
    expect((await createEngineClient(server.config, restored).session.get({ sessionID: chat.id })).title).toBe("Before upgrade");
    const response = await fetch(`${server.url}/workspace/${restored.id}/files/content?path=.legalwork%2Fattachments%2Fmail.txt`, { headers: { authorization: "Bearer synthetic" } });
    expect(response.status).toBe(200);
    expect((await response.json()).content).toBe("Offline attachment");
  } finally {
    await server?.stop(); await seed?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
