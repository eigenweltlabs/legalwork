import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../types.js";
import { runtimeDbPath } from "../runtime-db.js";
import { MANAGED_ENGINE_DB_FILENAME } from "../managed-opencode-db.js";
import { prepareCloudExecution } from "./lifecycle.js";
import { DirectoryObjects, CHUNK_BYTES, digest, getBlob, putBlob, type SyncObjects } from "./objects.js";
import { exportCheckpoint, recoverCheckpointRestore, remapPaths, restoreCheckpoint } from "./state.js";
import { CloudReplica } from "./replica.js";
import { SyncConfigSchema } from "./schema.js";
import { syncPreferences } from "./settings.js";
import { readProjectDetails, updateProjectDetails, updateProjectPersonalization } from "../project-store.js";
import { ReplicaResources } from "./files.js";
import { projectSyncStore } from "../project-sync-store.js";
import { entry, type StorageAdapter } from "../file-storage/common.js";

let root: string;
const environments = ["LEGALWORK_RUNTIME_DB", "OPENCODE_DB", "LEGALWORK_DEV_MODE", "XDG_CONFIG_HOME", "TZ"];
const saved = new Map<string, string | undefined>();
const databases: Database[] = [];
const closers: Array<() => void> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-cloud-sync-"));
  for (const key of environments) { saved.set(key, process.env[key]); delete process.env[key]; }
  process.env.XDG_CONFIG_HOME = join(root, "global-config");
  process.env.TZ = "Europe/Berlin";
});
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const db of databases.splice(0)) db.close();
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

