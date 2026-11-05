import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { REVIEW_AGENT } from "../reviews/worker-identity.js";

/** An ordinary chat cannot become an isolated worker merely by selecting the agent. */
export async function isNativeReviewWorker(ctx: Plugin.Context, sessionID: string, agent?: string): Promise<boolean> {
  if (agent !== undefined && agent !== REVIEW_AGENT) return false;
  const session = await ctx.session.get({ sessionID });
  return session.agent === REVIEW_AGENT && session.metadata?.legalworkReviewWorker === true
    && typeof session.metadata.legalworkReviewClaim === "string";
}

export function registerPrimaryContext(ctx: Plugin.Context, handler: (event: SessionContext) => void | Promise<void>) {
  return ctx.session.hook("context", async event => {
    if (await isNativeReviewWorker(ctx, event.sessionID, event.agent)) return;
    await handler(event);
  });
}
