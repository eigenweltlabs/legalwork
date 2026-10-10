import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../types.js";
import { runtimeDbPath } from "../runtime-db.js";
import { MANAGED_ENGINE_DB_FILENAME } from "../managed-opencode-db.js";
import { bootCloudSync, prepareCloudExecution } from "./lifecycle.js";
import { DirectoryObjects, CHUNK_BYTES, digest, getBlob, putBlob, type SyncObjects } from "./objects.js";
import { exportCheckpoint, recoverCheckpointRestore, remapPaths, restoreCheckpoint } from "./state.js";
import { CloudReplica } from "./replica.js";
import { SyncConfigSchema } from "./schema.js";
import { syncPreferences } from "./settings.js";
import { readProjectDetails, updateProjectDetails, updateProjectPersonalization } from "../project-store.js";
import { ReplicaResources } from "./files.js";
import { projectSyncStore } from "../project-sync-store.js";
import { entry, type StorageAdapter } from "../file-storage/common.js";
import { ChannelRuntime, type ChannelEngine } from "../channel-runtime.js";
import { randomUUID } from "node:crypto";

let root: string;
const environments = ["LEGALWORK_RUNTIME_DB", "OPENCODE_DB", "LEGALWORK_DEV_MODE", "LEGALWORK_CLOUD_SYNC_CONFIG", "XDG_CONFIG_HOME", "TZ"];
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
const settings = (deviceId: string, role: "files" | "executor" | "companion" = "executor") => SyncConfigSchema.parse({ version: 1, accountId: "test-user", deviceId, deviceName: deviceId, store: { type: "platform" }, role });

