import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginNativeConfigComponent, bootstrapRuntimeOpencodeConfig, closeRuntimeOpencodeConfig, completeNativeConfigComponent,
  GLOBAL_MCP_ID, readRuntimeConfigUpgradeBackups, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { NATIVE_CONFIG_SCOPE_TABLE, NATIVE_CONFIG_TABLE, nativeConfigStatePath } from "./native-config-state.js";
import type { ServerConfig } from "./types.js";

async function fixture(run: (config: ServerConfig, path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-config-state-")), path = join(root, "runtime.sqlite");
  const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = path;
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false,
    startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try { await run(config, path, root); }
  finally { await closeRuntimeOpencodeConfig(config); if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
}
function sql(path: string, action: (db: Database) => void) {
  const db = new Database(path); try { action(db); } finally { db.close(); }
}
function seed(path: string, rows: Record<string, string>) {
  sql(path, db => {
    db.exec("CREATE TABLE runtime_opencode_configs(workspace_id TEXT PRIMARY KEY,config_json TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE tasks_fixture(id TEXT PRIMARY KEY,body TEXT); INSERT INTO tasks_fixture VALUES('keep','Complete unrelated app state')");
    for (const [id, source] of Object.entries(rows)) db.run("INSERT INTO runtime_opencode_configs VALUES(?,?,?)", [id, source, 123]);
  });
}
async function child(command: string[], config: ServerConfig, path: string) {
  const process = Bun.spawn(command, { env: { ...globalThis.process.env, LEGALWORK_RUNTIME_DB: path, LW_NATIVE_STATE_CONFIG: JSON.stringify(config) }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect(code, stdout + stderr).toBe(0);
  return stdout;
}

test("durable native markers sync through a writable file handle", () => fixture(async (config, path, root) => {
  const harness = join(root, "writable-marker.ts");
  const modulePath = fileURLToPath(new URL("./native-config-state.ts", import.meta.url));
  await writeFile(harness, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
import{openNativeConfigState}from ${JSON.stringify(modulePath)};
// Windows FlushFileBuffers requires GENERIC_WRITE. Write the unchanged first
// JSON byte to enforce that contract on every host, without changing content.
const sync=fs.fsyncSync;let markers=0;
fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isFile()){fs.writeSync(fd,Buffer.from('{'),0,1,0);markers++;}sync(fd);};
syncBuiltinESMExports();
const path=process.env.LEGALWORK_RUNTIME_DB;
let state=await openNativeConfigState(path);
state.upsert({workspaceId:'project',configJson:'{"permissions":[{"action":"edit","resource":"*","effect":"deny"}]}',updatedAt:1});
state.beginComponent('fixture.sync');state.completeComponent('fixture.sync');state.close();
state=await openNativeConfigState(path);
console.log(JSON.stringify({markers,saved:JSON.parse(state.get('project').configJson),marker:JSON.parse(fs.readFileSync(path+'.native-config-state.json','utf8'))}));state.close();`);
  const build = await Bun.build({ entrypoints: [harness], outdir: root, naming: "writable-marker.mjs", target: "node", format: "esm", external: ["bun:sqlite"] });
  if (!build.success) throw new AggregateError(build.logs, "Marker durability fixture must build");
  const node = fileURLToPath(new URL(`../../desktop/resources/node/${process.platform === "win32" ? "node.exe" : "node"}`, import.meta.url));
  const result = JSON.parse(await child([node, join(root, "writable-marker.mjs")], config, path));
  expect(result).toMatchObject({ markers: 3, saved: { permissions: [{ action: "edit", resource: "*", effect: "deny" }] }, marker: { components: { "fixture.sync": "complete" } } });
}));

test("ordinary reads cannot import retired state; explicit bootstrap preserves exact originals and unrelated tables", () => fixture(async (config, path) => {
  const source = '{\n"permission":{"external_directory":{"/case/*":"allow"}},"agent":{"review":{"permission":"deny"}}\n}';
  seed(path, { project: source });
  await expect(readRuntimeOpencodeConfig(config, "project")).rejects.toMatchObject({ status: 409, details: { reason: "legacy_configuration_import_required" } });
  // A rejected ordinary open must not poison the later explicit bootstrap.
  await bootstrapRuntimeOpencodeConfig(config);
  expect((await readRuntimeOpencodeConfig(config, "project")).agents?.review.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  expect((await readRuntimeConfigUpgradeBackups(config, "project"))[0]?.configJson).toBe(source);
  sql(path, db => {
    expect(db.query("SELECT body FROM tasks_fixture").get()).toEqual({ body: "Complete unrelated app state" });
    expect(db.query("SELECT config_json FROM runtime_opencode_configs").get()).toEqual({ config_json: source });
  });
}));

test("bootstrap preserves existing exact backup metadata when the current source has the same hash", () => fixture(async (config, path) => {
  const source = '{"configurationVersion":2,"permissions":[{"action":"*","resource":"*","effect":"deny"}]}';
  const notes = '[{"code":"legacy_workspace_tool_permissions_inactive","fields":["shell"]}]';
  seed(path, { project: source });
  sql(path, db => {
    db.exec("CREATE TABLE runtime_opencode_config_upgrade_backups(workspace_id TEXT,source_hash TEXT,source_version INTEGER,config_json TEXT,notices_json TEXT,created_at INTEGER)");
    db.run("INSERT INTO runtime_opencode_config_upgrade_backups VALUES(?,?,?,?,?,?)", ["project", "previous-source-hash", 1, source, notes, 7]);
  });
  await bootstrapRuntimeOpencodeConfig(config);
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual([{ sourceVersion: 1, configJson: source, noticesJson: notes, createdAt: 7 }]);
}));

test("fresh reads do not invent saved scopes, and an explicit empty save becomes expected state", () => fixture(async (config, path) => {
  expect(await readRuntimeOpencodeConfig(config, "new-project")).toEqual({ configurationVersion: 2 });
  sql(path, db => expect(db.query(`SELECT * FROM ${NATIVE_CONFIG_SCOPE_TABLE}`).all()).toEqual([]));
  await writeRuntimeOpencodeConfig(config, "new-project", current => current);
  sql(path, db => { expect(db.query(`SELECT status FROM ${NATIVE_CONFIG_SCOPE_TABLE}`).get()).toEqual({ status: "ready" }); db.run(`DELETE FROM ${NATIVE_CONFIG_TABLE} WHERE workspace_id=?`, ["new-project"]); });
  await expect(readRuntimeOpencodeConfig(config, "new-project")).rejects.toMatchObject({ status: 409 });
  await expect(writeRuntimeOpencodeConfig(config, "new-project", () => ({}))).rejects.toMatchObject({ status: 409 });
  expect(await readRuntimeOpencodeConfig(config, "genuinely-new-project")).toEqual({ configurationVersion: 2 });
}));

test.each([NATIVE_CONFIG_TABLE, NATIVE_CONFIG_SCOPE_TABLE, "native_config_state", "native_config_backups"])("a deleted current %s table is held without recreation", table => fixture(async (config, path) => {
  await writeRuntimeOpencodeConfig(config, "project", () => ({ permissions: [{ action: "*", resource: "*", effect: "deny" }] }));
  await closeRuntimeOpencodeConfig(config);
  sql(path, db => db.exec(`DROP TABLE ${table}`));
  await expect(bootstrapRuntimeOpencodeConfig(config)).rejects.toMatchObject({ status: 409 });
  await expect(readRuntimeOpencodeConfig(config, "project")).rejects.toMatchObject({ status: 409 });
  sql(path, db => expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeNull());
}));

test("missing current database cannot reset saved permission and sandbox settings, even if another store recreates unrelated tables", () => fixture(async (config, path) => {
  await writeRuntimeOpencodeConfig(config, "__sandbox_default__", () => ({ sandbox: { enabled: true, networkMode: "block" } }));
  await closeRuntimeOpencodeConfig(config);
  await rm(path);
  await expect(readRuntimeOpencodeConfig(config, "__sandbox_default__")).rejects.toMatchObject({ status: 409, details: { reason: "native_configuration_database_missing" } });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  sql(path, db => db.exec("CREATE TABLE unrelated_task_state(value TEXT)"));
  await expect(bootstrapRuntimeOpencodeConfig(config)).rejects.toMatchObject({ status: 409 });
  sql(path, db => expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "unrelated_task_state" }]));
}));

test("normal reads reject unversioned current rows instead of translating or repairing them", () => fixture(async (config, path) => {
  await writeRuntimeOpencodeConfig(config, "project", () => ({ permissions: [{ action: "edit", resource: "*", effect: "deny" }] }));
  const source = '{"permission":{"edit":"allow"}}';
  sql(path, db => db.run(`UPDATE ${NATIVE_CONFIG_TABLE} SET config_json=? WHERE workspace_id=?`, [source, "project"]));
  await expect(readRuntimeOpencodeConfig(config, "project")).rejects.toMatchObject({ status: 409 });
  await expect(writeRuntimeOpencodeConfig(config, "project", () => ({}))).rejects.toMatchObject({ status: 409 });
  sql(path, db => expect(db.query(`SELECT config_json FROM ${NATIVE_CONFIG_TABLE}`).get()).toEqual({ config_json: source }));
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual([]);
}));

test("component startup evidence is monotonic and survives a cold restart without its component files", () => fixture(async (config, path, root) => {
  expect(await beginNativeConfigComponent(config, "connector-storage")).toBe("new");
  expect(await beginNativeConfigComponent(config, "connector-storage")).toBe("pending");
  await completeNativeConfigComponent(config, "connector-storage");
  await closeRuntimeOpencodeConfig(config);
  expect(await beginNativeConfigComponent(config, "connector-storage")).toBe("complete");
  await expect(completeNativeConfigComponent(config, "unregistered-store")).rejects.toMatchObject({ status: 409 });
  const marker = JSON.parse(await readFile(nativeConfigStatePath(path), "utf8"));
  expect(marker.components).toEqual({ "connector-storage": "complete" });
  expect(await readFile(join(root, "connector-storage-state.json")).catch(() => undefined)).toBeUndefined();
}));

test("losing an established profile marker cannot erase completed component expectations", () => fixture(async (config, path) => {
  await beginNativeConfigComponent(config, "connector-storage");
  await completeNativeConfigComponent(config, "connector-storage");
  await closeRuntimeOpencodeConfig(config);
  await rm(nativeConfigStatePath(path));
  await expect(bootstrapRuntimeOpencodeConfig(config)).rejects.toMatchObject({ status: 409, details: { reason: "native_configuration_marker_missing" } });
  await expect(readFile(nativeConfigStatePath(path))).rejects.toMatchObject({ code: "ENOENT" });
}));

test("an interrupted first marker publication can finish from its committed unpublished state", () => fixture(async (config, path) => {
  await writeRuntimeOpencodeConfig(config, "project", () => ({ permissions: [{ action: "read", resource: "*", effect: "deny" }] }));
  await closeRuntimeOpencodeConfig(config);
  sql(path, db => db.run("UPDATE native_config_state SET completed=0 WHERE id=1"));
  await rm(nativeConfigStatePath(path));
  await bootstrapRuntimeOpencodeConfig(config);
  expect((await readRuntimeOpencodeConfig(config, "project")).permissions).toEqual([{ action: "read", resource: "*", effect: "deny" }]);
  expect(JSON.parse(await readFile(nativeConfigStatePath(path), "utf8")).completed).toBe(true);
}));

test("cold Bun and bundled Node22 read and edit current settings offline after only retired tables are removed", () => fixture(async (config, path, root) => {
  seed(path, {
    project: JSON.stringify({ providers: { fixture: { models: { custom: { limit: { context: 800000 }, variants: [{ id: "careful", body: { temperature: 0.4 } }] } } } }, agents: { restricted: { permissions: [{ action: "*", resource: "*", effect: "deny" }] } }, permissions: [{ action: "external_directory", resource: "/case/*", effect: "ask" }] }),
    [GLOBAL_MCP_ID]: JSON.stringify({ mcp: { fixture: { type: "remote", url: "https://fixture.invalid/mcp", enabled: false, oauth: { clientId: "synthetic-client", scope: "read" } } } }),
    __sandbox_default__: JSON.stringify({ sandbox: { enabled: true, networkMode: "block" } }),
  });
  await bootstrapRuntimeOpencodeConfig(config);
  const originals = await readRuntimeConfigUpgradeBackups(config, "project");
  await closeRuntimeOpencodeConfig(config);
  sql(path, db => db.exec("DROP TABLE runtime_opencode_configs"));
  const harness = join(root, "cold-store.ts"), bundle = join(root, "cold-store.node.mjs");
  await writeFile(harness, `import {readRuntimeOpencodeConfig,writeRuntimeOpencodeConfig,closeRuntimeOpencodeConfig,beginNativeConfigComponent,completeNativeConfigComponent} from ${JSON.stringify(fileURLToPath(new URL("./runtime-opencode-config-store.ts", import.meta.url)))};
const config=JSON.parse(process.env.LW_NATIVE_STATE_CONFIG);globalThis.fetch=()=>{throw new Error('Offline test must not use the network')};
if(process.argv[2]){await beginNativeConfigComponent(config,process.argv[2]);await new Promise(done=>setTimeout(done,10));await completeNativeConfigComponent(config,process.argv[2]);await closeRuntimeOpencodeConfig(config);console.log('component complete');process.exit(0)}
const before=await readRuntimeOpencodeConfig(config,'project');if(before.agents.restricted.permissions[0].effect!=='deny')throw new Error('Lost agent restriction');
await writeRuntimeOpencodeConfig(config,'project',current=>({...current,providers:{...current.providers,fixture:{...current.providers.fixture,name:process.versions.bun?'Bun edited':'Node edited'}}}));
const connector=await readRuntimeOpencodeConfig(config,'__global_mcp__');if(connector.mcp.servers.fixture.oauth.client_id!=='synthetic-client')throw new Error('Lost OAuth configuration');
await writeRuntimeOpencodeConfig(config,'__global_mcp__',current=>({...current,mcp:{...current.mcp,servers:{...current.mcp.servers,fixture:{...current.mcp.servers.fixture,disabled:true}}}}));
const sandbox=await readRuntimeOpencodeConfig(config,'__sandbox_default__');if(sandbox.sandbox.networkMode!=='block')throw new Error('Lost sandbox restriction');
await writeRuntimeOpencodeConfig(config,'__sandbox_default__',current=>({...current,sandbox:{enabled:true,networkMode:'block'},sandboxEdit:process.versions.bun?'bun':'node'}));
await closeRuntimeOpencodeConfig(config);console.log(JSON.stringify({native:true,node:process.versions.node,offline:true}));`);
  const build = await Bun.build({ entrypoints: [harness], outdir: root, naming: "cold-store.node.mjs", target: "node", format: "esm", external: ["bun:sqlite"] });
  if (!build.success) throw new AggregateError(build.logs, "Native store Node fixture must build");
  expect(await child([process.execPath, harness], config, path)).toContain('"native":true');
  // Match the executable installed by prepare-node-runtime.mjs on this host.
  const node = fileURLToPath(new URL(`../../desktop/resources/node/${process.platform === "win32" ? "node.exe" : "node"}`, import.meta.url));
  expect(await child([node, bundle], config, path)).toContain('"node":"22.');
  await Promise.all([child([node, bundle, "fixture.node-one"], config, path), child([process.execPath, harness, "fixture.bun-one"], config, path), child([node, bundle, "fixture.node-two"], config, path), child([process.execPath, harness, "fixture.bun-two"], config, path)]);
  expect(JSON.parse(await readFile(nativeConfigStatePath(path), "utf8")).components).toEqual({ "fixture.node-one": "complete", "fixture.bun-one": "complete", "fixture.node-two": "complete", "fixture.bun-two": "complete" });
  const saved = await readRuntimeOpencodeConfig(config, "project");
  expect(saved.providers?.fixture.name).toBe("Node edited");
  expect(saved.providers?.fixture.models?.custom.limit?.context).toBe(800000);
  expect(saved.agents?.restricted.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  expect(await readRuntimeConfigUpgradeBackups(config, "project")).toEqual(originals);
  sql(path, db => {
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runtime_opencode%'").all()).toEqual([]);
    expect(db.query("SELECT body FROM tasks_fixture").get()).toEqual({ body: "Complete unrelated app state" });
  });
}), 30000);
