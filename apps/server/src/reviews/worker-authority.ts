import { z } from "zod";
import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { REVIEW_AGENT } from "./agent.js";
import { reviewWorkerClaims, REVIEW_SUBMIT_TOOL } from "./worker.js";

export async function reviewWorkerContract(config: ServerConfig, workspace: WorkspaceInfo, sessionID: string) {
  const session = await getWorkspaceEngineSession(createEngineClient(config, workspace), workspace, sessionID);
  if (session.agent !== REVIEW_AGENT || session.metadata?.legalworkReviewWorker !== true)
    throw new ApiError(404, "review_worker_not_found", "This is not an active review inference attempt.");
  return reviewWorkerClaims(config).get(workspace, session.id, z.string().parse(session.metadata.legalworkReviewClaim));
}

export const ReviewWorkerSubmission = z.strictObject({ value: z.json(), messageID: z.string().min(1), toolID: z.string().min(1) });
export async function submitReviewWorker(config: ServerConfig, workspace: WorkspaceInfo, sessionID: string, raw: unknown) {
  const claim = await reviewWorkerContract(config, workspace, sessionID), input = ReviewWorkerSubmission.parse(raw);
  const message = await createEngineClient(config, workspace).session.message.get({ sessionID, messageID: input.messageID });
  if (message.type !== "assistant" || message.agent !== REVIEW_AGENT || message.model.id !== claim.selected.model || message.model.providerID !== claim.selected.providerId
    || !message.content.some(part => part.type === "tool" && part.id === input.toolID && part.name === REVIEW_SUBMIT_TOOL))
    throw new ApiError(403, "review_worker_model", "The model response did not match the selected model or submission tool.");
  return reviewWorkerClaims(config).submit(workspace, sessionID, claim.id, input);
}
