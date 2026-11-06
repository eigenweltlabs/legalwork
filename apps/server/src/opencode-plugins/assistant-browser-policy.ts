import type { Plugin } from "@opencode/plugin";
import { AssistantSettingsSchema } from "../native-shared-values.js";
import { z } from "zod";
import { ASSISTANT_BROWSER_AGENT, assistantBrowserModel } from "../assistant-browser.js";
import { isBrowserTool } from "./browser-network-policy.js";

export async function registerAssistantBrowserPolicy(ctx: Plugin.Context, isAssistant: (directory: string) => Promise<boolean>, readSettings: () => Promise<unknown>) {
  const selectedModel = async () => {
    const { settings } = z.object({ settings: AssistantSettingsSchema }).parse(await readSettings());
    return assistantBrowserModel((await ctx.model.list()).data, settings.browserModel);
  };
  await ctx.tool.hook("execute.before", async event => {
    const args = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? Object.fromEntries(Object.entries(event.input)) : {};
    const browser = isBrowserTool(event.tool, args) || /^(legalwork_)?web(fetch|search)$/.test(event.tool);
    if (!browser && !(event.tool === "subagent" && args.agent === ASSISTANT_BROWSER_AGENT)) return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (!await isAssistant(session.location.directory)) return;
    if (!browser) {
      const model = await selectedModel();
      event.input = { ...args, model: `${model.providerID}/${model.id}`, background: true };
      return;
    }
    if (session.agent !== ASSISTANT_BROWSER_AGENT || !session.parentID)
      throw new Error("Delegate browser work with subagent agent=assistant-browser. Browser tools are unavailable in the Assistant coordinator and ordinary research workers.");
    const model = await selectedModel();
    if (session.model?.providerID !== model.providerID || session.model.id !== model.id)
      throw new Error("This browser worker is not using the selected browser model. Return to the coordinator and resume it with subagent agent=assistant-browser.");
    if (/^browser[._]tabs[._](select|activate|focus)$/.test(event.tool) || args.actionId === "browser.select_tab" || /^browser[._]preview$/.test(event.tool))
      throw new Error("Keep the browser in the background. The user opens it through the browser tile.");
    if (/^browser[._]tabs[._]open$/.test(event.tool)) event.input = { ...args, focus: false };
    if (event.tool === "legalwork_browser_open_url") event.input = { ...args, show: false };
    if (event.tool === "legalwork_ui_execute_action" && args.actionId === "browser.open_url")
      event.input = { ...args, args: { ...(args.args && typeof args.args === "object" ? args.args : {}), show: false } };
  });
  // Refuse a manually resumed/misconfigured worker before it spends a turn on the wrong model.
  await ctx.session.hook("context", async event => {
    if (event.agent !== ASSISTANT_BROWSER_AGENT) return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (!await isAssistant(session.location.directory)) return;
    const model = await selectedModel();
    if (!session.parentID || event.model.providerID !== model.providerID || event.model.id !== model.id)
      throw new Error("Start or resume this browser worker from the Assistant using its configured Browser model.");
  });
}
