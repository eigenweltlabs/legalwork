import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type JsonValue } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { LEGACY_MANAGED_ENGINE_DB_FILENAME, prepareManagedOpencodeEngineDb } from "./managed-opencode-db.js";
import { legacyHistoryBackupDirectory, hashHistoryFile } from "./history-v1-backup.js";
import { importLegacySessionPermissionRules, restoreLegacySessionPermissions } from "./session-history-permissions.js";
import { startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const rpc = { id: "fixture.legacy-session-permissions", methods: { run: { input: { type: "object" }, output: { type: "string" } } }, events: {} };

/** The legacy tables below match the pinned core v1-migration test schema.
 * They are synthetic fixtures; the actual released V2 binary performs import,
 * permission evaluation, persistence and restart. No model is called. */
test.skipIf(!binary)("nonempty legacy chat permissions survive native import, actual file tools and restart without becoming project grants", async () => {
  if (!binary) throw new Error("Released engine binary is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-legacy-chat-permissions-")));
  for (const name of ["matter", "home", "config", "state", "data", "cache", "probe"]) await mkdir(join(root, name));
  const directory = join(root, "matter"), source = join(root, "state", LEGACY_MANAGED_ENGINE_DB_FILENAME);
  const activationMarker = join(root, "automation-started.txt");
  const allowedFile = join(directory, "allowed.txt"), deniedFile = join(directory, "denied.txt"), askFile = join(directory, "ask.txt");
  await Promise.all([allowedFile, deniedFile, askFile].map(path => writeFile(path, path === allowedFile ? "ALLOWED-FIXTURE" : path === deniedFile ? "DENIED-FIXTURE" : "ASK-FIXTURE")));
  await writeFile(join(root, "probe", "index.js"), `import{Plugin}from'@opencode/plugin';import{writeFile}from'node:fs/promises';export default Plugin.define({id:'fixture.legacy-session-permissions',async setup(ctx){await writeFile(${JSON.stringify(activationMarker)},'activated');let outcome='pending';await ctx.rpc.register(${JSON.stringify(rpc)},{async run(input){if(input.mode==='result')return outcome;const session=await ctx.session.get({sessionID:input.sessionID});const tool=(await ctx.tool.list()).find(tool=>tool.name==='read');if(!tool)throw new Error('Native read tool missing');const perform=()=>tool.execute({path:input.path},{sessionID:session.id,agent:session.agent||'build',messageID:'msg_legacy_permission_probe',id:'call_legacy_permission_probe',signal:new AbortController().signal,progress:async()=>{}});if(input.mode==='start'){outcome='pending';void perform().then(()=>{outcome='allowed'},()=>{outcome='rejected'});return 'started'}return JSON.stringify(await perform())}})}});`);
  const environment = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, permissions: [{ action: "*", resource: "*", effect: "allow" }], plugins: [join(root, "probe")] }) };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  const ownedModes: string[] = [], ownedChildren: Awaited<ReturnType<typeof createManagedOpencodeServer>>[] = [];
  const previous = new Map(["OPENCODE_DB", "LEGALWORK_RUNTIME_DB", "LEGALWORK_DEV_MODE", "XDG_DATA_HOME"].map(key => [key, process.env[key]]));
  const config: ServerConfig = { configPath: join(root, "state", "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const workspace = config.workspaces[0];
  if (!workspace) throw new Error("Synthetic matter is missing");
  try {
    // Bootstrap only the current native schema before adding the exact legacy
    // tables. This avoids a dependency on a downloaded V1 executable.
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, parentLease: true, env: { ...environment, OPENCODE_DB: source } });
    await engine.close(); engine = undefined;
    const sessionID = "ses_legacy_permission_fixture";
    const legacyRules = [{ permission: "*", pattern: "*", action: "allow" }, { permission: "read", pattern: "denied.txt", action: "deny" }, { permission: "read", pattern: "ask.txt", action: "ask" },
      { permission: "bash", pattern: "dangerous-fixture *", action: "deny" }, { permission: "task", pattern: "*", action: "deny" }, { permission: "edit", pattern: "*", action: "ask" }];
    const db = new Database(source);
    try {
      db.exec(`CREATE TABLE session(id text PRIMARY KEY,project_id text NOT NULL,workspace_id text,parent_id text,slug text NOT NULL,directory text NOT NULL,path text,title text NOT NULL,version text NOT NULL,share_url text,
        summary_additions integer,summary_deletions integer,summary_files integer,summary_diffs text,metadata text,cost real DEFAULT 0 NOT NULL,tokens_input integer DEFAULT 0 NOT NULL,tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,tokens_cache_read integer DEFAULT 0 NOT NULL,tokens_cache_write integer DEFAULT 0 NOT NULL,revert text,permission text,agent text,model text,time_created integer NOT NULL,time_updated integer NOT NULL,time_compacting integer,time_archived integer);
        CREATE TABLE message(id text PRIMARY KEY,session_id text NOT NULL,time_created integer NOT NULL,time_updated integer NOT NULL,data text NOT NULL);
        CREATE TABLE part(id text PRIMARY KEY,message_id text NOT NULL,session_id text NOT NULL,time_created integer NOT NULL,time_updated integer NOT NULL,data text NOT NULL);`);
      db.prepare("INSERT INTO project(id,worktree,vcs,time_created,time_updated,sandboxes) VALUES(?,?,?,?,?,?)").run("legacy-case-source", directory, "git", 1, 1, "[]");
      db.prepare("INSERT INTO session(id,project_id,slug,directory,title,version,permission,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)").run(sessionID, "legacy-case-source", "fixture", directory, "Legacy policy fixture", "1.18.29", JSON.stringify(legacyRules), 123456789, 123456789);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    const originalHash = await hashHistoryFile(source);
    delete process.env.OPENCODE_DB; delete process.env.LEGALWORK_DEV_MODE;
    process.env.LEGALWORK_RUNTIME_DB = join(root, "state", "runtime.sqlite"); process.env.XDG_DATA_HOME = join(root, "data");
    const prepared = await prepareManagedOpencodeEngineDb(config);
    if (!prepared) throw new Error("Private native history copy is missing");
    expect(prepared.seededFrom).toBe(source);
    const start = async () => {
      const started = await createManagedOpencodeServer({ bin: binary, cwd: directory, parentLease: true, env: { ...environment, OPENCODE_DB: prepared.path } });
      engine = started;
      return { engine: started, client: OpenCode.make({ baseUrl: started.url, headers: { Authorization: `Basic ${Buffer.from(`${started.username}:${started.password}`).toString("base64")}` } }) };
    };
    const initial = await start();
    let client = initial.client;
    expect((await client.migration.v1.status()).status).toBe("completed");
    const imported = await client.session.get({ sessionID });
    expect(existsSync(activationMarker)).toBe(false);
    expect(imported.permissions ?? []).toEqual([]);
    const before = new Database(prepared.path, { readonly: true });
    try { expect(before.query("SELECT permission FROM session_v2 WHERE id=?").get(sessionID)).toEqual({ permission: null }); } finally { before.close(); }
    // Prove the exact supported restoration operation is passive before the
    // lifecycle's event monitoring/service startup may activate normal plugins.
    await client.session.update({ sessionID, permissions: importLegacySessionPermissionRules(legacyRules) });
    expect(existsSync(activationMarker)).toBe(false);
    await client.session.update({ sessionID, permissions: [] });
    expect(existsSync(activationMarker)).toBe(false);
    await initial.engine.close(); engine = undefined;
    const startOwned = async () => {
      const service = { configDirectory: join(root, "owned-config"), stateDirectory: join(root, "owned-state") };
      lifecycle = await startManagedEngineLifecycle({ config, database: prepared.path, service, create: async (mode, beforeSpawn) => {
        expect(ownedChildren.filter(child => child.running())).toHaveLength(0);
        if (mode === "service") {
          // The original rule is restored before native service startup is
          // allowed to resume interrupted automation.
          const saved = new Database(prepared.path, { readonly: true });
          try { expect(saved.query("SELECT permission FROM session_v2 WHERE id=?").get(sessionID)).toMatchObject({ permission: expect.any(String) }); } finally { saved.close(); }
        }
        ownedModes.push(mode);
        const child = await createManagedOpencodeServer({ bin: binary, cwd: directory, beforeSpawn, ...(mode === "service" ? { service } : { parentLease: true }), env: { ...environment, OPENCODE_DB: prepared.path } });
        ownedChildren.push(child); return child;
      } });
      const deadline = Date.now() + 30000;
      while (config.managedEngineRecoveryState?.().mode !== "service") {
        if (Date.now() > deadline) throw new Error("Legacy policy restoration did not permit native service promotion: " + JSON.stringify({ state: config.managedEngineRecoveryState?.(), ownedModes, marker: existsSync(activationMarker) }));
        await Bun.sleep(10);
      }
      const current = lifecycle.engine;
      return OpenCode.make({ baseUrl: current.url, headers: { Authorization: `Basic ${Buffer.from(`${current.username}:${current.password}`).toString("base64")}` } });
    };
    client = await startOwned();
    expect(ownedModes).toEqual(["recovery", "service"]);
    const invoke = (mode: string, path = allowedFile) => client.rpc.call({ rpcID: rpc.id, method: "run", location: { directory }, input: { sessionID, mode, path } }, { signal: AbortSignal.timeout(10000) });
    const restored = await restoreLegacySessionPermissions(config, workspace, client, await client.session.get({ sessionID }));
    expect(restored.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "denied.txt", effect: "deny" }, { action: "read", resource: "ask.txt", effect: "ask" },
      { action: "shell", resource: "dangerous-fixture *", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "ask" }]);
    const checkEffects = async () => {
      expect((await invoke("read")).output).toContain("ALLOWED-FIXTURE");
      expect(existsSync(activationMarker)).toBe(true);
      await expect(invoke("read", deniedFile)).rejects.toThrow();
      expect((await invoke("start", askFile)).output).toBe("started");
      let request: Awaited<ReturnType<typeof client.permission.request.list>>["data"][number] | undefined;
      for (let attempt = 0; attempt < 200 && !request; attempt++) {
        request = (await client.permission.request.list({ location: { directory } })).data.find(item => item.sessionID === sessionID);
        if (!request) await Bun.sleep(10);
      }
      if (!request) throw new Error("Restored chat policy did not ask for file permission");
      expect(request.action).toBe("read"); expect(request.resources).toEqual(["ask.txt"]);
      await client.permission.reply({ sessionID, requestID: request.id, decision: "reject", message: "Synthetic fixture refusal" });
      let outcome: JsonValue = "pending";
      for (let attempt = 0; attempt < 200 && outcome === "pending"; attempt++) { outcome = (await invoke("result")).output; if (outcome === "pending") await Bun.sleep(10); }
      expect(outcome).toBe("rejected");
    };
    await checkEffects();
    const firstOwner = lifecycle;
    if (!firstOwner) throw new Error("Owned history fixture is missing");
    await firstOwner.close(); lifecycle = undefined;
    await rename(legacyHistoryBackupDirectory(config), join(root, "recovery-archive"));
    await rm(activationMarker); client = await startOwned();
    expect(ownedModes).toEqual(["recovery", "service", "service"]);
    await restoreLegacySessionPermissions(config, workspace, client, await client.session.get({ sessionID }));
    await checkEffects();
    // A later explicit native edit must remain authoritative on subsequent reads.
    await client.session.update({ sessionID, permissions: [] });
    await restoreLegacySessionPermissions(config, workspace, client, await client.session.get({ sessionID }));
    expect((await client.session.get({ sessionID })).permissions).toEqual([]);
    expect((await invoke("read", deniedFile)).output).toContain("DENIED-FIXTURE");
    expect(await client.permission.saved.list()).toEqual([]);
    expect(await hashHistoryFile(source)).toBe(originalHash);
  } finally {
    await lifecycle?.close();
    await engine?.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
