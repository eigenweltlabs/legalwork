import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNativeSavedApprovalMigration, migrateStoppedNativeSavedApprovals, prepareNativeSavedApprovalMigration } from "./native-saved-approval-migration.js";
import { closeRuntimeOpencodeConfig, readRuntimeOpencodeConfig, runtimeEngineConfiguration, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

async function fixture(legacy = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-saved-")));
  for (const name of ["known", "shared/a", "shared/b"]) await mkdir(join(root, name), { recursive: true });
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0,
    token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: ["known", "shared/a", "shared/b"].map(name => ({ id: name, path: join(root, name), name, preset: "starter", workspaceType: "local" })),
    authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const path = join(root, "engine.db"), db = new Database(path);
  db.exec("CREATE TABLE project(id TEXT PRIMARY KEY,worktree TEXT); CREATE TABLE worktree(project_id TEXT,directory TEXT)");
  db.exec(legacy ? "CREATE TABLE permission(project_id TEXT PRIMARY KEY,data TEXT,time_created INTEGER,time_updated INTEGER)"
    : "CREATE TABLE permission(id TEXT PRIMARY KEY,project_id TEXT,action TEXT,resource TEXT,time_created INTEGER,time_updated INTEGER)");
  for (const [id, worktree] of [["git-known", join(root, "known")], ["git-shared", join(root, "shared")], ["global", "/"]]) db.query("INSERT INTO project VALUES(?,?)").run(id, worktree);
  return { root, path, db, config };
}

test("nonempty native saved grants import only a unique exact project; shared, global and unknown records need explicit reconfirmation", async () => {
  const { root, path, db, config } = await fixture(); const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    for (const project of ["git-known", "git-shared", "global", "missing-project"]) db.query("INSERT INTO permission VALUES(?,?,?,?,?,?)").run(`psv_${project}`, project, "shell", "exact private command", 17, 19);
    const prepared = await prepareNativeSavedApprovalMigration(config, path);
    expect(prepared.sourceRows).toBe(4); expect(prepared.imports).toHaveLength(1);
    expect(prepared.imports[0]).toMatchObject({ workspaceID: "known", action: "shell", resource: "exact private command", createdAt: 17, updatedAt: 19 });
    expect(prepared.unresolved.map(item => item.reason).sort()).toEqual(["global_project", "shared_project", "unknown_project"]);
    expect((await readFile(prepared.backup, "utf8"))).toContain("exact private command");
    if (process.platform !== "win32") expect((await stat(prepared.backup)).mode & 0o777).toBe(0o600);
    await expect(activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "hold" })).rejects.toThrow("choose reconfirmation");
    expect(db.query("SELECT COUNT(*) AS n FROM permission").get()).toEqual({ n: 4 });
    expect((await readRuntimeOpencodeConfig(config, "known")).projectPermissionApprovals ?? []).toEqual([]);
    expect(await activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" })).toEqual({ imported: 1, reconfirm: 3 });
    expect(db.query("SELECT COUNT(*) AS n FROM permission").get()).toEqual({ n: 0 });
    expect((await readRuntimeOpencodeConfig(config, "known")).projectPermissionApprovals).toMatchObject([{ action: "shell", resources: ["exact private command"], createdAt: 17, updatedAt: 19 }]);
    for (const id of ["shared/a", "shared/b"]) expect((await readRuntimeOpencodeConfig(config, id)).projectPermissionApprovals ?? []).toEqual([]);
    await closeRuntimeOpencodeConfig(config);
    expect((await readRuntimeOpencodeConfig(config, "known")).projectPermissionApprovals).toHaveLength(1);
    expect(JSON.parse(await readFile(prepared.backup, "utf8")).original.rows).toHaveLength(4);
  } finally { db.close(); await closeRuntimeOpencodeConfig(config); if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
});

test("nonempty original v1 saved table is archived before one-time native action import", async () => {
  const { root, path, db, config } = await fixture(true); const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    const original = JSON.stringify([{ permission: "bash", pattern: "git status", action: "allow" }, { permission: "task", pattern: "helper", action: "allow" }]);
    db.query("INSERT INTO permission VALUES(?,?,?,?)").run("git-known", original, 23, 29);
    const prepared = await prepareNativeSavedApprovalMigration(config, path);
    expect(prepared.imports.map(item => [item.action, item.resource])).toEqual([["shell", "git status"], ["subagent", "helper"]]);
    expect(await activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "hold" })).toEqual({ imported: 2, reconfirm: 0 });
    expect(JSON.parse(await readFile(prepared.backup, "utf8")).original.rows[0].data).toBe(original);
    expect((await readRuntimeOpencodeConfig(config, "known")).projectPermissionApprovals).toHaveLength(2);
  } finally { db.close(); await closeRuntimeOpencodeConfig(config); if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
});

