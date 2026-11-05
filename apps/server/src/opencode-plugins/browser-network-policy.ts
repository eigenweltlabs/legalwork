import { z } from "zod";
import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

export function isBrowserTool(tool: string, args: Record<string, unknown>) {
  return tool === "browser" || tool.startsWith("browser.") || /(^|_)browser_/.test(tool) || tool === "legalwork_ui_execute_action" &&
    typeof args.actionId === "string" && args.actionId.startsWith("browser.");
}

/** Resolve the caller, never the project currently visible in the app. */
export async function requireBrowserNetwork(context: OpenCodeContext) {
  if (!context.sessionID) throw new Error("Browser tools require a calling session.");
  const directory = context.directory || context.worktree;
  const workspaceId = await resolveWorkspaceId({ ...context, directory }, { requireDirectory: true });
  const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspaceId)}/sandbox/session/${encodeURIComponent(context.sessionID)}`, {
    headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Browser tools are unavailable because this chat's network policy could not be verified.");
  const settings = z.object({ enabled: z.boolean(), networkMode: z.enum(["allow", "approve", "block"]) }).parse(await response.json());
  if (settings.enabled && settings.networkMode !== "allow") {
    throw new Error("Browser tools are disabled while sandboxing is on and network access is Approve or Off. Use legalwork_webfetch or legalwork_websearch, which enforce the chat's network setting.");
  }
  return { workspaceId, sessionId: context.sessionID, directory };
}
