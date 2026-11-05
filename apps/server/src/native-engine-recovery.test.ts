import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveEngineProject } from "./engine-project.js";
import { assertNativeEngineRecoveryProjectsReady, inspectNativeEngineRecovery } from "./native-engine-recovery.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

test("native recovery preflight inspects all claims, background jobs and queued moves without mutating the database", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-preflight-"))), directory = join(root, "project"), destination = join(root, "destination");
  await Promise.all([directory, destination].map(path => mkdir(path)));
  const workspace: WorkspaceInfo = { id: "project", path: directory, name: "Project", preset: "starter", workspaceType: "local" };
  const other: WorkspaceInfo = { ...workspace, id: "destination", path: destination };
  const config: ServerConfig = { configPath: join(root, "private", "server.json"), host: "127.0.0.1", port: 0,
    token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [workspace, other], authorizedRoots: [directory, destination], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false, engineProjectTrustRequired: true };
  const path = join(root, "engine.db"), db = new Database(path);
  db.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_suspended INTEGER); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE session_inbox(session_id TEXT,type TEXT,payload TEXT)");
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("parent", directory, null, 1);
  db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?)").run("child", directory, "parent", 1);
  db.prepare("INSERT INTO kv VALUES(?,?)").run("job.background/notification", JSON.stringify({ recovery: { kind: "subagent", parentSessionID: "parent", childSessionID: "child" } }));
  db.prepare("INSERT INTO session_inbox VALUES(?,?,?)").run("parent", "move", JSON.stringify({ location: { directory: destination } }));
  db.close();
  const original = await readFile(path);
  try {
    expect(await inspectNativeEngineRecovery(path)).toEqual({ sessions: [{ id: "parent", directory }, { id: "child", directory }], directories: [directory, destination] });
    await expect(assertNativeEngineRecoveryProjectsReady(config, path)).rejects.toMatchObject({ code: "project_automation_approval_required" });
    await approveEngineProject(config, workspace, directory, []);
    await expect(assertNativeEngineRecoveryProjectsReady(config, path)).rejects.toMatchObject({ code: "project_automation_approval_required" });
    await approveEngineProject(config, other, destination, []);
    expect((await assertNativeEngineRecoveryProjectsReady(config, path)).sessions.map(item => item.id)).toEqual(["parent", "child"]);
    config.workspaces = [workspace];
    await expect(assertNativeEngineRecoveryProjectsReady(config, path)).rejects.toMatchObject({ code: "engine_recovery_approval_required" });
    expect(await readFile(path)).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
