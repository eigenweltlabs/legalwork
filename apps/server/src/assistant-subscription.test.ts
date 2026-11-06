import { expect, test } from "bun:test";
import { hasAssistantSubscription } from "./native-shared-values.js";
import { assistantRouteRequiresSubscription } from "./assistant-subscription.js";

test("Assistant follows Plus/Pro subscriptions without an extra feature flag", () => {
  for (const plan of ["plus", "pro"]) {
    for (const subscriptionStatus of ["active", "trialing", "past_due"]) {
      expect(hasAssistantSubscription({ connected: true, entitlements: { plan, subscriptionStatus } })).toBe(true);
    }
    for (const subscriptionStatus of [null, "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(hasAssistantSubscription({ connected: true, entitlements: { plan, subscriptionStatus } })).toBe(false);
    }
  }
  for (const plan of [null, "sync", "free", "unknown"]) {
    expect(hasAssistantSubscription({ connected: true, entitlements: { plan, subscriptionStatus: "active" } })).toBe(false);
  }
  expect(hasAssistantSubscription({ connected: false, entitlements: { plan: "pro", subscriptionStatus: "active" } })).toBe(false);
  expect(hasAssistantSubscription({ connected: true, entitlements: null })).toBe(false);
  expect(hasAssistantSubscription(undefined)).toBe(false);
});

test("Assistant routes gate work but leave saved history and stop controls reachable", () => {
  for (const path of ["/assistant/current", "/assistant/delegate", "/assistant/follow-up", "/assistant/briefing", "/assistant/tool-access"])
    expect(assistantRouteRequiresSubscription("POST", path)).toBe(true);
  for (const path of ["/assistant/conversations/conv_project/messages", "/assistant/conversations/conv_project/attention/reply"])
    expect(assistantRouteRequiresSubscription("POST", path)).toBe(false);
  expect(assistantRouteRequiresSubscription("PATCH", "/assistant/conversations/conv_project")).toBe(false);
  expect(assistantRouteRequiresSubscription("POST", "/assistant/conversations")).toBe(true);
  expect(assistantRouteRequiresSubscription("POST", "/assistant/session-control")).toBe(false);
  for (const path of ["/assistant", "/assistant/history", "/assistant/settings", "/assistant/activity", "/assistant/conversations", "/assistant/conversations/current", "/assistant/attention", "/assistant/conversations/conv_project/attention", "/assistant/conversation-for-session/session", "/assistant/submissions/request", "/assistant/submissions/request/output", "/assistant/projects", "/assistant/tasks", "/assistant/sessions/search", "/launcher/search", "/workspaces"])
    expect(assistantRouteRequiresSubscription("GET", path)).toBe(false);
});
