import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionAction, type NativePermissionRule } from "./agent-sandbox/permissions.js";
import { GLOBAL_MCP_ID, GLOBAL_TOOL_PERMISSIONS_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-settings-")));
  const first = join(root, "first"), second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const previousDb = process.env.LEGALWORK_RUNTIME_DB, previousHome = process.env.XDG_CONFIG_HOME;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "private", "runtime.sqlite");
  process.env.XDG_CONFIG_HOME = join(root, "private", "config");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "native-settings-client", hostToken: "native-settings-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], engineConfigurationMode: "native-project",
    workspaces: [{ id: "first", name: "First", path: first, workspaceType: "local", preset: "starter" }, { id: "second", name: "Second", path: second, workspaceType: "local", preset: "starter" }],
    authorizedRoots: [first, second], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  return {
    config,
    read: (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${config.token}` } }),
    request: (path: string, value: unknown, method = "PATCH") => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(value),
    }),
    close: async () => {
      await server.stop();
      if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
      if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("native project rules and partial agent edits remain project scoped and preserve restrictions", async () => {
  const run = await fixture();
  try {
    await writeRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "shell", resource: "*", effect: "ask" }] }));
    await writeRuntimeOpencodeConfig(run.config, "second", () => ({ permissions: [{ action: "read", resource: "/second/*", effect: "deny" }] }));
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ agents: { reviewer: { system: "Before", permissions: [{ action: "*", resource: "*", effect: "deny" }] } } }));
    const rules: NativePermissionRule[] = [{ action: "shell", resource: "pwd", effect: "allow" }, { action: "external_directory", resource: "/first-only/*", effect: "allow" }];
    expect((await run.request("/workspace/first/config", { opencode: { permissions: rules, agents: { reviewer: { system: "After" } } } })).status).toBe(200);
    const first = await readRuntimeOpencodeConfig(run.config, "first");
    expect(first.permissions).toMatchObject(rules);
    expect(first.agents?.reviewer).toEqual({ system: "After", permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    expect((await readRuntimeOpencodeConfig(run.config, "second")).permissions).toEqual([{ action: "read", resource: "/second/*", effect: "deny" }]);
    expect((await readRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID)).permissions).toEqual([{ action: "shell", resource: "*", effect: "ask" }]);
    expect((await run.request("/workspace/first/config", { opencode: { permission: { bash: "allow" } } })).status).toBe(400);
    expect(await readRuntimeOpencodeConfig(run.config, "first")).toEqual(first);
  } finally { await run.close(); }
});

test("global native per-action edits retain unrelated rules and refuse project folder globalization", async () => {
  const run = await fixture();
  try {
    const custom: NativePermissionRule = { action: "legalwork_custom", resource: "sensitive/*", effect: "deny" };
    await writeRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [custom, { action: "shell", resource: "*", effect: "ask" }] }));
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ permissions: [{ action: "external_directory", resource: "/first-only/*", effect: "allow" }] }));
    const project = await readRuntimeOpencodeConfig(run.config, "first");
    expect((await run.request("/workspace/first/config", { legalwork: { toolPermissionRules: { shell: [{ action: "shell", resource: "*", effect: "deny" }] } } })).status).toBe(200);
    const global = await readRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID);
    expect(global.permissions).toEqual([custom, { action: "shell", resource: "*", effect: "deny" }]);
    expect(await readRuntimeOpencodeConfig(run.config, "first")).toEqual(project);
    expect((await run.request("/workspace/first/config", { legalwork: { toolPermissionRules: { external_directory: [{ action: "external_directory", resource: "*", effect: "allow" }] } } })).status).toBe(400);
    expect(await readRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID)).toEqual(global);
    expect((await run.request("/workspace/first/config", { legalwork: { toolPermissionRules: { shell: null } } })).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID)).permissions).toEqual([custom]);
  } finally { await run.close(); }
});

test("folder edits retain ordered child denials and unrelated tools without granting sibling projects", async () => {
  const run = await fixture();
  try {
    const original: NativePermissionRule[] = [{ action: "external_directory", resource: "*", effect: "ask" }, { action: "external_directory", resource: "/shared/private/*", effect: "deny" }, { action: "legalwork_custom", resource: "*", effect: "ask" }];
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ permissions: original }));
    expect((await run.request("/workspace/first/authorized-folders", { folders: ["/shared"] }, "PUT")).status).toBe(200);
    const saved = (await readRuntimeOpencodeConfig(run.config, "first")).permissions ?? [];
    expect(saved).toEqual([original[0], { action: "external_directory", resource: "/shared/*", effect: "allow" }, original[1], original[2]]);
    expect(permissionAction(saved, "external_directory", "/shared/ordinary/file")).toBe("allow");
    expect(permissionAction(saved, "external_directory", "/shared/private/file")).toBe("deny");
    expect((await readRuntimeOpencodeConfig(run.config, "second")).permissions).toBeUndefined();
    expect((await readRuntimeOpencodeConfig(run.config, GLOBAL_TOOL_PERMISSIONS_ID)).permissions).toBeUndefined();
  } finally { await run.close(); }
});

test.each(["ask", "deny"])("authorized folder listing respects a later native %s instead of reviving an earlier allow", async effect => {
  const run = await fixture();
  try {
    const permissions: NativePermissionRule[] = [{ action: "external_directory", resource: "/restricted/*", effect: "allow" }, { action: "external_directory", resource: "/restricted/*", effect }];
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ permissions }));
    const listed = await run.read("/workspace/first/authorized-folders");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ folders: [], hiddenCount: 2 });
    expect((await readRuntimeOpencodeConfig(run.config, "first")).permissions).toEqual(permissions);
  } finally { await run.close(); }
});

test("authorized folder listing respects the selected agent's denial over a private remembered grant", async () => {
  const run = await fixture();
  try {
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ default_agent: "restricted", permissions: [{ action: "external_directory", resource: "/restricted/*", effect: "allow" }], agents: { restricted: { permissions: [{ action: "external_directory", resource: "*", effect: "deny" }] } }, projectPermissionApprovals: [{ id: "psv_folder", action: "external_directory", resources: ["/restricted/*"], createdAt: 1 }] }));
    const listed = await run.read("/workspace/first/authorized-folders");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ folders: [] });
  } finally { await run.close(); }
});

test("an explicit legacy file import cannot move an existing native denial before an older grant", async () => {
  const run = await fixture();
  try {
    const workspace = run.config.workspaces[0];
    await mkdir(join(workspace.path, ".opencode"), { recursive: true });
    await writeFile(join(workspace.path, ".opencode", "legalwork.json"), JSON.stringify({ permission: { external_directory: { "*": "deny", "/shared/*": "allow" } } }));
    await writeRuntimeOpencodeConfig(run.config, workspace.id, () => ({ permissions: [{ action: "external_directory", resource: "*", effect: "deny" }] }));
    expect((await run.request("/workspace/first/runtime-config/migrate", {}, "POST")).status).toBe(200);
    const saved = (await readRuntimeOpencodeConfig(run.config, workspace.id)).permissions ?? [];
    expect(saved).toEqual([{ action: "external_directory", resource: "/shared/*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "deny" }]);
    expect(permissionAction(saved, "external_directory", "/shared/file")).toBe("deny");
  } finally { await run.close(); }
});

test("connector form commands save native definitions and metadata edits retain credentials", async () => {
  const run = await fixture();
  try {
    expect((await run.request("/workspace/first/mcp", { name: "fixture", config: { type: "remote", url: "https://fixture.invalid/mcp", enabled: true,
      oauth: { clientId: "fixture-client", clientSecret: "synthetic-credential" }, headers: { "X-Fixture": "synthetic-header" }, timeout: 75000 } }, "POST")).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(run.config, GLOBAL_MCP_ID)).mcp?.servers?.fixture).toMatchObject({ type: "remote", disabled: false,
      oauth: { client_id: "fixture-client", client_secret: "synthetic-credential" }, headers: { "X-Fixture": "synthetic-header" }, timeout: { startup: 75000, catalog: 75000, execution: 75000 } });
    expect((await run.request("/workspace/first/mcp", { name: "fixture", preserveScope: true, config: { type: "remote", enabled: false, oauth: { scope: "read" } } }, "POST")).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(run.config, GLOBAL_MCP_ID)).mcp?.servers?.fixture).toMatchObject({ type: "remote", disabled: true,
      oauth: { client_id: "fixture-client", client_secret: "synthetic-credential", scope: "read" }, headers: { "X-Fixture": "synthetic-header" } });
  } finally { await run.close(); }
});

test("authorized folders show and revoke private remembered grants without turning them into config rules", async () => {
  const run = await fixture();
  try {
    const permissions: NativePermissionRule[] = [{ action: "external_directory", resource: "*", effect: "ask" }, { action: "external_directory", resource: "/shared/private/*", effect: "deny" }];
    const approvals = [{ id: "psv_folder", action: "external_directory", resources: ["/shared/*"], createdAt: 1 }, { id: "psv_web", action: "webfetch", resources: ["https://fixture.invalid/*"], createdAt: 2 }];
    await writeRuntimeOpencodeConfig(run.config, "first", () => ({ permissions, projectPermissionApprovals: approvals }));
    const listed = await run.read("/workspace/first/authorized-folders");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ folders: ["/shared"] });
    // Retaining a visible folder keeps the private approval's ownership.
    const retained = await run.request("/workspace/first/authorized-folders", { folders: ["/shared"] }, "PUT");
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ folders: ["/shared"] });
    expect((await readRuntimeOpencodeConfig(run.config, "first")).permissions).toEqual(permissions);
    expect((await readRuntimeOpencodeConfig(run.config, "first")).projectPermissionApprovals).toEqual(approvals);
    expect((await run.request("/workspace/first/authorized-folders", { folders: [] }, "PUT")).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(run.config, "first")).projectPermissionApprovals).toEqual([approvals[1]]);
    expect((await readRuntimeOpencodeConfig(run.config, "first")).permissions).toEqual(permissions);
    expect((await readRuntimeOpencodeConfig(run.config, "second")).projectPermissionApprovals).toBeUndefined();
  } finally { await run.close(); }
});
