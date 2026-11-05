import { isReviewWorkerSession } from "./native-shared-values.js";
import type { HistoricalMessage, SessionHistoryProvenance } from "@legalwork/types/session-history";
import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client";
import { canonicalFilePath } from "./file-write-lock.js";
import { workspaceEngineLocation, getWorkspaceEngineSession, listEngineMessages } from "./engine-client.js";
import { REVIEW_AGENT } from "./reviews/worker-identity.js";
import { ApiError } from "./errors.js";
import { readCurrentHistory, historyBytesHash } from "./current-history-state.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/** The tool supplies caller identity from native execution context, never
 * model arguments. Only the actual caller and its same-project ancestors. */
export async function readScopedSessionHistoryProvenance(config:ServerConfig,workspace:WorkspaceInfo,client:OpenCodeClient,callerSessionID:string,targetSessionID:string) {
  const visited=new Set<string>();
  let id:string|undefined=callerSessionID;
  while(id && !visited.has(id)) {
    visited.add(id);
    const session=await getWorkspaceEngineSession(client,workspace,id);
    if(isReviewWorkerSession(session) || session.agent===REVIEW_AGENT)throw new ApiError(403,"history_provenance_forbidden","Historical chat references are unavailable to review workers.");
    if(id===targetSessionID)return {sessionID:session.id,provenance:await readSessionHistoryProvenance(config,workspace,session,await listEngineMessages(client,session.id))};
    id=session.parentID;
  }
  throw new ApiError(404,"session_not_found","Historical references are available only for this chat and its ancestors.");
}

/** Call only after authoritative native session authorization. Recheck both
 * native and original directories here; provenance never grants file access. */
export async function readSessionHistoryProvenance(config: ServerConfig, workspace: WorkspaceInfo, session: SessionInfo, nativeMessages: readonly SessionMessageInfo[]): Promise<SessionHistoryProvenance> {
  const [expected, actual] = await Promise.all([canonicalFilePath(workspaceEngineLocation(workspace).directory), canonicalFilePath(session.location.directory)]);
  if (expected !== actual) throw new ApiError(404, "session_not_found", "Chat not found in this project.");
  try {
    const state = await readCurrentHistory(config), original = state?.sessions[session.id];
    if (!original) return { version: 1, status: "not-migrated", messages: {} };
    if (original.directory !== actual) return { version: 1, status: "unavailable", messages: {}, issue: "Original chat ownership could not be verified." };
    const messages: Record<string, HistoricalMessage> = {};
    for (const native of nativeMessages) {
      const source = original.messages[native.id];
      if (native.type !== "user" || !source || source.createdAt !== native.time.created) continue;
      const entry: HistoricalMessage = { attachments: [] };
      for (const scheduled of source.scheduled) if (scheduled.task.workspaceId === workspace.id && native.text.includes(scheduled.text)) entry.scheduledTask = scheduled.task;
      for (const attachment of source.attachments) {
        const { inlineHash, ...reference } = attachment;
        if (inlineHash) {
          const index = native.files?.findIndex((file, index) => historyBytesHash(file.data) === inlineHash && file.mime === attachment.mime && file.name === attachment.name && !entry.attachments.some(item => item.nativeFileIndex === index));
          if (index === undefined || index < 0) continue;
          entry.attachments.push({ ...reference, bytes: "preserved-inline", nativeFileIndex: index });
        } else entry.attachments.push({ ...reference, bytes: "reference-only" });
      }
      if (entry.scheduledTask || entry.attachments.length) messages[native.id] = entry;
    }
    return { version: 1, status: "available", messages };
  } catch {
    // The native transcript remains available, but callers must show that
    // provenance failed verification rather than silently claiming recovery.
    return { version: 1, status: "unavailable", messages: {}, issue: "Historical details could not be verified from saved migration data." };
  }
}
