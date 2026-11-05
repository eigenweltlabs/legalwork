import type { SessionInfo } from "@opencode/client";
import { ApiError, findApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { isInternalSession, isReviewWorkerSession } from "./native-shared-values.js";
import { REVIEW_AGENT } from "./reviews/worker-identity.js";
import { workspaceEngineLocation } from "./engine-client.js";
import { authenticateWikiAgentRequest } from "./wiki/agent-access.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type ImageHistorySession = Pick<SessionInfo, "id" | "parentID" | "location" | "projectID" | "agent" | "metadata">;
export interface SessionImageSource { session: (sessionID: string, signal: AbortSignal) => Promise<ImageHistorySession>; }
export function sessionImageUnavailable(): never {
  throw new ApiError(404, "history_image_unavailable", "The image is not available in this chat or its verified project ancestors.");
}

/** Current native placement is authority. Captured placement is provenance:
 * a genuine move keeps the chat's own images, without granting an old-project parent. */
export async function assertSessionImageTarget(source: SessionImageSource, workspace: WorkspaceInfo, callerID: string, targetID: string, signal: AbortSignal) {
  const directory = await canonicalFilePath(workspaceEngineLocation(workspace).directory);
  const visited = new Set<string>();
  let id: string | undefined = callerID, projectID: string | undefined;
  while (id) {
    signal.throwIfAborted();
    if (visited.has(id)) sessionImageUnavailable();
    visited.add(id);
    const session: ImageHistorySession = await source.session(id, signal).catch(error => {
      if (findApiError(error)?.status === 404) sessionImageUnavailable();
      throw error;
    });
    signal.throwIfAborted();
    if (session.id !== id || await canonicalFilePath(session.location.directory) !== directory
      || isInternalSession(session) || isReviewWorkerSession(session) || session.agent === REVIEW_AGENT) sessionImageUnavailable();
    projectID ??= session.projectID;
    if (session.projectID !== projectID) sessionImageUnavailable();
    if (id === targetID) return { session, visited };
    id = session.parentID;
  }
  return sessionImageUnavailable();
}

export async function requireSessionImageOrigin(config: ServerConfig, request: Request, callerID: string) {
  const access = await authenticateWikiAgentRequest(config, request);
  if (!access || access.reviewWorker || access.sessionId !== callerID)
    throw new ApiError(403, "history_image_origin_required", "Image tools require this chat's scoped runtime origin.");
  return access;
}
export async function recheckSessionImageOrigin(config: ServerConfig, request: Request, before: Awaited<ReturnType<typeof requireSessionImageOrigin>>) {
  const after = await requireSessionImageOrigin(config, request, before.sessionId);
  if (after.generation !== before.generation || after.directory !== before.directory || after.actor.scope !== before.actor.scope)
    throw new ApiError(403, "history_image_origin_changed", "This chat's access changed during image access.");
  request.signal.throwIfAborted();
}
