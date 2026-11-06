import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { nativeChatApprovalResources, rememberNativeChatApproval } from "./native-folder-approval.js";
import { closeRuntimeOpencodeConfig, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;

test("remembering uses exactly the native persistent scope and never guesses from requested resources", () => {
  expect(nativeChatApprovalResources({ action: "shell", save: ["git status", "git status", "git diff *"] })).toEqual(["git status", "git diff *"]);
  expect(() => nativeChatApprovalResources({ action: "shell" })).toThrow("Use Allow once");
  expect(() => nativeChatApprovalResources({ action: "shell", save: [""] })).toThrow("Use Allow once");
});

test.skipIf(!binary)("a standalone native engine without the project permission hook cannot remember a broader grant", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-no-project-approval-")));
  const previous = { ...process.env }, directory = join(root, "project");
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", configPath: join(root, "private", "server.json"),
    workspaces: [workspace], authorizedRoots: [directory], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    await mkdir(directory); process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    engine = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
      OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_DB: join(root, "engine.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    } });
    config.opencodeBaseUrl = engine.url; config.opencodeUsername = engine.username; config.opencodePassword = engine.password;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const session = await client.session.create({ location: { directory } });
    await expect(rememberNativeChatApproval(config, workspace, session.id, "per_absent")).rejects.toMatchObject({
      status: 409, code: "project_permission_integration_unavailable",
    });
    expect((await readRuntimeOpencodeConfig(config, workspace.id)).projectPermissionApprovals ?? []).toEqual([]);
    expect(await client.permission.saved.list()).toEqual([]);
  } finally {
    await engine?.close(); await closeRuntimeOpencodeConfig(config);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); await rm(root, { recursive: true, force: true });
  }
}, 45_000);
