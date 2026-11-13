import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { startManagedEngineLifecycle } from "./managed-engine-lifecycle.js";
import { nativeModelCatalogInventory } from "./native-model-catalog-rpc.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary).each([false, true])("idle native catalog reload refreshes multiple locations without replacing the child (service=%s)", async serviceMode => {
  if (!binary) throw new Error("Released engine binary is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-native-catalog-reload-")));
  const directory = join(root, "project"), database = join(root, "engine.db"), catalogPath = join(root, "catalog.json");
  const secondDirectory = join(root, "second-project");
  await Promise.all([directory, secondDirectory].map(path => mkdir(path)));
  const plugin = join(root, "catalog-plugin");
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-model-catalog.ts", import.meta.url))],
    outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
  if (!build.success) throw new AggregateError(build.logs, "Native catalog plugin must build");
  const catalog = (id: string) => ({ fixture: { id: "fixture", name: "Synthetic catalog", env: [], npm: "@ai-sdk/openai-compatible", models: {
    [id]: { id, name: id, release_date: "2026-10-28", attachment: false, reasoning: false, temperature: false, tool_call: true, limit: { context: 128000, output: 32000 } },
  } } });
  await writeFile(catalogPath, JSON.stringify(catalog("initial")));
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic", hostToken: "synthetic-host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], workspaces: [{ id: "matter", name: "Matter", path: directory, workspaceType: "local", preset: "starter" }], authorizedRoots: [directory], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const children: ManagedOpencodeServer[] = [];
  const service = { configDirectory: join(root, "private-config"), stateDirectory: join(root, "private-state") };
  let lifecycle: Awaited<ReturnType<typeof startManagedEngineLifecycle>> | undefined;
  try {
    lifecycle = await startManagedEngineLifecycle({ config, database,
      service,
      create: async (_mode, beforeSpawn) => {
        expect(children.filter(child => child.running())).toHaveLength(0);
        await beforeSpawn?.();
        const child = await createManagedOpencodeServer({ bin: binary, cwd: directory, timeoutMs: 30000, ...(serviceMode ? { service } : { parentLease: true }), env: {
          HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: database, OPENCODE_MODELS_PATH: catalogPath, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [plugin] }),
        } });
        children.push(child); return child;
      },
    });
    const client = () => OpenCode.make({ baseUrl: lifecycle!.engine.url, headers: { Authorization: `Basic ${Buffer.from(`${lifecycle!.engine.username}:${lifecycle!.engine.password}`).toString("base64")}` } });
    const location = { directory };
    expect(await nativeModelCatalogInventory(client(), location, "fixture")).toEqual(["initial"]);
    expect(await nativeModelCatalogInventory(client(), { directory: secondDirectory }, "fixture")).toEqual(["initial"]);
    const originalAffinity = config.managedImageAffinity?.(config.workspaces[0]!);
    await writeFile(catalogPath, JSON.stringify(catalog("updated")));
    expect(await config.reloadManagedEngineCatalog?.()).toBe(true);
    expect(await nativeModelCatalogInventory(client(), location, "fixture")).toEqual(["updated"]);
    expect(await nativeModelCatalogInventory(client(), { directory: secondDirectory }, "fixture")).toEqual(["updated"]);
    expect(children).toHaveLength(1);
    expect(children[0]?.running()).toBe(true);
    expect(config.workspaces[0]?.baseUrl).toBe(lifecycle.engine.url);
    expect(config.managedImageAffinity?.(config.workspaces[0]!)?.storageNamespace).toBe(originalAffinity?.storageNamespace);
    expect(config.managedImageAffinity?.(config.workspaces[0]!)).toBe(originalAffinity);
  } finally {
    await lifecycle?.close();
    for (const child of children) expect(child.running()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
