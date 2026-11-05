import { Plugin } from "@opencode/plugin";
import { nativeEngineLocationApproved, nativeEngineLocationApprovedSync } from "../native-engine-project-registry.js";
import { resolve } from "node:path";
import { homedir } from "node:os";

const diagnostic = "This project has not been approved for OpenCode automation. Open its LegalWork project review and approve its configuration before running the agent.";

/** This guard also covers internally created native Locations and recovered
 * Jobs, which never cross the LegalWork HTTP proxy. It must be restored by
 * the app-owned final plugin directives, after authored project directives. */
export const LegalWorkProjectAdmission = Plugin.define({
  id: "legalwork.project-admission",
  async setup(ctx) {
    const registryPath = ctx.options.registryPath;
    if (typeof registryPath !== "string") throw new Error("LegalWork project admission registry is required.");
    const allowed = () => nativeEngineLocationApproved(registryPath, ctx.location.directory).catch(() => false);
    const assert = async () => { if (!await allowed()) throw new Error(diagnostic); };
    await ctx.mcp.transform(editor => {
      if (!nativeEngineLocationApprovedSync(registryPath, ctx.location.directory)) for (const [name] of editor.list()) editor.remove(name);
    });
    await ctx.permission.hook("evaluate", async event => {
      if (await allowed()) return;
      event.effect = "deny"; event.message = diagnostic;
    });
    await ctx.tool.hook("execute.before", async event => {
      await assert();
      if (!/(?:^|[._])session_move$/.test(event.tool)) return;
      if (!event.input || typeof event.input !== "object" || !("directory" in event.input) || typeof event.input.directory !== "string") throw new Error("A destination directory is required before moving this chat.");
      const directory = event.input.directory;
      const target = directory.startsWith("~/") ? resolve(homedir(), directory.slice(2)) : resolve(ctx.location.directory, directory);
      if (!await nativeEngineLocationApproved(registryPath, target).catch(() => false)) throw new Error("Open and approve the destination project in LegalWork before moving this chat there. " + diagnostic);
    });
    await ctx.shell.hook("create.before", () => {
      if (ctx.options.protectedHostExecution === true) throw new Error("Use legalwork_shell for command execution.");
      return assert();
    });
    await ctx.session.hook("prompt", assert);
    await ctx.session.hook("model.request", assert);
  },
});
export default LegalWorkProjectAdmission;
