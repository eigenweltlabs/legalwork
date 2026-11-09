import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionAction, type PermissionAction } from "./agent-sandbox/permissions.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, readGlobalToolPermissions, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_shell_defaults_test";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-runtime-config-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  const dbPath = join(root, "runtime.sqlite");
  process.env.LEGALWORK_RUNTIME_DB = dbPath;
  try {
    await fn({ root, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
    else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

test("command approval defaults on without overwriting saved choices or command exceptions", async () => {
  await withWorkspace(async ({ config }) => {
    const defaults = await readGlobalToolPermissions(config);
    expect(permissionAction(defaults, "shell", "python script.py")).toBe("ask");
    expect(permissionAction(defaults, "edit", "draft.docx")).toBe("allow");
    const effects: PermissionAction[] = ["allow", "ask", "deny"];
    for (const effect of effects) {
      await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({
        permissions: [{ action: "shell", resource: "*", effect }],
      }));
      expect(permissionAction(await readGlobalToolPermissions(config), "shell", "python script.py")).toBe(effect);
    }
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({
      permissions: [{ action: "shell", resource: "git status", effect: "allow" }],
    }));
    const scoped = await readGlobalToolPermissions(config);
    expect(permissionAction(scoped, "shell", "git status")).toBe("allow");
    expect(permissionAction(scoped, "shell", "python script.py")).toBe("ask");
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    }));
    expect(permissionAction(await readGlobalToolPermissions(config), "shell", "git status")).toBe("deny");
  });
});