test("malformed or non-Allow legacy saved policy is preserved and holds startup instead of granting access", async () => {
  const { root, path, db, config } = await fixture(true);
  try {
    db.query("INSERT INTO permission VALUES(?,?,?,?)").run("git-known", JSON.stringify([{ permission: "read", pattern: "secret", action: "deny" }]), 1, 2);
    const prepared = await prepareNativeSavedApprovalMigration(config, path);
    expect(prepared.imports).toEqual([]); expect(prepared.unresolved).toEqual([{ sourceRow: 0, reason: "non_allow_saved_policy" }]);
    await expect(activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" })).rejects.toThrow("explicit resolution");
    expect(db.query("SELECT COUNT(*) AS n FROM permission").get()).toEqual({ n: 1 });
    db.query("UPDATE permission SET data='invalid'").run();
    expect((await prepareNativeSavedApprovalMigration(config, path)).unresolved).toEqual([{ sourceRow: 0, reason: "invalid_saved_policy" }]);
  } finally { db.close(); await closeRuntimeOpencodeConfig(config); await rm(root, { recursive: true, force: true }); }
});

test("changing registered project ownership after review cannot apply a stale grant mapping", async () => {
  const { root, path, db, config } = await fixture();
  try {
    db.query("INSERT INTO permission VALUES(?,?,?,?,?,?)").run("psv_known", "git-known", "shell", "git status", 1, 2);
    const prepared = await prepareNativeSavedApprovalMigration(config, path);
    config.workspaces.push({ ...config.workspaces[0], id: "duplicate-matter" });
    await expect(activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" })).rejects.toThrow("ownership changed");
    expect(db.query("SELECT COUNT(*) AS n FROM permission").get()).toEqual({ n: 1 });
  } finally { db.close(); await closeRuntimeOpencodeConfig(config); await rm(root, { recursive: true, force: true }); }
});


test.each([false, true])("revocation after an interrupted import survives retry/restart (native deletion completed: %s)", async deleted => {
  const { root, path, db, config } = await fixture(); const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  try {
    db.query("INSERT INTO permission VALUES(?,?,?,?,?,?)").run("psv_known", "git-known", "fixture.review", "record", 1, 2);
    const prepared = await prepareNativeSavedApprovalMigration(config, path);
    db.exec("CREATE TRIGGER interrupt_saved_delete BEFORE DELETE ON permission BEGIN SELECT RAISE(ABORT,'simulated interruption'); END");
    await expect(activateNativeSavedApprovalMigration(config, prepared, { ambiguous: "reconfirm" })).rejects.toThrow("simulated interruption");
    const imported = await readRuntimeOpencodeConfig(config, "known");
    expect(imported.projectPermissionApprovals).toHaveLength(1);
    expect(imported.nativeSavedApprovalImportIDs).toEqual(prepared.imports.map(item => item.id));
    // A settings replacement revokes the grant but cannot erase app-owned
    // import history, even before the engine rows/receipt were committed.
    await writeRuntimeOpencodeConfig(config, "known", () => ({}));
    expect((await readRuntimeOpencodeConfig(config, "known")).nativeSavedApprovalImportIDs).toEqual(imported.nativeSavedApprovalImportIDs);
    db.exec("DROP TRIGGER interrupt_saved_delete");
    if (deleted) db.exec("DELETE FROM permission");
    await closeRuntimeOpencodeConfig(config);
    expect((await migrateStoppedNativeSavedApprovals(config, path)).changed).toBe(true);
    const restored = await readRuntimeOpencodeConfig(config, "known");
    expect(restored.projectPermissionApprovals ?? []).toEqual([]);
    expect(runtimeEngineConfiguration(restored)).not.toHaveProperty("nativeSavedApprovalImportIDs");
    expect(db.query("SELECT COUNT(*) AS n FROM permission").get()).toEqual({ n: 0 });
    expect(await migrateStoppedNativeSavedApprovals(config, path)).toEqual({ changed: false, imported: 0, reconfirm: 0 });
    expect(JSON.parse(await readFile(prepared.backup, "utf8")).original.rows).toHaveLength(1);
  } finally { db.close(); await closeRuntimeOpencodeConfig(config); if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
});
