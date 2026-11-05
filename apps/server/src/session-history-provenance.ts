import { SessionV1 } from "@opencode/schema/session-v1";
import { Schema } from "effect";
import { z } from "zod";
import { ScheduledTaskMessageSchema, isReviewWorkerSession } from "./native-shared-values.js";
import type { HistoricalMessage, SessionHistoryProvenance } from "@legalwork/types/session-history";
import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from "@opencode/client";
import { canonicalFilePath } from "./file-write-lock.js";
import { workspaceEngineLocation, getWorkspaceEngineSession, listEngineMessages } from "./engine-client.js";
import { REVIEW_AGENT } from "./reviews/worker-identity.js";
import { ApiError } from "./errors.js";
import { readLegacyHistoryBackup } from "./history-v1-backup.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

function recordJson(raw: unknown): Record<string, unknown> | null {
  try { return z.record(z.string(),z.unknown()).safeParse(JSON.parse(String(raw))).data ?? null; }
  catch { return null; }
}

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
    const backup = await readLegacyHistoryBackup(config);
    if (!backup) return { version: 1, status: "not-migrated", messages: {} };
    const db = await openSqliteReadonly(backup.path);
    try {
      const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
      if (!["session", "message", "part"].every(table => tables.has(table))) return { version: 1, status: "not-migrated", messages: {} };
      const original = db.all("SELECT directory FROM session WHERE id = ?", [session.id])[0];
      if (!original) return { version: 1, status: "not-migrated", messages: {} };
      if (typeof original.directory !== "string" || await canonicalFilePath(original.directory) !== actual) return { version: 1, status: "unavailable", messages: {}, issue: "Original chat ownership could not be verified." };
      const selected = new Map(nativeMessages.filter(message => message.type === "user").map(message => [message.id, message]));
      const users = new Set<string>();
      for (const row of db.iterate("SELECT id, time_created, data FROM message WHERE session_id = ?", [session.id])) {
        const native = selected.get(String(row.id)), value = recordJson(row.data);
        if (!native || native.time.created !== row.time_created || !value || !Schema.is(SessionV1.Info)({ ...value, id: row.id, sessionID: session.id }) || value.role !== "user") continue;
        users.add(String(row.id));
      }
      const messages: Record<string, HistoricalMessage> = {};
      for (const row of db.iterate("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id", [session.id])) {
        const messageID = String(row.message_id);
        if (!users.has(messageID)) continue;
        const value = recordJson(row.data);
        if (!value) continue;
        const part = { ...value, id: row.id, sessionID: session.id, messageID };
        if (!Schema.is(SessionV1.Part)(part)) continue;
        const entry = messages[messageID] ?? { attachments: [] };
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          const scheduled = ScheduledTaskMessageSchema.safeParse(part.metadata?.legalworkScheduledTask);
          const native = selected.get(messageID);
          if (scheduled.success && scheduled.data.workspaceId === workspace.id && native?.text.includes(part.text)) entry.scheduledTask = scheduled.data;
        }
        if (part.type === "file") {
          const sourcePath = part.source?.type === "file" || part.source?.type === "symbol" ? part.source.path : undefined;
          let nativeFileIndex: number | undefined;
          if (part.url.startsWith("data:")) {
            const comma = part.url.indexOf(",");
            if (comma < 0) continue;
            const encoded = part.url.slice(comma + 1), header = part.url.slice(0, comma);
            const data = header.endsWith(";base64") ? Buffer.from(encoded, "base64").toString("base64") : Buffer.from(decodeURIComponent(encoded)).toString("base64");
            const index = selected.get(messageID)?.files?.findIndex((file, index) => file.data === data && file.mime === part.mime && file.name === part.filename && !entry.attachments.some(attachment => attachment.nativeFileIndex === index));
            if (index === undefined || index < 0) continue;
            nativeFileIndex = index;
          }
          entry.attachments.push({ partID: part.id, name: part.filename, mime: part.mime,
            ...(nativeFileIndex === undefined ? { bytes: "reference-only", reference: part.url } : { bytes: "preserved-inline", nativeFileIndex }),
            ...(sourcePath ? { sourcePath } : part.source?.type === "resource" ? { reference: part.source.uri } : {}),
          });
        }
        if (entry.scheduledTask || entry.attachments.length) messages[messageID] = entry;
      }
      return { version: 1, status: "available", messages };
    } finally { db.close(); }
  } catch {
    // The native transcript remains available, but callers must show that
    // provenance failed verification rather than silently claiming recovery.
    return { version: 1, status: "unavailable", messages: {}, issue: "Historical details could not be verified from the private backup." };
  }
}
