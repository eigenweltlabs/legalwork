import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { waitForNativeFixture } from "./native-mcp.test-support.js";

test.skipIf(!nativeMcpBinary)("released Azure compatibility definitions preserve regular models alongside deprecated models", async () => {
  const previousCatalog = process.env.OPENCODE_MODELS_PATH;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    const model = { tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 16384 } };
    const catalog = { azure: { id: "azure", name: "Azure", env: ["AZURE_API_KEY"], npm: "@ai-sdk/azure", models: {
      regular: { ...model, id: "regular", name: "Regular Azure model" },
      older: { ...model, id: "older", name: "Older Azure model", status: "deprecated" },
    } } };
    engine = await nativeMcpEngine(async root => {
      process.env.OPENCODE_MODELS_PATH = join(root, "catalog.json");
      await writeFile(process.env.OPENCODE_MODELS_PATH, JSON.stringify(catalog));
      const compatibility = join(root, "compatibility.json");
      await writeFile(compatibility, "{}");
      const plugin = join(root, "plugin");
      const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-model-catalog.ts", import.meta.url))],
        outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
      if (!build.success) throw new AggregateError(build.logs, "Azure catalog plugin must build");
      return { plugins: [{ package: plugin, options: { azureCatalogPath: compatibility } }] };
    });
    const { location } = engine;
    await engine.client().credential.create({ integrationID: "azure", value: { type: "key", key: "synthetic-azure-key" }, activate: true });
    const baseline = (await engine.client().model.list({ location })).data.filter(model => model.providerID === "azure");
    expect(baseline.map(model => model.id)).toEqual(["regular"]);
    await writeFile(join(engine.root, "compatibility.json"), JSON.stringify(catalog));
    await engine.client().location.reload();
    const combined = await waitForNativeFixture(async () => (await engine!.client().model.list({ location })).data.filter(model => model.providerID === "azure"), models => models.length === 2, "regular and restored Azure models");
    expect(combined.find(model => model.id === "regular")).toEqual(baseline[0]);
    expect(combined.find(model => model.id === "older")?.status).toBe("deprecated");
  } finally {
    await engine?.close();
    if (previousCatalog === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previousCatalog;
  }
}, 60_000);

test.skipIf(!nativeMcpBinary)("released Azure provider gets deprecated metadata through LegalWork's supported definitions and retains native ownership", async () => {
  const previousCatalog = process.env.OPENCODE_MODELS_PATH;
  let engine: Awaited<ReturnType<typeof nativeMcpEngine>> | undefined;
  try {
    engine = await nativeMcpEngine(async root => {
      const catalog = join(root, "catalog.json");
      process.env.OPENCODE_MODELS_PATH = catalog;
      await writeFile(catalog, JSON.stringify({ azure: { id: "azure", name: "Azure", env: ["AZURE_API_KEY"], npm: "@ai-sdk/azure", models: {
        "gpt-4.1-mini": { id: "gpt-4.1-mini", name: "GPT-4.1 mini", status: "deprecated", release_date: "2025-04-14",
          attachment: true, reasoning: false, tool_call: true, temperature: true,
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          limit: { context: 1047576, output: 32768 }, cost: { input: 0.4, output: 1.6, cache_read: 0.1 } },
      } } }));
      const plugin = join(root, "plugin");
      const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-model-catalog.ts", import.meta.url))],
        outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
      if (!build.success) throw new AggregateError(build.logs, "Azure catalog plugin must build");
      return { plugins: [{ package: plugin, options: { azureCatalogPath: catalog } }] };
    });
    const { location } = engine;
    expect((await engine.client().model.list({ location })).data.filter(model => model.providerID === "azure")).toEqual([]);
    // No resource metadata: no Azure requests. The native credential activates
    // its catalog, letting this test exercise the real public provider transform.
    const credential = await engine.client().credential.create({ integrationID: "azure", value: { type: "key", key: "synthetic-azure-key" }, activate: true });
    for (const cycle of ["connected", "restart"]) {
      if (cycle === "restart") await engine.restart();
      const models = await waitForNativeFixture(async () => (await engine!.client().model.list({ location })).data.filter(model => model.providerID === "azure"), models => models.length === 1, "Azure metadata definition");
      expect(models[0]).toMatchObject({ id: "gpt-4.1-mini", package: "@opencode/ai/providers/azure/responses", status: "deprecated",
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1047576, output: 32768 },
        cost: [{ input: 0.4, output: 1.6, cache: { read: 0.1, write: 0 } }] });
    }
    const path = join(engine.root, "catalog.json");
    const updated = JSON.parse(await readFile(path, "utf8"));
    updated.azure.models["gpt-4.1-mini"].name = "Updated Azure metadata";
    updated.azure.models["gpt-4.1-mini"].cost.input = 0.5;
    await writeFile(path, JSON.stringify(updated));
    await engine.client().location.reload();
    const refreshed = await waitForNativeFixture(async () => (await engine!.client().model.list({ location })).data.find(model => model.providerID === "azure"), model => model?.name === "Updated Azure metadata", "refreshed Azure metadata");
    expect(refreshed?.cost[0]?.input).toBe(0.5);
    await engine.client().credential.remove({ credentialID: credential.id });
    await waitForNativeFixture(async () => (await engine!.client().model.list({ location })).data.filter(model => model.providerID === "azure"), models => models.length === 0, "disconnected Azure stays unavailable");

    await writeFile(join(engine.directory, "opencode.json"), JSON.stringify({ providers: { azure: {
      settings: { apiKey: "synthetic-owned-key" }, models: { "gpt-4.1-mini": { name: "Authored", disabled: true } },
    } } }));
    await engine.restart();
    expect((await engine.client().model.list({ location })).data.filter(model => model.providerID === "azure")).toEqual([]);

    await writeFile(join(engine.directory, "opencode.json"), JSON.stringify({ providers: { azure: {
      settings: { apiKey: "synthetic-custom-key", baseURL: "http://127.0.0.1:1/v1" }, models: { "custom-only": { name: "Custom" } },
    } } }));
    await engine.restart();
    expect((await engine.client().model.list({ location })).data.filter(model => model.providerID === "azure").map(model => model.id)).toEqual(["custom-only"]);
  } finally {
    await engine?.close();
    if (previousCatalog === undefined) delete process.env.OPENCODE_MODELS_PATH;
    else process.env.OPENCODE_MODELS_PATH = previousCatalog;
  }
}, 60_000);
