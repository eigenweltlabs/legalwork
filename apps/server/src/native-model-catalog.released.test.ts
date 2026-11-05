import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeMcpBinary, nativeMcpEngine } from "./native-mcp-engine.test-support.js";
import { nativeModelCatalogInventory, nativeModelCatalogRpc, nativeModelInventorySchema } from "./native-model-catalog-rpc.js";

test.skipIf(!nativeMcpBinary)("released native catalog exposes inactive template IDs without exposing provider settings", async () => {
  const engine = await nativeMcpEngine(async root => {
    const plugin = join(root, "catalog-plugin");
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./opencode-plugins/legalwork-model-catalog.ts", import.meta.url))],
      outdir: plugin, naming: "index.js", target: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"] });
    if (!build.success) throw new AggregateError(build.logs, "Native catalog plugin must build");
    return { plugins: [plugin] };
  });
  try {
    const available = (await engine.client().model.list({ location: engine.location })).data;
    const ids = await nativeModelCatalogInventory(engine.client(), engine.location, "openai");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...ids].sort());
    expect(available.filter(model => model.providerID === "openai")).toHaveLength(0);
    expect(await nativeModelCatalogInventory(engine.client(), engine.location, "unknown-provider")).toEqual([]);
    const wire = await engine.client().rpc(nativeModelCatalogRpc).inventory({ providerID: "openai" }, { location: engine.location });
    expect(Object.keys(nativeModelInventorySchema.parse(wire))).toEqual(["models"]);
    await engine.restart();
    expect(await nativeModelCatalogInventory(engine.client(), engine.location, "openai")).toEqual(ids);
  } finally { await engine.close(); }
}, 45_000);
