import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { upgradeRuntimeConfigRecord } from "./runtime-config-upgrade.js";
import { managedSettingsRpc } from "./managed-engine-settings.js";

test.skipIf(!nativeMcpBinary)("v1 custom provider selections survive native catalog, generation, restart and editing, including built-in IDs", async () => {
  const calls: string[] = [];
  const provider = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json(); calls.push(body.model);
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "selection preserved" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  let settingsPath = "";
  const imported = upgradeRuntimeConfigRecord({ provider: Object.fromEntries(["fixture", "openai"].map(id => [id, {
    npm: "@ai-sdk/openai-compatible", options: { apiKey: "synthetic", baseURL: `${provider.url.origin}/v1` },
    whitelist: ["allowed"], models: { allowed: {}, blocked: {} },
  }])) });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  const selections: Record<string, string[]> = { fixture: ["allowed"], openai: ["allowed"] };
  const writeSettings = async (directory: string) => writeFile(settingsPath, JSON.stringify({ version: 2, sharedConfiguration: {}, workspaces: {
    project: { directory, configuration: imported.configuration, providerActivation: {}, providerModelSelection: selections, projectPermissionApprovals: [] },
  } }));
  try {
    engine = await nativeMcpEngine(async root => {
      settingsPath = join(root, "settings.json"); await writeSettings(join(root, "project"));
      await writeFile(join(root, "project", "opencode.json"), JSON.stringify(imported.configuration));
      const plugin = join(root, "plugin");
      const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-managed-config.ts", import.meta.url))], outdir: plugin,
        naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
      if (!built.success) throw new AggregateError(built.logs, "Selection plugin build failed");
      return { plugins: [{ package: plugin, options: { settingsPath } }] };
    });
    expect(imported.application.providerModelSelection).toEqual(selections);
    for (const cycle of ["initial", "restart"]) {
      if (cycle === "restart") await engine.restart();
      const client = engine.client(), location = engine.location;
      expect(await client.rpc(managedSettingsRpc).permissionScope({}, { location })).toMatchObject({ directory: engine.directory });
      const generate = async (providerID: string, id: string) => {
        const session = await client.session.create({ location, model: { providerID, id } });
        return client.session.generate({ sessionID: session.id, prompt: "Fixture" }, { signal: AbortSignal.timeout(10_000) });
      };
      for (const providerID of ["fixture", "openai"]) {
        expect((await client.model.list({ location })).data.filter(model => model.providerID === providerID).map(model => model.id)).toEqual(["allowed"]);
        expect((await generate(providerID, "allowed")).text).toBe("selection preserved");
        await expect(generate(providerID, "blocked")).rejects.toThrow();
        await expect(generate(providerID, "gpt-4o")).rejects.toThrow();
      }
    }
    expect(calls).toEqual(["allowed", "allowed", "allowed", "allowed"]);
    selections.fixture = []; await writeSettings(engine.directory);
    await writeFile(join(engine.directory, "opencode.json"), JSON.stringify({ ...imported.configuration, providers: {
      ...imported.configuration.providers, fixture: { ...imported.configuration.providers?.fixture, models: {} },
    } }));
    await engine.restart();
    expect((await engine.client().model.list({ location: engine.location })).data.filter(model => model.providerID === "fixture").map(model => model.id)).toEqual([]);
  } finally { await engine?.close(); provider.stop(true); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("retired Azure and Vertex providers start and generate with migrated selections after restart", async () => {
  const calls: Array<{ model: string; authorization: string | null }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json(); calls.push({ model: body.model, authorization: request.headers.get("authorization") });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "provider migrated" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    const imported = upgradeRuntimeConfigRecord({ provider: Object.fromEntries(["azure-cognitive-services", "google-vertex-anthropic"].map(id => [id, {
      npm: "@ai-sdk/openai-compatible", options: { apiKey: "synthetic-provider-key", baseURL: `${provider.url.origin}/v1` },
      models: { fixture: { tool_call: true } },
    }])) });
    engine = await nativeMcpEngine(imported.configuration);
    for (const cycle of ["initial", "restart"]) {
      if (cycle === "restart") await engine.restart();
      const client = engine.client();
      const catalog = (await client.model.list({ location: engine.location })).data;
      for (const providerID of ["azure", "google-vertex"]) {
        expect(catalog.some(model => model.providerID === providerID && model.id === "fixture")).toBe(true);
        const session = await client.session.create({ location: engine.location, model: { providerID, id: "fixture" } });
        const response = await client.session.generate({ sessionID: session.id, prompt: "Fixture" }, { signal: AbortSignal.timeout(10_000) });
        expect(response.text).toBe("provider migrated");
      }
    }
    expect(calls).toEqual(Array.from({ length: 4 }, () => ({ model: "fixture", authorization: "Bearer synthetic-provider-key" })));
  } finally { await engine?.close(); provider.stop(true); }
}, 60_000);

test.skipIf(!nativeMcpBinary)("migrated Vertex Claude models keep their SDK without replacing Gemini's native SDK", async () => {
  const imported = upgradeRuntimeConfigRecord({ provider: { "google-vertex-anthropic": {
    npm: "@ai-sdk/google-vertex/anthropic", options: { project: "synthetic-project", location: "global" }, models: { fixture: {} },
  } } });
  const engine = await nativeMcpEngine(imported.configuration);
  try {
    const catalog = (await engine.client().model.list({ location: engine.location })).data;
    expect(catalog.find(model => model.providerID === "google-vertex" && model.id === "fixture")?.package).toBe("@opencode/ai/providers/google-vertex/messages");
    const gemini = catalog.filter(model => model.providerID === "google-vertex" && model.id.startsWith("gemini-"));
    expect(gemini.length).toBeGreaterThan(0);
    expect(gemini.every(model => model.package !== "@opencode/ai/providers/google-vertex/messages")).toBe(true);
  } finally { await engine.close(); }
}, 30_000);
