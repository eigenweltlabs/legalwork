import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import * as Permission from "@opencode/schema/permission";
import { Schema } from "effect";
import { permissionAction } from "./agent-sandbox/permissions.js";
import { ensureLegacyHistoryBackup } from "./history-v1-backup.js";
import { importLegacySessionPermissionRules, restoreLegacySessionPermissions, assertLegacySessionPermissionsRecoveryReady, restoreRegisteredLegacySessionPermissions, assertRegisteredLegacySessionPermissionsReady } from "./session-history-permissions.js";
import { createEngineClient } from "./engine-client.js";
import type { ServerConfig } from "./types.js";

async function fixture(input: { sourceRules?: unknown; nativeRules?: unknown; parentID?: string; sourceWorktree?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-session-policy-")));
  const directory = join(root, "matter"), other = join(root, "other");
  await Promise.all([mkdir(directory), mkdir(other)]);
  const previous = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  const source = join(root, "original.db"), db = new Database(source);
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,time_created INTEGER,parent_id TEXT,permission TEXT,project_id TEXT); CREATE TABLE project(id TEXT PRIMARY KEY,worktree TEXT)");
  const rules = input.sourceRules ?? [{ permission: "read", pattern: "*", action: "deny" }, { permission: "read", pattern: "approved/*", action: "allow" }, { permission: "bash", pattern: "git *", action: "ask" }];
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?)").run("ses_fixture", directory, 100, input.parentID ?? null, JSON.stringify(rules), "project_fixture");
  db.prepare("INSERT INTO project VALUES(?,?)").run("project_fixture", input.sourceWorktree ?? directory);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?)").run("ses_unregistered", other, 101, null, JSON.stringify(rules), "project_fixture");
  db.close();
  let nativeRules = input.nativeRules === undefined ? undefined : Schema.decodeUnknownSync(Permission.Ruleset)(input.nativeRules);
  const calls: string[] = [];
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === "/api/session/ses_fixture" && request.method === "PATCH") {
      const body = await request.json();
      nativeRules = Schema.decodeUnknownSync(Permission.Ruleset)(body.permissions);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session/ses_fixture" && request.method === "GET") return Response.json({ data: { id: "ses_fixture", projectID: "project_fixture", ...(input.parentID ? { parentID: input.parentID } : {}), agent: "restricted-agent", location: { directory }, time: { created: 100, updated: 100 }, ...(nativeRules === undefined ? {} : { permissions: nativeRules }) } });
    if (path === "/api/session/ses_fixture/synthetic") return Response.json({ data: { id: "msg_fixture" } });
    return new Response("Unexpected fixture API", { status: 500 });
  } });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private", "server.json"), token: "synthetic", hostToken: "synthetic-host", opencodeBaseUrl: engine.url.origin,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [directory],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await ensureLegacyHistoryBackup(config, source, async destination => { const original = new Database(source, { readonly: true }); try { original.run("VACUUM INTO ?", [destination]); } finally { original.close(); } });
  const client = OpenCode.make({ baseUrl: engine.url.origin });
  return { config, workspace: config.workspaces[0], client, calls, other,
    close: async () => { engine.stop(true); if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); } };
}

test("explicit legacy session permission import retains ordered wildcards, resources, actions and effects", () => {
  expect(importLegacySessionPermissionRules([{ permission: "*", pattern: "*", action: "deny" }, { permission: "bash", pattern: "git *", action: "ask" }, { permission: "task", pattern: "reviewer", action: "allow" }, { permission: "apply_patch", pattern: "approved/*", action: "allow" }]))
    .toEqual([{ action: "*", resource: "*", effect: "deny" }, { action: "shell", resource: "git *", effect: "ask" }, { action: "subagent", resource: "reviewer", effect: "allow" }, { action: "apply_patch", resource: "approved/*", effect: "allow" }]);
  expect(() => importLegacySessionPermissionRules([{ permission: "*", pattern: "*", action: "unknown" }])).toThrow();
});

test.each(["write", "patch", "apply_patch"])("a legacy %s allow cannot override an effective edit denial during history import", name => {
  const rules = importLegacySessionPermissionRules([{ permission: "edit", pattern: "*", action: "deny" }, { permission: name, pattern: "*", action: "allow" }]);
  expect(rules).toEqual([{ action: "edit", resource: "*", effect: "deny" }, { action: name, resource: "*", effect: "allow" }]);
  expect(permissionAction(rules, "edit", "agreement.docx")).toBe("deny");
});

