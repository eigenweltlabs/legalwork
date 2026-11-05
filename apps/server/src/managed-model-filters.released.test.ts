import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { managedSettingsRpc } from "./managed-engine-settings.js";
import { startServer } from "./server.js";
import { approveEngineProject } from "./engine-project.js";
import type { ServerConfig } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("released model filters remove catalog models and deny an explicit model recreated by native configuration", async () => {
  const root = await realpath(await mkdtemp(join(import.meta.dir, "../../../.legalwork/scratch/native-model-filters-")));
  const workspace = join(root, "matter"), plugin = join(root, "plugin"), settingsPath = join(root, "runtime-opencode-settings.json");
  let providerRequests = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { providerRequests++; return new Response("Must not reach the provider", { status: 500 }); } });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await Promise.all([workspace, plugin, ...["home", "config", "data", "cache", "state"].map(name => join(root, name))].map(path => mkdir(path, { recursive: true })));
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "opencode-plugins/legalwork-managed-config.ts")], outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
    if (!build.success) throw new AggregateError(build.logs, "Model filter fixture must build");
    const settings = { version: 1, workspaces: { matter: { directory: workspace, configuration: {}, providerActivation: {}, modelFilters: {}, agentRequests: {}, skills: [] } } };
    await writeFile(settingsPath, JSON.stringify(settings));
    engine = await createManagedOpencodeServer({ bin: binary, cwd: workspace, timeoutMs: 30_000, env: {
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", plugins: [{ package: plugin, options: { settingsPath } }], providers: { openai: { settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic", transport: "http" }, models: { "explicit-denied": { modelID: "explicit-denied", limit: { context: 128000, output: 4096 } } } } } }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: workspace };
    const catalog = (await client.model.list({ location })).data.filter(model => model.providerID === "openai" && model.id !== "explicit-denied");
    expect(catalog.length).toBeGreaterThan(1);
    const allowed = catalog[0]!.id, excluded = catalog[1]!.id;
    await writeFile(settingsPath, JSON.stringify({ ...settings, workspaces: { matter: { ...settings.workspaces.matter, modelFilters: { openai: { allow: [allowed] } } } } }));
    await client.rpc(managedSettingsRpc).refresh({}, { location });
    const filtered = (await client.model.list({ location })).data.filter(model => model.providerID === "openai");
    expect(filtered.some(model => model.id === allowed)).toBe(true);
    expect(filtered.some(model => model.id === excluded)).toBe(false);
    expect(filtered.some(model => model.id === "explicit-denied")).toBe(true);
    const project = { id: "matter", name: "Matter", path: workspace, workspaceType: "local", preset: "starter" };
    const config: ServerConfig = { host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "model-filter-test", hostToken: "model-filter-host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false,
      workspaces: [{ ...project, workspaceType: "local" }], authorizedRoots: [workspace], startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
      engineProjectTrustRequired: true, opencodeBaseUrl: engine.url, opencodeUsername: engine.username, opencodePassword: engine.password };
    await approveEngineProject(config, config.workspaces[0]!, workspace, []);
    server = await startServer(config);
    const publicClient = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}/workspace/matter/opencode`, headers: { authorization: "Bearer model-filter-test" } });
    const visible = (await publicClient.model.list({ location })).data.filter(model => model.providerID === "openai");
    expect(visible.map(model => model.id)).toEqual([allowed]);
    // Upstream intentionally applies explicit models after external transforms.
    // This request guard must remain effective even if that recreates a model.
    const session = await client.session.create({ location, model: { providerID: "openai", id: "explicit-denied" } });
    await client.session.prompt({ sessionID: session.id, text: "Forbidden provider request" });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
    expect(providerRequests).toBe(0);
    expect(JSON.stringify((await client.message.list({ sessionID: session.id })).data)).toContain("disabled by the saved LegalWork provider selection");
  } finally { await server?.stop(); await engine?.close(); provider.stop(true); await rm(root, { recursive: true, force: true }); }
}, 45_000);
