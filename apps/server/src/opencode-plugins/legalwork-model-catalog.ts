import { Integration, Plugin } from "@opencode/plugin";
import { ConfigProvider } from "@opencode/schema/config/provider";
import { Schema } from "effect";
import { nativeModelCatalogRequestSchema, nativeModelCatalogRpc } from "../native-model-catalog-rpc.js";

/** Read the released engine's own catalog, including inactive providers.
 * Native OpenCode remains responsible for packages, modes and capabilities. */
export const LegalWorkModelCatalog = Plugin.define({
  id: "legalwork.model-catalog",
  async setup(ctx) {
    const connectionProviders = Schema.decodeUnknownSync(Schema.Record(Schema.String, ConfigProvider.Info))(ctx.options.connectionProviders ?? {});
    const integrations = await ctx.integration.transform(editor => {
      for (const [id, definition] of Object.entries(connectionProviders)) {
        if (!editor.get(id)) editor.method.update({ integrationID: id, method: { type: "key", label: "Manually enter API Key" } });
        editor.update(id, integration => { if (definition.name) integration.name = definition.name; });
      }
    });
    let inventories = new Map<string, string[]>();
    const source = await ctx.provider.transform(editor => {
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
    const rpc = await ctx.rpc.register(nativeModelCatalogRpc, {
      async inventory(input) {
        const { providerID } = nativeModelCatalogRequestSchema.parse(input);
        await ctx.provider.list();
        return { models: inventories.get(providerID) ?? [] };
      },
    });
    return async () => { await rpc.dispose(); await source.dispose(); await integrations.dispose(); };
  },
});
export default LegalWorkModelCatalog;