async function config(name: string): Promise<ServerConfig> {
  const path = join(root, name, "project");
  await mkdir(path, { recursive: true });
  return { host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host", configPath: join(root, name, "server.json"),
    approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "ws_portable", name: "Project", path, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [path], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
}
async function database(path: string) { await mkdir(dirname(path), { recursive: true }); const db = new Database(path); databases.push(db); return db; }
async function store() { const result = await DirectoryObjects.open(join(root, "remote")); closers.push(() => result.close()); return result; }
const settings = (deviceId: string, role: "files" | "executor" = "executor") => SyncConfigSchema.parse({ version: 1, accountId: "test-user", deviceId, deviceName: deviceId, store: { type: "platform" }, role });

describe("private replica checkpoints", () => {
  test("resources reuse project file bases, retain unchanged files and restore a missing directory safely", async () => {
    const target = await config("vm"), projectStore = await projectSyncStore(target);
    const files = new ReplicaResources(projectStore, "worker"), bytes = Buffer.from("Private skill");
    let downloads = 0;
    const adapter: StorageAdapter = {
      list: async () => ({ entries: [] }), listFiles: async () => ({ entries: [{ ...entry("SKILL.md", "file", bytes.length, null), version: digest(bytes) }] }),
      stat: async () => ({ size: bytes.length, version: digest(bytes), contentType: "text/plain" }),
      read: async () => ({ data: bytes, size: bytes.length, version: digest(bytes), contentType: "text/plain" }),
      download: async (_path, destination) => {
        if (!destination) throw new Error("Missing destination");
        downloads++; await writeFile(destination, bytes, { flag: "wx" });
        return { size: bytes.length, version: digest(bytes), sha256: digest(bytes) };
      },
      write: async () => { throw new Error("Unexpected upload"); }, upload: async () => { throw new Error("Unexpected upload"); }, mkdir: async () => {},
      deleteFile: async () => { throw new Error("A missing VM directory must not delete cloud files"); },
    };
    const directory = join(root, "skills");
    expect((await files.sync(adapter, "skills", directory, "Cloud VM")).downloaded).toBe(1);
    expect(projectStore.fileBase("personal:worker:skills").entries().size).toBe(1);
    expect(files.isHydrated("skills", directory)).toBe(true);
    await files.sync(adapter, "skills", directory, "Cloud VM");
    expect(downloads).toBe(1);
    await rm(directory, { recursive: true });
    expect((await files.sync(adapter, "skills", directory, "Cloud VM")).removedRemote).toBe(0);
    expect(downloads).toBe(2);
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("Private skill");
  });

  test("path remapping preserves literal conversation text and custom instructions", () => {
    const projects = [{ id: "ws", name: "Project", preset: "starter", sourcePath: "/computer/project", projectId: null }];
    const value = { text: "/computer/project is the folder I discussed", personalization: { customInstructions: "/computer/project must stay literal" },
      file: { url: "file:///computer/project/Contract.docx", path: "/computer/project/Contract.docx" } };
    expect(remapPaths(value, projects, new Map([["ws", "/vm/project"]]))).toEqual({ ...value,
      file: { url: "file:///vm/project/Contract.docx", path: "/vm/project/Contract.docx" } });
  });

  test("an interrupted multi-database restore is replayed before engine launch", async () => {
    const source = await config("computer"), remote = await store();
    await updateProjectDetails(source.workspaces[0].path, { revision: 0, fields: [{ id: "client", label: "Client", type: "text", value: "Private client" }] });
    await updateProjectPersonalization(source.workspaces[0].path, { revision: 1, customInstructions: "Private project instructions" });
    const db = await database(runtimeDbPath(source));
    db.exec("CREATE TABLE assistant_days (workspace_id TEXT, date TEXT, session_id TEXT, PRIMARY KEY(workspace_id,date)) WITHOUT ROWID");
    db.run("INSERT INTO assistant_days VALUES ('ws_portable', '2026-10-08', 'ses_existing')");
    const checkpoint = await exportCheckpoint(source, remote), target = await config("vm");
    const validConfigPath = target.configPath;
    target.configPath = join(dirname(runtimeDbPath(target)), "invalid-config");
    await mkdir(target.configPath);
    await expect(restoreCheckpoint(target, remote, checkpoint, join(root, "vm-projects"), false)).rejects.toThrow();
    target.configPath = validConfigPath;
    expect(await recoverCheckpointRestore(target)).toBe(true);
    expect(await recoverCheckpointRestore(target)).toBe(false);
    const restored = new Database(runtimeDbPath(target), { readonly: true });
    try { expect(restored.query("SELECT session_id FROM assistant_days").all()).toEqual([{ session_id: "ses_existing" }]); }
    finally { restored.close(); }
    expect(JSON.parse(await readFile(target.configPath!, "utf8")).workspaces[0].id).toBe("ws_portable");
  });

  test("restores complete session identities, paths, permissions and assistant state without credentials or machine caches", async () => {
    const source = await config("computer"), remote = await store();
    await updateProjectDetails(source.workspaces[0].path, { revision: 0, fields: [{ id: "client", label: "Client", type: "text", value: "Private client" }] });
    await updateProjectPersonalization(source.workspaces[0].path, { revision: 1, customInstructions: "Private project instructions" });
    const runtime = await database(runtimeDbPath(source));
    runtime.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE assistant_days (workspace_id TEXT, date TEXT, session_id TEXT, PRIMARY KEY(workspace_id,date));
      CREATE TABLE session_group_states (workspace_id TEXT PRIMARY KEY, state_json TEXT, schema_version INTEGER, updated_at INTEGER);
      CREATE TABLE eigenwelt_connections (id TEXT PRIMARY KEY, secret TEXT);
      CREATE TABLE project_file_base (id TEXT PRIMARY KEY, cached TEXT);`);
    runtime.run("INSERT INTO eigenwelt_connections VALUES ('account', 'SOURCE_AUTH_SECRET')");
    runtime.run("INSERT INTO project_file_base VALUES ('cache', 'machine-specific')");
    runtime.run("INSERT INTO assistant_days VALUES ('ws_portable', '2026-10-08', 'ses_existing')");
    runtime.run("INSERT INTO session_group_states VALUES ('ws_portable', ?, 1, 10)", [JSON.stringify({ groups: [{ id: "g1", label: "Matter" }], assignments: { ses_existing: "g1" } })]);
    runtime.run("INSERT INTO runtime_opencode_configs VALUES ('ws_portable', ?, 10)", [JSON.stringify({
      permission: { bash: "ask", external_directory: { [`${source.workspaces[0].path}/**`]: "allow", "/outside/**": "allow" } },
      personalization: { personality: "friendly", customInstructions: "Keep answers short" }, provider: { apiKey: "SOURCE_PROVIDER_SECRET" }, mcp: { headers: { token: "SOURCE_MCP_SECRET" } },
    })]);
    const engine = await database(join(dirname(runtimeDbPath(source)), MANAGED_ENGINE_DB_FILENAME));
    engine.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
      CREATE TABLE auth (provider TEXT PRIMARY KEY, secret TEXT);`);
    engine.run("INSERT INTO session VALUES ('ses_existing', ?, 'Existing conversation')", [source.workspaces[0].path]);
    engine.run("INSERT INTO session VALUES ('ses_unrelated', '/other-project', 'Standalone')");
    engine.run("INSERT INTO message VALUES ('msg_existing', 'ses_existing', ?)", [JSON.stringify({ role: "user", time: { created: 10 } })]);
    engine.run("INSERT INTO part VALUES ('prt_existing', 'ses_existing', 'msg_existing', ?)", [JSON.stringify({ type: "file", url: `file://${source.workspaces[0].path}/Contract.docx` })]);
    engine.run("INSERT INTO auth VALUES ('provider', 'ENGINE_AUTH_SECRET')");

    const checkpoint = await exportCheckpoint(source, remote);
    expect(checkpoint.timeZone).toBe("Europe/Berlin");
    const sanitized = join(root, "sanitized.sqlite");
    await getBlob(remote, checkpoint.runtime!, sanitized);
    const bytes = (await readFile(sanitized)).toString();
    for (const secret of ["SOURCE_AUTH_SECRET", "SOURCE_PROVIDER_SECRET", "SOURCE_MCP_SECRET", "machine-specific"]) expect(bytes).not.toContain(secret);

    const target = await config("vm");
    const targetRuntime = await database(runtimeDbPath(target));
    targetRuntime.exec("CREATE TABLE eigenwelt_connections (id TEXT PRIMARY KEY, secret TEXT)");
    targetRuntime.run("INSERT INTO eigenwelt_connections VALUES ('target', 'TARGET_AUTH_SECRET')");
    await restoreCheckpoint(target, remote, checkpoint, join(root, "vm-projects"), false);
    expect(target.workspaces[0].id).toBe("ws_portable");
    expect(await readProjectDetails(target.workspaces[0].path)).toMatchObject({ fields: [{ id: "client", value: "Private client" }], personalizationPrompt: "Private project instructions" });
    const restored = new Database(runtimeDbPath(target), { readonly: true });
    try {
      expect(restored.query("SELECT session_id FROM assistant_days").get()).toEqual({ session_id: "ses_existing" });
      expect(restored.query("SELECT secret FROM eigenwelt_connections").get()).toEqual({ secret: "TARGET_AUTH_SECRET" });
      const row = restored.query<{ config_json: string }, []>("SELECT config_json FROM runtime_opencode_configs").get()!;
      expect(JSON.parse(row.config_json)).toMatchObject({ permission: { bash: "ask", external_directory: { [`${target.workspaces[0].path}/**`]: "allow", "*": "deny" } } });
      expect(row.config_json).not.toContain("/outside/");
    } finally { restored.close(); }
    const restoredEngine = new Database(join(dirname(runtimeDbPath(target)), MANAGED_ENGINE_DB_FILENAME), { readonly: true });
    try {
      expect(restoredEngine.query("SELECT id, directory FROM session").all()).toEqual([{ id: "ses_existing", directory: target.workspaces[0].path }]);
      expect(restoredEngine.query("SELECT id, session_id FROM message").all()).toEqual([{ id: "msg_existing", session_id: "ses_existing" }]);
      expect(restoredEngine.query<{ data: string }, []>("SELECT data FROM part").get()!.data).toContain(target.workspaces[0].path);
      expect(restoredEngine.query("SELECT name FROM sqlite_master WHERE name = 'auth'").get()).toBeNull();
    } finally { restoredEngine.close(); }
    await expect(restoreCheckpoint(target, remote, checkpoint, join(root, "vm-projects"), false)).rejects.toThrow("--replace");
  });

  test("unchanged chunks are reused and corrupt downloads never replace a local file", async () => {
    const remote = await store(), source = Buffer.alloc(CHUNK_BYTES + 100, 7);
    let puts = 0;
    const counted: SyncObjects = { get: key => remote.get(key), stat: key => remote.stat(key), put: (key, data, version) => { puts++; return remote.put(key, data, version); } };
    const first = await putBlob(counted, source);
    expect(puts).toBe(2);
    source[source.length - 1] = 8;
    const second = await putBlob(counted, source);
    expect(puts).toBe(3);
    expect(first.chunks[0]).toBe(second.chunks[0]);
    await remote.put(`blobs/${second.chunks[1]}`, Buffer.from("corrupt"), await remote.stat(`blobs/${second.chunks[1]}`));
    const destination = join(root, "existing.docx");
    await writeFile(destination, "keep me");
    await expect(getBlob(remote, second, destination)).rejects.toThrow("corrupt");
    expect(await readFile(destination, "utf8")).toBe("keep me");
  });

  test("one executor owns a checkpoint and an expired VM cannot overwrite its successor", async () => {
    const remote = await store();
    let now = 100000;
    const one = await CloudReplica.open(await config("one"), settings("one"), remote, () => now);
    const two = await CloudReplica.open(await config("two"), settings("two"), remote, () => now);
    // Shared injected store is closed once by the test harness.
    const originalClose = remote.close.bind(remote); remote.close = () => {};
    closers.push(originalClose);
    closers.push(() => one.close(), () => two.close());
    await one.acquire();
    await expect(two.acquire()).rejects.toThrow("Another device");
    const checkpoint = await one.publishState();
    expect(checkpoint.projects[0].id).toBe("ws_portable");
    now += settings("one").leaseMs + 1;
    expect(one.canExecute()).toBe(false);
    await two.acquire();
    await expect(one.renew()).rejects.toThrow("ownership changed");
    await expect(one.publishState()).rejects.toThrow("ownership");
    await two.release();
  });

  test("files-only devices cannot execute copied sessions", async () => {
    const target = await config("files"), remote = await store();
    const replica = await CloudReplica.open(target, settings("files", "files"), remote);
    const originalClose = remote.close.bind(remote); remote.close = () => {}; closers.push(originalClose, () => replica.close());
    await expect(replica.acquire()).rejects.toThrow("syncs files");
    await expect(prepareCloudExecution(target, "ws_portable")).rejects.toThrow("cloud execution owner");
  });

  test("quiescing drains accepted engine writes and blocks new ones before checking idle state", async () => {
    const target = await config("owner"), remote = await store();
    const replica = await CloudReplica.open(target, settings("owner"), remote);
    const originalClose = remote.close.bind(remote); remote.close = () => {}; closers.push(originalClose, () => replica.close());
    await replica.acquire();
    let finish: (response: Response) => void = () => { throw new Error("No accepted request"); };
    const accepted = target.cloudSync!.runEngineRequest!(() => new Promise<Response>(resolve => { finish = resolve; }));
    await Promise.resolve();
    let drained = false;
    const checkpoint = target.cloudSync!.beginCheckpoint!().then(cancel => { drained = true; return cancel; });
    expect(replica.canExecute()).toBe(false);
    expect(() => target.cloudSync!.runEngineRequest!(() => Promise.resolve(new Response()))).toThrow("paused or unavailable");
    expect(drained).toBe(false);
    finish(new Response());
    await accepted;
    const cancel = await checkpoint;
    expect(drained).toBe(true);
    cancel();
    expect(replica.canExecute()).toBe(true);
    await replica.release();
  });

  test("preferences converge without transferring provider credentials or changing their original edit timestamp", async () => {
    const one = await config("one"), two = await config("two"), remote = await store();
    const db = await database(runtimeDbPath(one));
    db.exec("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("INSERT INTO runtime_opencode_configs VALUES ('ws_portable', ?, 100)", [JSON.stringify({ permission: { bash: "ask" }, provider: { key: "DO_NOT_SYNC" },
      agent: { custom: { prompt: "Follow these instructions", model: "eigenwelt/chat", options: { apiKey: "AGENT_SECRET" } } } })]);
    await syncPreferences(one, remote);
    const object = await remote.get("settings/ws_portable.json");
    expect(object?.data.toString()).not.toContain("DO_NOT_SYNC");
    expect(object?.data.toString()).not.toContain("AGENT_SECRET");
    expect(JSON.parse(object!.data.toString()).config.agent.custom).toEqual({ prompt: "Follow these instructions", model: "eigenwelt/chat" });
    await syncPreferences(two, remote);
    const target = new Database(runtimeDbPath(two), { readonly: true });
    try { expect(target.query("SELECT updated_at FROM runtime_opencode_configs").get()).toEqual({ updated_at: 100 }); } finally { target.close(); }
    const revision = await remote.stat("settings/ws_portable.json");
    await syncPreferences(two, remote);
    expect(await remote.stat("settings/ws_portable.json")).toBe(revision);
  });
});
