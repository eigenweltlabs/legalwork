import { Integration, Plugin } from "@opencode/plugin";
import { ConfigProvider } from "@opencode/schema/config/provider";
import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { azureModelDefinitions } from "../azure-model-definitions.js";
import { nativeModelCatalogRequestSchema, nativeModelCatalogRpc } from "../native-model-catalog-rpc.js";
import { nativeEvents } from "./native-events.js";

/** Read the released engine's own catalog, including inactive providers.
 * Native OpenCode remains responsible for packages, modes and capabilities. */
export const LegalWorkModelCatalog = Plugin.define({
  id: "legalwork.model-catalog",
  async setup(ctx) {
    const connectionProviders = Schema.decodeUnknownSync(Schema.Record(Schema.String, ConfigProvider.Info))(ctx.options.connectionProviders ?? {});
    const catalogPath = ctx.options.azureCatalogPath;
    const readAzure = async () => {
      if (typeof catalogPath !== "string") return [];
      try { return azureModelDefinitions(JSON.parse(await readFile(catalogPath, "utf8"))); }
      catch { return []; } // A missing public cache must not break provider startup.
    };
    let azureModels = await readAzure();
    const integrations = await ctx.integration.transform(editor => {
      for (const [id, definition] of Object.entries(connectionProviders)) {
        if (!editor.get(id)) editor.method.update({ integrationID: id, method: { type: "key", label: "Manually enter API Key" } });
        editor.update(id, integration => { if (definition.name) integration.name = definition.name; });
      }
    });
    let inventories = new Map<string, string[]>();
    let restoredAzureModels = new Set<string>();
    const source = await ctx.provider.transform(editor => {
      restoredAzureModels = new Set();
      const azure = editor.get("azure");
      // Keep native credential activation, account binding and deployment discovery.
      // Custom endpoints/packages and authored model definitions remain authoritative.
      if (azure?.provider.package === "@opencode/ai/providers/azure/responses" && azure.provider.settings?.baseURL === undefined) {
        for (const model of azureModels) if (!azure.models.has(model.id)) {
          editor.models.update("azure", model.id, value => Object.assign(value, structuredClone(model)));
          restoredAzureModels.add(model.id);
        }
      }
      for (const [id, definition] of Object.entries(connectionProviders)) {
        editor.update(id, provider => {
          provider.activation = "auto";
          provider.integrationID ??= Integration.ID.make(id);
          if (definition.name) provider.name = definition.name;
          if (definition.package) provider.package = definition.package;
          if (definition.settings) provider.settings = { ...provider.settings, ...definition.settings };
        });
        for (const [modelID, model] of Object.entries(definition.models ?? {})) {
          editor.models.update(id, modelID, value => {
            if (model.name) value.name = model.name;
            if (model.capabilities?.tools !== undefined) value.capabilities.tools = model.capabilities.tools;
          });
        }
      }
      inventories = new Map(editor.list().map(record => [record.provider.id, [...record.models.keys()].sort()]));
    });
    const stopEvents = nativeEvents(ctx, async event => {
      if (event.type !== "models-dev.refreshed") return;
      azureModels = await readAzure();
      await ctx.provider.reload();
    });
    // Authored provider overlays are applied after public provider transforms.
    // Remove compatibility defaults from custom endpoints/packages here; native
    // explicit model configuration runs later and keeps every authored model.
    const models = await ctx.model.transform(editor => {
      const azure = editor.provider.get("azure")?.provider;
      if (azure?.package === "@opencode/ai/providers/azure/responses" && azure.settings?.baseURL === undefined) return;
      for (const id of restoredAzureModels) editor.remove("azure", id);
    });
    const rpc = await ctx.rpc.register(nativeModelCatalogRpc, {
      async inventory(input) {
        const { providerID } = nativeModelCatalogRequestSchema.parse(input);
        await ctx.provider.list();
        return { models: inventories.get(providerID) ?? [] };
      },
    });
    return async () => { stopEvents(); await rpc.dispose(); await models.dispose(); await source.dispose(); await integrations.dispose(); };
  },
});
export default LegalWorkModelCatalog;
