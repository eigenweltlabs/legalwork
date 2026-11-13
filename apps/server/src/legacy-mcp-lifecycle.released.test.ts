import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { nativeMcpBinary } from "./native-mcp-engine.test-support.js";
import type { ServerConfig } from "./types.js";

test.skipIf(!nativeMcpBinary)("startup imports connector logins before enabling native recovery, without importing twice", async () => {
  if (!nativeMcpBinary) throw new Error("Native engine required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-mcp-upgrade-lifecycle-")));
  const directory = join(root, "project"), database = join(root, "engine.db"), source = join(root, "mcp-auth.json");
  await mkdir(directory);
  await writeFile(source, JSON.stringify({ fixture: { serverUrl: "https://example.invalid/mcp", tokens: { accessToken: "synthetic", refreshToken: "synthetic-refresh" }, clientInfo: { clientId: "client" } } }));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "private", "server.json"), token: "synthetic", hostToken: "synthetic-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [{ id: "project", name: "Project", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const modes: string[] = [], service = { configDirectory: join(root, "config"), stateDirectory: join(root, "state") };
  let lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  try {
    lifecycle = await startManagedEngineLifecycle({ config, database, service, legacyMcpAuthPath: source, create: async (mode, beforeSpawn) => {
      modes.push(mode); await beforeSpawn?.();
      return createManagedOpencodeServer({ bin: nativeMcpBinary, cwd: directory, timeoutMs: 30_000, parentLease: true, env: {
        HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: database, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false }),
      } });
    } });
    await lifecycle.refresh();
    expect(modes).toEqual(["recovery", "service"]);
    expect(config.managedEngineRecoveryState?.().mode).toBe("service");
    const engine = lifecycle.engine;
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const credentials = await client.credential.list();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.value).toMatchObject({ type: "oauth", access: "synthetic", refresh: "synthetic-refresh" });
  } finally { await lifecycle?.close(); await rm(root, { recursive: true, force: true }); }
}, 45_000);
