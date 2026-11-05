import { Plugin } from "@opencode/plugin";
import { ManagedSettingsWorkspaceMissingError, managedSettingsRpc, readManagedEngineSettings } from "../managed-engine-settings.js";
import { registerManagedFolderPermissions } from "./managed-folder-permissions.js";

/** Native files supply configuration. This hook enforces LegalWork's narrower
 * project permission boundary when the engine groups several folders together. */
export const LegalWorkManagedConfig = Plugin.define({
  id: "legalwork.managed-config",
  async setup(ctx) {
    const settingsPath = ctx.options.settingsPath;
    if (typeof settingsPath !== "string") throw new Error("LegalWork project settings path is required");
    const read = async () => {
      try { return await readManagedEngineSettings(settingsPath, ctx.location.directory); }
      catch (error) { if (error instanceof ManagedSettingsWorkspaceMissingError) return undefined; throw error; }
    };
    const permissions = await registerManagedFolderPermissions(ctx, read);
    let selections = (await read())?.providerModelSelection ?? {};
    // Preserve this project's selected inventory, including when a custom
    // provider reuses a built-in ID. Prune both source definitions and the
    // effective catalog so inherited models cannot reappear in project chats.
    const providers = await ctx.provider.transform(editor => {
      for (const [id, allowed] of Object.entries(selections)) {
        for (const model of editor.get(id)?.models.keys() ?? []) if (!allowed.includes(model)) editor.models.remove(id, model);
      }
    });
    const models = await ctx.model.transform(editor => {
      for (const [id, allowed] of Object.entries(selections)) {
        for (const model of editor.list(id)) if (!allowed.includes(model.id)) editor.remove(id, model.id);
      }
    });
    const refresh = await ctx.rpc.register(managedSettingsRpc, { async permissionScope() {
      const settings = await read();
      if (!settings) throw new Error("This engine location has no LegalWork project permission scope.");
      return { version: 2, directory: settings.directory, remembered: "legalwork-project" };
    }, async refresh() {
      // Native file watching owns configuration invalidation. Reloading the
      // whole location here would cancel a permission request being answered.
      const next = (await read())?.providerModelSelection ?? {};
      if (JSON.stringify(next) !== JSON.stringify(selections)) {
        selections = next;
        await ctx.provider.reload();
        await ctx.model.reload();
      }
      return { refreshed: true };
    } });
    return async () => { await refresh.dispose(); await models.dispose(); await providers.dispose(); await permissions.dispose(); };
  },
});
export default LegalWorkManagedConfig;
