import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { REVIEW_SUBMIT_TOOL } from "../reviews/worker-identity.js";
import { isNativeReviewWorker } from "./native-review-worker.js";
import { nativeTool } from "./native-tool.js";
import { serverUrl, workspaceToolHeaders, type OpenCodeContext } from "./office-plugin-shared.js";

/** Only the LegalWork server can supply the immutable schema for an active worker claim. */
export async function registerReviewWorker(ctx: Plugin.Context): Promise<() => void> {
  const controller = new AbortController();
  async function request(context: OpenCodeContext, operation: "contract" | "submit", body?: unknown) {
    if (!context.sessionID || !context.directory) throw new Error("Review inference requires its native session and working directory.");
    const session = await ctx.session.get({ sessionID: context.sessionID });
    const workspace = z.string().min(1).parse(session.metadata?.legalworkReviewWorkspaceId);
    const headers = await workspaceToolHeaders(context);
    if (!headers["x-legalwork-wiki-agent-token"]) throw new Error("Review inference requires its scoped runtime credential.");
    delete headers.Authorization;
    const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/reviews/workers/${encodeURIComponent(context.sessionID ?? "")}/${operation}`, {
      method: operation === "contract" ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: context.abort ? AbortSignal.any([controller.signal, context.abort]) : controller.signal,
    });
    if (!response.ok) throw new Error(`Review inference authority could not be verified (${response.status}).`);
    return response.json();
  }
  await ctx.tool.transform(editor => {
    const tool = nativeTool(ctx, {
      name: REVIEW_SUBMIT_TOOL, description: "Submit the complete evidence-grounded answer for this review attempt. Call exactly once.",
      schema: z.record(z.string(), z.json()), outputSchema: z.object({ accepted: z.literal(true) }),
      async execute(value, context) {
        if (!context.sessionID || !await isNativeReviewWorker(ctx, context.sessionID, context.agent))
          throw new Error("Review submission is available only inside its active inference worker.");
        return JSON.stringify(await request(context, "submit", { value, messageID: context.messageID, toolID: executionID.getStore() }));
      },
    });
    editor.add({ ...tool, options: { permission: REVIEW_SUBMIT_TOOL, codemode: false }, execute: (input, call) => executionID.run(call.id, () => tool.execute(input, call)) });
  });
  await ctx.session.hook("context", async event => {
    if (!await isNativeReviewWorker(ctx, event.sessionID, event.agent)) { delete event.tools[REVIEW_SUBMIT_TOOL]; return; }
    const session = await ctx.session.get({ sessionID: event.sessionID });
    const contract = z.object({ id: z.string(), schema: z.json(), instructions: z.string() }).parse(await request({ sessionID: event.sessionID, directory: session.location.directory }, "contract"));
    if (contract.id !== session.metadata?.legalworkReviewClaim) throw new Error("Review inference claim changed.");
    const schema = z.fromJSONSchema(z.object({}).passthrough().parse(contract.schema));
    event.tools = { [REVIEW_SUBMIT_TOOL]: { description: "Submit the complete answer using this exact schema. Call once; do not use other tools.", input: z.toJSONSchema(schema) } };
    event.system = [{ type: "text", text: contract.instructions }];
  });
  await ctx.session.hook("retry", async event => {
    if (await isNativeReviewWorker(ctx, event.sessionID, event.agent)) event.decision = { retry: false };
  });
  return () => controller.abort();
}

import { AsyncLocalStorage } from "node:async_hooks";
const executionID = new AsyncLocalStorage<string>();
