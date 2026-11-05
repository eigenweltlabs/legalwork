import { Plugin } from "@opencode/plugin";
import { ManagedSettingsWorkspaceMissingError, managedSettingsRpc, readManagedEngineSettings } from "../managed-engine-settings.js";
import { registerPrimaryContext } from "./native-review-worker.js";
import { managedConfigurationDiff } from "../managed-config-sources.js";
import { managedAgents, managedModelDifferences, managedProviderAllowed, managedProviderDifferences } from "./managed-config-transforms.js";
import type { NativeConfig } from "../native-opencode-config.js";

/** Shared native definitions plus saved app-owned per-location controls.
 * Arbitrary folder configuration is never a managed capability source. */
export const LegalWorkManagedConfig = Plugin.define({
  id: "legalwork.managed-config",
  async setup(ctx) {
    const settingsPath = ctx.options.settingsPath;
    if (typeof settingsPath !== "string") throw new Error("LegalWork managed settings path is required");
    const read = async () => {
      try { return await readManagedEngineSettings(settingsPath, ctx.location.directory); }
      catch (error) { if (error instanceof ManagedSettingsWorkspaceMissingError) return undefined; throw error; }
    };
    let settings = await read();
    const managed = ctx.options.managedConfiguration === true;
    let difference: NativeConfig = settings ? managedConfigurationDiff(settings.configuration, settings.sharedConfiguration) : {};
    const unsupported = (providerID: string, modelID: string) => {
      const reasoning = difference.providers?.[providerID]?.models?.[modelID]?.capabilities?.reasoning;
      return reasoning !== undefined && Object.keys(reasoning).some(key => key !== "supported");
    };
    const excluded = (providerID: string, modelID: string) => {
      const filter = settings?.modelFilters[providerID];
      const shared = settings?.sharedConfiguration.providers?.[providerID];
      const own = settings?.configuration.providers?.[providerID];
      return Boolean(filter && (filter.allow && !filter.allow.includes(modelID) || filter.deny?.includes(modelID)))
        || managed && Boolean(shared && (!own || shared.models?.[modelID] && !own.models?.[modelID]));
    };
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    if (managed) {
      registrations.push(await ctx.integration.transform(editor => {
        for (const [id, provider] of Object.entries(settings?.configuration.providers ?? {})) {
          if (!editor.get(id)) editor.method.update({ integrationID: id, method: { type: "key", label: "Manually enter API Key" } });
          editor.update(id, value => { if (provider.name) value.name = provider.name; });
          if (provider.env !== undefined) editor.method.update({ integrationID: id, method: { type: "env", names: [...provider.env] } });
        }
      }));
      registrations.push(await ctx.provider.transform(editor => managedProviderDifferences(editor, difference)));
      registrations.push(await ctx.agent.transform(editor => { if (settings) managedAgents(editor, settings.configuration); }));
      registrations.push(await ctx.mcp.transform(editor => {
        for (const [name, server] of Object.entries(settings?.configuration.mcp?.servers ?? {})) editor.set(name, server);
      }));
      registrations.push(await ctx.skill.transform(editor => {
        for (const skill of settings?.skills ?? []) editor.add(skill);
      }));
    }
    registrations.push(await ctx.model.transform(editor => {
      if (managed && settings) {
        managedModelDifferences(editor, difference);
        if (settings.configuration.model) editor.default.set(settings.configuration.model.providerID, settings.configuration.model.model);
      }
      for (const model of editor.list()) {
        if (!excluded(model.providerID, model.id) && !(managed && settings && (!managedProviderAllowed(settings.configuration, model.providerID) || unsupported(model.providerID, model.id)))) continue;
        // Native ConfigProvider runs later. Preserve the source definition with
        // enabled=false so its normal fold cannot recreate a filtered model.
        if (managed) editor.update(model.providerID, model.id, value => { value.enabled = false; });
        else editor.remove(model.providerID, model.id);
      }
    }));
    registrations.push(await ctx.session.hook("model.request", event => {
      if (managed && unsupported(event.model.providerID, event.model.id)) throw new Error("This saved project-specific native reasoning declaration is inactive in LegalWork's shared configuration. Keep its original settings and configure the provider in the shared library before using this model.");
      if (excluded(event.model.providerID, event.model.id) || settings?.providerActivation[event.model.providerID] === "deny" || managed && settings && !managedProviderAllowed(settings.configuration, event.model.providerID)) {
        throw new Error("This model is disabled by the saved LegalWork provider selection.");
      }
    }));
    registrations.push(await registerPrimaryContext(ctx, event => {
      const request = settings?.agentRequests[event.agent];
      if (request) Object.assign(event.options, request);
    }));
    registrations.push(await ctx.rpc.register(managedSettingsRpc, { async refresh() {
      const previousMcp = JSON.stringify(settings?.configuration.mcp);
      settings = await read();
      difference = settings ? managedConfigurationDiff(settings.configuration, settings.sharedConfiguration) : {};
      if (managed) {
        await ctx.integration.reload(); await ctx.provider.reload(); await ctx.agent.reload();
        // A status read also refreshes settings. An unchanged MCP reload waits
        // for in-flight connects, preventing callers from cancelling them.
        if (JSON.stringify(settings?.configuration.mcp) !== previousMcp) await ctx.mcp.reload();
        await ctx.skill.reload();
      }
      await ctx.model.reload();
      return { refreshed: true };
    } }));
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
});
export default LegalWorkManagedConfig;