test("session policies restore once, keep child/agent context and do not replay over a later explicit native edit", async () => {
  const run = await fixture({ parentID: "ses_parent" });
  try {
    await expect(assertLegacySessionPermissionsRecoveryReady(run.config, ["ses_fixture"])).rejects.toMatchObject({ code: "history_permissions_resolution_required", details: { reason: "original_permissions_not_restored" } });
    const session = await run.client.session.get({ sessionID: "ses_fixture" });
    const [first, second] = await Promise.all([restoreLegacySessionPermissions(run.config, run.workspace, run.client, session), restoreLegacySessionPermissions(run.config, run.workspace, run.client, session)]);
    expect(first.permissions).toEqual(second.permissions);
    expect(first.agent).toBe("restricted-agent"); expect(first.parentID).toBe("ses_parent");
    expect(run.calls.filter(value => value.startsWith("PATCH"))).toHaveLength(1);
    await expect(assertLegacySessionPermissionsRecoveryReady(run.config, ["ses_fixture"])).resolves.toBeUndefined();
    await run.client.session.update({ sessionID: session.id, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    const changed = await run.client.session.get({ sessionID: session.id });
    expect((await restoreLegacySessionPermissions(run.config, run.workspace, run.client, changed)).permissions).toEqual(changed.permissions);
    expect(run.calls.filter(value => value.startsWith("PATCH"))).toHaveLength(2);
  } finally { await run.close(); }
});

test("ambiguous native changes and another project cannot receive original session policies", async () => {
  const run = await fixture({ nativeRules: [{ action: "shell", resource: "*", effect: "deny" }] });
  try {
    const session = await run.client.session.get({ sessionID: "ses_fixture" });
    await expect(restoreLegacySessionPermissions(run.config, run.workspace, run.client, session)).rejects.toMatchObject({ details: { reason: "native_permissions_conflict" } });
    await expect(restoreLegacySessionPermissions(run.config, { ...run.workspace, path: run.other }, run.client, session)).rejects.toMatchObject({ details: { reason: "native_context_mismatch" } });
    expect(run.calls.some(value => value.startsWith("PATCH"))).toBe(false);
  } finally { await run.close(); }
});

test("the actual SDK execution wrapper restores native policy before admitting an old chat", async () => {
  const run = await fixture();
  try {
    const client = createEngineClient(run.config, run.workspace);
    await client.session.synthetic({ sessionID: "ses_fixture", text: "Synthetic fixture only", resume: false });
    const patch = run.calls.indexOf("PATCH /api/session/ses_fixture"), execution = run.calls.indexOf("POST /api/session/ses_fixture/synthetic");
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(execution).toBeGreaterThan(patch);
    await expect(assertLegacySessionPermissionsRecoveryReady(run.config, ["ses_fixture"])).resolves.toBeUndefined();
  } finally { await run.close(); }
});

test("plain-serve preparation restores only registered chats before service readiness", async () => {
  const run = await fixture();
  try {
    await expect(assertRegisteredLegacySessionPermissionsReady(run.config)).rejects.toMatchObject({ details: { reason: "original_permissions_not_restored" } });
    await restoreRegisteredLegacySessionPermissions(run.config, run.client);
    await expect(assertRegisteredLegacySessionPermissionsReady(run.config, run.client)).resolves.toBeUndefined();
    expect(run.calls.filter(value => value.startsWith("PATCH"))).toHaveLength(1);
    expect(run.calls.every(value => value.endsWith("/api/session/ses_fixture"))).toBe(true);
  } finally { await run.close(); }
});

test("scoped file resources with a different original worktree are held instead of reinterpreted", async () => {
  const run = await fixture({ sourceWorktree: "/" });
  try {
    await expect(restoreLegacySessionPermissions(run.config, run.workspace, run.client, await run.client.session.get({ sessionID: "ses_fixture" })))
      .rejects.toMatchObject({ details: { reason: "original_permission_resource_context_mismatch" } });
    expect(run.calls.some(value => value.startsWith("PATCH"))).toBe(false);
  } finally { await run.close(); }
});

test.each(["glob", "grep", "g*"])("%s search-pattern rules retain their exact scope when the original worktree differs", async name => {
  const run = await fixture({ sourceWorktree: "/", sourceRules: [{ permission: name, pattern: "confidential*", action: "deny" }, { permission: name, pattern: "approved*", action: "allow" }] });
  try {
    const restored = await restoreLegacySessionPermissions(run.config, run.workspace, run.client, await run.client.session.get({ sessionID: "ses_fixture" }));
    expect(restored.permissions).toEqual([{ action: name, resource: "confidential*", effect: "deny" }, { action: name, resource: "approved*", effect: "allow" }]);
    await expect(assertLegacySessionPermissionsRecoveryReady(run.config, ["ses_fixture"])).resolves.toBeUndefined();
  } finally { await run.close(); }
});

test.each(["read", "edit", "list", "*"])("%s path-sensitive rules still require verified original worktree context", async name => {
  const run = await fixture({ sourceWorktree: "/", sourceRules: [{ permission: name, pattern: "approved/*", action: "allow" }] });
  try {
    await expect(restoreLegacySessionPermissions(run.config, run.workspace, run.client, await run.client.session.get({ sessionID: "ses_fixture" })))
      .rejects.toMatchObject({ details: { reason: "original_permission_resource_context_mismatch" } });
    expect(run.calls.some(value => value.startsWith("PATCH"))).toBe(false);
  } finally { await run.close(); }
});
