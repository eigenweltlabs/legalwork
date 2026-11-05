import { hasAssistantSubscription } from "./native-shared-values.js";
import { readFreshEntitlementsView } from "./eigenwelt-refresh.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

export async function assistantSubscriptionAvailable(config: ServerConfig) {
  return hasAssistantSubscription(await readFreshEntitlementsView(config));
}

export async function requireAssistantSubscription(config: ServerConfig) {
  if (!await assistantSubscriptionAvailable(config)) throw new ApiError(403, "assistant_subscription_required",
    "Assistant is included with AI plans. Choose Plus or Pro to get started.");
}

export async function requireAssistantWorkspaceSubscription(config: ServerConfig, workspaceId: string) {
  if (config.workspaces.some(item => item.id === workspaceId && item.preset === "main-assistant"))
    await requireAssistantSubscription(config);
}

/** Keep saved history, preferences and stopping work reachable after a plan ends. */
export function assistantRouteRequiresSubscription(method: string, path: string) {
  if (path !== "/assistant" && !path.startsWith("/assistant/")) return false;
  if (method === "GET" && ["/assistant", "/assistant/history", "/assistant/settings", "/assistant/settings/context", "/assistant/activity"].includes(path)) return false;
  // The handler checks the action, allowing stop/cancel/list without starting work.
  return path !== "/assistant/session-control";
}
