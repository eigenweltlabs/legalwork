import { isAbsolute, relative, resolve } from "node:path";
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
    const files = await ctx.tool.hook("execute.before", async event => {
      if (!["read", "write", "edit", "multiedit", "patch", "apply_patch", "glob", "grep", "list"].includes(event.tool)) return;
      const settings = await read();
      if (!settings?.contentPath || !event.input || typeof event.input !== "object" || Array.isArray(event.input)) return;
      const contentPath = settings.contentPath;
      const mapPath = (path: string) => {
        const suffix = isAbsolute(path) && settings.previousPath ? relative(settings.previousPath, path) : path;
        if (/^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix)) return resolve(settings.directory, suffix);
        return isAbsolute(path) ? path : resolve(contentPath, path);
      };
      for (const key of ["filePath", "path"]) {
        const path = Reflect.get(event.input, key);
        if (typeof path === "string") Reflect.set(event.input, key, mapPath(path));
      }
      if (["glob", "grep", "list"].includes(event.tool) && !Reflect.get(event.input, "path")) Reflect.set(event.input, "path", settings.contentPath);
      for (const key of ["patchText", "patch"]) {
        const patch = Reflect.get(event.input, key);
        if (typeof patch === "string") Reflect.set(event.input, key, patch.replace(/^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+)$/gm, (_line, prefix: string, path: string) => `${prefix}${mapPath(path)}`));
      }
      const edits = Reflect.get(event.input, "edits");
      if (Array.isArray(edits)) for (const edit of edits) if (edit && typeof edit === "object" && typeof edit.filePath === "string") edit.filePath = mapPath(edit.filePath);
    });
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
        // Removing an override leaves an explicitly configured model available.
        // Disable it so both catalog and authored definitions stay restricted.
        for (const model of editor.list(id)) if (!allowed.includes(model.id)) editor.update(id, model.id, value => { value.enabled = false; });
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
    return async () => { await refresh.dispose(); await models.dispose(); await providers.dispose(); await permissions.dispose(); await files.dispose(); };
  },
});
export default LegalWorkManagedConfig;
