import type { Plugin } from "@opencode/plugin";
import { retryStopReason } from "../session-retry-policy.js";

/** Veto retries before scheduling, preserving LegalWork's existing recovery policy. */
export async function registerBoundedProviderRetries(ctx: Plugin.Context): Promise<void> {
  await ctx.session.hook("retry", (event) => {
    // Native attempt includes the first request; the existing policy counts retries.
    if (retryStopReason({ type: "retry", attempt: event.attempt - 1, message: event.error.message })) {
      event.decision = { retry: false };
    }
  });
}