describe("private replica checkpoints", () => {
  test("checkpoint waits for ownership IO still in flight before permitting a VM snapshot", async () => {
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote);
    await replica.acquire(); await target.cloudSync!.beginCheckpoint!();
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const get = remote.get.bind(remote); let holdNext = false;
    const reads = spyOn(remote, "get").mockImplementation(async key => {
      if (key === "control.json" && holdNext) { holdNext = false; entered.resolve(); await held.promise; }
      return get(key);
    });
    const tick = spyOn(replica, "tick").mockImplementation(async () => {
      holdNext = true; void replica.renew().catch(() => {});
    });
    const checkpoint = target.cloudSync!.checkpoint!();
    try {
      await entered.promise;
      const pending = await Promise.race([checkpoint.then(() => false), Bun.sleep(20).then(() => true)]);
      expect(pending).toBe(true);
      held.resolve(); await checkpoint;
      expect(replica.canExecute()).toBe(false);
    } finally {
      held.resolve(); await checkpoint.catch(() => {}); tick.mockRestore(); reads.mockRestore();
      await replica.release(); replica.close();
    }
  });
  test("heartbeats protect a long checkpoint export but stop before the completed snapshot barrier", async () => {
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote);
    const interval = setInterval(() => {}, 999999); interval.unref();
    const timers = spyOn(globalThis, "setInterval").mockReturnValue(interval);
    const renew = spyOn(replica, "renew");
    const exporting = Promise.withResolvers<Awaited<ReturnType<CloudReplica["tick"]>>>();
    const tick = spyOn(replica, "tick").mockReturnValue(exporting.promise);
    try {
      await replica.acquire();
      const heartbeat = timers.mock.calls[0]?.[0];
      if (typeof heartbeat !== "function") throw new Error("Lease heartbeat not registered");
      const cancel = await target.cloudSync!.beginCheckpoint!();
      const checkpoint = target.cloudSync!.checkpoint!();
      heartbeat(); await replica.renew(); expect(renew).toHaveBeenCalled();
      exporting.resolve(undefined); await checkpoint; renew.mockClear();
      heartbeat();
      expect(renew).not.toHaveBeenCalled();
      cancel(); heartbeat(); expect(renew).toHaveBeenCalled(); await replica.renew();
    } finally {
      exporting.resolve(undefined); tick.mockRestore(); renew.mockRestore(); timers.mockRestore(); await replica.release(); replica.close();
    }
  });
  test("resume proves fresh ownership without waiting for a frozen renewal and fences its late failure", async () => {
    let now = 100000;
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote, () => now);
    await replica.acquire();
    const files = spyOn(replica, "syncFiles").mockResolvedValue([]);
    await target.cloudSync!.beginCheckpoint!(); await target.cloudSync!.checkpoint!(); files.mockRestore();
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const get = remote.get.bind(remote); let holdNext = true, stopped = false;
    target.cloudSync!.onLeaseLost = () => { stopped = true; };
    const reads = spyOn(remote, "get").mockImplementation(async key => {
      const response = await get(key);
      if (key === "control.json" && holdNext) { holdNext = false; entered.resolve(); await held.promise; }
      return response;
    });
    const tick = spyOn(replica, "tick").mockResolvedValue(undefined);
    const old = replica.renew().catch(error => error);
    try {
      await entered.promise; now += settings("vm").leaseMs + 1;
      const resumed = await Promise.race([target.cloudSync!.resume!(), Bun.sleep(100).then(() => null)]);
      expect(resumed?.canExecute).toBe(true);
      held.resolve(); expect(await old).toMatchObject({ code: "sync_renewal_superseded" });
      expect(stopped).toBe(false); expect(replica.canExecute()).toBe(true);
      expect((await replica.control()).value.expiresAt).toBe(now + settings("vm").leaseMs);
    } finally {
      held.resolve(); await old; tick.mockRestore(); reads.mockRestore(); await replica.release(); replica.close();
    }
  });
  test("a late renewal CAS acknowledgement cannot overwrite the resumed local lease", async () => {
    let now = 100000;
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote, () => now);
    await replica.acquire();
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const put = remote.put.bind(remote); let holdNext = true;
    const writes = spyOn(remote, "put").mockImplementation(async (key, data, expected) => {
      const result = await put(key, data, expected);
      if (key === "control.json" && holdNext) { holdNext = false; entered.resolve(); await held.promise; }
      return result;
    });
    const tick = spyOn(replica, "tick").mockResolvedValue(undefined);
    const old = replica.renew().catch(error => error);
    try {
      await entered.promise; now += 1000;
      const resumed = await Promise.race([target.cloudSync!.resume!(), Bun.sleep(100).then(() => null)]);
      expect(resumed?.canExecute).toBe(true);
      held.resolve(); expect(await old).toMatchObject({ code: "sync_renewal_superseded" });
      now += settings("vm").leaseMs - 500;
      // The original acknowledgement carried a lease already expired here.
      expect(replica.canExecute()).toBe(true);
    } finally {
      held.resolve(); await old; tick.mockRestore(); writes.mockRestore(); await replica.release(); replica.close();
    }
  });
  test("a cold executor boot returns after preparing its assistant while bulk sync is pending", async () => {
    const target = await config("vm"), remote = await store();
    process.env.LEGALWORK_CLOUD_SYNC_CONFIG = join(root, "worker-sync.json");
    await writeFile(process.env.LEGALWORK_CLOUD_SYNC_CONFIG, JSON.stringify(settings("vm")));
    const open = CloudReplica.open.bind(CloudReplica);
    const create = spyOn(CloudReplica, "open").mockImplementation((conf, profile) => open(conf, profile, remote));
    const assistant = spyOn(CloudReplica.prototype, "prepareAssistant").mockResolvedValue(undefined);
    let finish = () => {};
    const background = new Promise<Awaited<ReturnType<CloudReplica["tick"]>>>(resolve => { finish = () => resolve(undefined); });
    const bulk = spyOn(CloudReplica.prototype, "tick").mockReturnValue(background);
    let runtime: Awaited<ReturnType<typeof bootCloudSync>> = null;
    try {
      runtime = await bootCloudSync(target);
      expect(runtime?.replica.canExecute()).toBe(true);
      expect(assistant).toHaveBeenCalledTimes(1);
      expect(bulk).toHaveBeenCalledTimes(1);
    } finally {
      finish(); await background; await runtime?.stop();
      create.mockRestore(); assistant.mockRestore(); bulk.mockRestore();
    }
  });
  test("warm resume validates ownership without repeating assistant preparation or waiting for bulk refresh", async () => {
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote);
    await replica.acquire();
    const assistant = spyOn(replica, "prepareAssistant").mockResolvedValue(undefined);
    let finish = () => {};
    const background = new Promise<Awaited<ReturnType<CloudReplica["tick"]>>>(resolve => { finish = () => resolve(undefined); });
    const bulk = spyOn(replica, "tick").mockReturnValue(background);
    try {
      await target.cloudSync!.beginCheckpoint!();
      expect(replica.canExecute()).toBe(false);
      const status = await target.cloudSync!.resume!();
      expect(assistant).not.toHaveBeenCalled();
      expect(status).toMatchObject({ role: "executor", canExecute: true, nextRunAt: null });
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(replica.canExecute()).toBe(true);
    } finally {
      finish(); await background;
      assistant.mockRestore(); bulk.mockRestore();
      await replica.release(); replica.close();
    }
  });
  test("an executor rejects an unfinished initial project instead of treating it as empty", async () => {
    const target = await config("vm"), remote = await store();
    await remote.put("catalog.json", Buffer.from(JSON.stringify([{ id: target.workspaces[0].id, name: "Project", preset: "starter",
      sourcePath: "/desktop/project", projectId: null, filesReady: false }])), null);
    const replica = await CloudReplica.open(target, settings("vm"), remote);
    await expect(replica.prepareWorkspace(target.workspaces[0].id)).rejects.toMatchObject({ code: "sync_project_pending" });
    expect(replica.syncStatus().pendingProjects).toBe(1);
    replica.close();
  });
  test("a hydrated project remains executable while its incremental refresh is pending", async () => {
    const target = await config("vm"), remote = await store();
    const replica = await CloudReplica.open(target, settings("vm"), remote);
    const workspace = target.workspaces[0];
    const files = new ReplicaResources(await projectSyncStore(target), "vm");
    files.markHydrated(`project:${workspace.id}`, workspace.path);
    const batch = Promise.withResolvers<{ ran: boolean; pushed: number; pulled: number; arrived: number; removed: number; error: string | null }>();
    const refresh = replica.prepareWorkspace(workspace.id, false, true, batch.promise).catch(() => {});
    try {
      const ready = await Promise.race([replica.prepareWorkspace(workspace.id).then(() => true), Bun.sleep(50).then(() => false)]);
      expect(ready).toBe(true);
    } finally {
      batch.resolve({ ran: false, pushed: 0, pulled: 0, arrived: 0, removed: 0, error: null });
      await refresh; replica.close();
    }
  });
  test("a checkpointed VM survives lease expiry and renewals resumed after suspension", async () => {
    let now = 100000;
    const target = await config("paused"), remote = await store();
    const replica = await CloudReplica.open(target, settings("paused"), remote, () => now);
    let stopped = false;
    target.cloudSync!.onLeaseLost = () => { stopped = true; };
    const assistant = spyOn(replica, "prepareAssistant").mockResolvedValue(undefined);
    const files = spyOn(replica, "syncFiles").mockResolvedValue([]);
    try {
      await replica.acquire();
      await target.cloudSync!.beginCheckpoint!();
      await target.cloudSync!.checkpoint!();
      expect((await replica.control()).value.checkpoint).not.toBeNull();
      files.mockClear();
      now += settings("paused").leaseMs + 1;
      await replica.tick();
      expect(files).not.toHaveBeenCalled();
      // A renewal accepted before suspension may finish after the lease ends.
      await expect(replica.renew()).rejects.toThrow("ownership changed");
      expect(stopped).toBe(false);
      expect(replica.canExecute()).toBe(false);
      await target.cloudSync!.resume!();
      expect(replica.canExecute()).toBe(true);
      expect(stopped).toBe(false);
      await replica.tick();
    } finally {
      await replica.release(); replica.close();
      assistant.mockRestore(); files.mockRestore();
    }
  });

  test("a paused VM still stops if another execution owner takes over", async () => {
    let now = 100000;
    const remote = await store(), target = await config("old");
    const one = await CloudReplica.open(target, settings("old"), remote, () => now);
    const two = await CloudReplica.open(await config("new"), settings("new"), remote, () => now);
    const close = remote.close.bind(remote); remote.close = () => {}; closers.push(close);
    let stopped = false;
    target.cloudSync!.onLeaseLost = () => { stopped = true; };
    try {
      await one.acquire();
      await target.cloudSync!.beginCheckpoint!();
      now += settings("old").leaseMs + 1;
      await two.acquire();
      await expect(one.renew()).rejects.toThrow("ownership changed");
      expect(stopped).toBe(true);
      await expect(target.cloudSync!.resume!()).rejects.toThrow("Another VM");
      expect(one.canExecute()).toBe(false);
    } finally { await two.release(); one.close(); two.close(); }
  });
  test("engine snapshots retain required empty credential schemas and scoped event history", async () => {
    const source = await config("desktop"), remote = await store();
    const db = await database(join(dirname(runtimeDbPath(source)), MANAGED_ENGINE_DB_FILENAME));
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, data TEXT); CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT); CREATE TABLE account (id TEXT PRIMARY KEY, access_token TEXT); CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT); CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT)");
    db.run("INSERT INTO session VALUES (?, ?)", ["kept", source.workspaces[0].path]);
    db.run("INSERT INTO session VALUES (?, ?)", ["outside", "/unrelated"]);
    db.exec("INSERT INTO event VALUES ('e1', 'kept', '{}'), ('e2', 'outside', '{}'); INSERT INTO event_sequence VALUES ('kept', 2, 'old-host'), ('outside', 3, 'old-host'); INSERT INTO account VALUES ('a', 'PRIVATE_ACCOUNT_SECRET'); INSERT INTO account_state VALUES (1, 'a'); INSERT INTO credential VALUES ('c', 'PRIVATE_CREDENTIAL_SECRET'); INSERT INTO session_input VALUES ('queued', 'kept', 'Pending desktop prompt')");
    const checkpoint = await exportCheckpoint(source, remote, { companionSeed: true });
    const copy = join(root, "engine-seed.sqlite"); await getBlob(remote, checkpoint.engine!, copy);
    const restored = new Database(copy, { readonly: true });
    try {
      expect(restored.query("SELECT * FROM account").all()).toEqual([]);
      expect(restored.query("SELECT * FROM account_state").all()).toEqual([]);
      expect(restored.query("SELECT * FROM credential").all()).toEqual([]);
      expect(restored.query("SELECT * FROM session_input").all()).toEqual([]);
      expect(restored.query("SELECT id FROM event").all()).toEqual([{ id: "e1" }]);
      expect(restored.query("SELECT * FROM event_sequence").all()).toEqual([{ aggregate_id: "kept", seq: 2, owner_id: null }]);
      const bytes = (await readFile(copy)).toString();
      expect(bytes).not.toContain("PRIVATE_ACCOUNT_SECRET"); expect(bytes).not.toContain("PRIVATE_CREDENTIAL_SECRET");
      expect(db.query("SELECT id FROM account").all()).toEqual([{ id: "a" }]);
    } finally { restored.close(); }
  });
  test("companion seeds preserve history without replaying local queues or schedules", async () => {
    const source = await config("desktop"), remote = await store();
    const db = await database(runtimeDbPath(source));
    db.exec("CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE scheduled_task_runs (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE assistant_session_queue (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE assistant_delegations (id TEXT PRIMARY KEY, data TEXT)");
    db.run("INSERT INTO scheduled_tasks VALUES (?, ?)", ["active", JSON.stringify({ status: "active", nextRunAt: "2026-10-09T12:00:00Z" })]);
    db.run("INSERT INTO scheduled_tasks VALUES (?, ?)", ["completed", JSON.stringify({ status: "completed", nextRunAt: null })]);
    db.run("INSERT INTO scheduled_task_runs VALUES (?, ?)", ["pending", JSON.stringify({ status: "dispatching" })]);
    db.run("INSERT INTO scheduled_task_runs VALUES (?, ?)", ["history", JSON.stringify({ status: "sent" })]);
    db.exec("INSERT INTO assistant_session_queue VALUES ('q', '{}'); INSERT INTO assistant_delegations VALUES ('d', '{}')");
    const checkpoint = await exportCheckpoint(source, remote, { companionSeed: true });
    const copy = join(root, "companion-seed.sqlite");
    await getBlob(remote, checkpoint.runtime!, copy);
    const restored = new Database(copy, { readonly: true });
    try {
      expect(restored.query("SELECT json_extract(data, '$.status') AS status, json_extract(data, '$.nextRunAt') AS due FROM scheduled_tasks WHERE id = 'active'").get()).toEqual({ status: "paused", due: null });
      expect(restored.query("SELECT json_extract(data, '$.status') AS status FROM scheduled_tasks WHERE id = 'completed'").get()).toEqual({ status: "completed" });
      expect(restored.query("SELECT id FROM scheduled_task_runs").all()).toEqual([{ id: "history" }]);
      expect(restored.query("SELECT id FROM assistant_session_queue").all()).toEqual([]);
      expect(restored.query("SELECT id FROM assistant_delegations").all()).toEqual([]);
      expect(db.query("SELECT json_extract(data, '$.status') AS status FROM scheduled_tasks WHERE id = 'active'").get()).toEqual({ status: "active" });
      expect(db.query("SELECT id FROM assistant_session_queue").all()).toEqual([{ id: "q" }]);
    } finally { restored.close(); }
  });
  test("channel receipts and control outcomes survive a checkpoint without replaying agent work", async () => {
    const source = await config("computer"), remote = await store();
    let sends = 0, commands = 0;
    const engine: ChannelEngine = { current: async () => ({ workspaceId: "ws_portable", sessionId: "ses_existing" }),
      validate: async () => {}, hasMessage: async () => true, busy: async () => false,
      send: async () => { sends++; }, result: async () => ({ state: "completed", text: "Cached result" }) };
    const input = { id: randomUUID(), userId: "user-a", orgId: "org-a", conversationId: randomUUID(), channel: "ios", text: "Diagnostic", attachments: [] };
    const command = { id: randomUUID(), userId: "user-a", orgId: "org-a", command: { kind: "assistant.stop", revision: 1 } };
    const inbox = await ChannelRuntime.open(runtimeDbPath(source), engine, () => true);
    await inbox.accept(input); await inbox.inspect(input.id);
    await inbox.command(command, async () => { commands++; return { stopped: true }; });
    expect(inbox.approvalRevision("pending", "content")).toBe(1); inbox.close();
    const checkpoint = await exportCheckpoint(source, remote), target = await config("vm");
    await restoreCheckpoint(target, remote, checkpoint, join(root, "vm-projects"), false);
    const restored = await ChannelRuntime.open(runtimeDbPath(target), engine, () => true);
    try {
      expect((await restored.accept(input)).textResult).toBe("Cached result");
      expect(await restored.command(command, async () => { commands++; return {}; })).toEqual({ state: "completed", result: { stopped: true } });
      expect(restored.approvalRevision("pending", "content")).toBe(1);
      await expect(restored.accept({ ...input, orgId: "different" })).rejects.toThrow("another account");
      expect(sends).toBe(1); expect(commands).toBe(1);
    } finally { restored.close(); }
  });
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

test("companion desktops execute locally alongside a cloud lease and never replace its checkpoint", async () => {
  const source = await config("desktop-companion"), target = await config("cloud-executor"), objects = await store();
  source.workspaces = []; target.workspaces = [];
  const desktop = await CloudReplica.open(source, settings("desktop", "companion"), objects);
  closers.push(() => desktop.close());
  expect(desktop.canExecute()).toBe(true);
  expect(await desktop.seedCompanion()).toBe(true);
  const initial = (await desktop.control()).value.checkpoint?.sha256;
  const cloud = await CloudReplica.open(target, settings("cloud"), objects);
  closers.push(() => cloud.close());
  await cloud.acquire();
  expect(desktop.canExecute()).toBe(true);
  expect(cloud.canExecute()).toBe(true);
  await expect(desktop.publishState()).rejects.toThrow("ownership");
  await desktop.tick();
  expect((await desktop.control()).value.checkpoint?.sha256).toBe(initial);
  expect(await desktop.seedCompanion()).toBe(false);
  const release = await source.cloudSync!.beginCheckpoint!();
  expect(desktop.canExecute()).toBe(false);
  expect(cloud.canExecute()).toBe(true);
  release();
  expect(desktop.canExecute()).toBe(true);
  await cloud.release();
});
