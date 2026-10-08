import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { localSessionDatabasePath } from "./content-search.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";

/** Read metadata, not transcripts. This also recovers activity missed while the UI was closed. */
export async function readSessionInbox(config: ServerConfig, workspaces: WorkspaceInfo[], automated: SessionInboxEntry[]): Promise<SessionInboxEntry[]> {
  const allowed = new Set(workspaces.map(workspace => workspace.id));
  const automation = new Map(automated.filter(entry => allowed.has(entry.workspaceId)).map(entry => [entry.sessionId, entry]));
  const path = localSessionDatabasePath(config);
  if (!existsSync(path)) return [...automation.values()];
  const db = await openSqliteReadonly(path);
  try {
    const sessions: SessionInboxEntry[] = [];
    for (const workspace of workspaces) {
      const root = workspace.opencode?.directory || workspace.directory || workspace.path;
      const canonical = await realpath(root).catch(() => resolve(root));
      const rows = db.all(`SELECT s.id, s.time_updated,
        (SELECT MAX(COALESCE(json_extract(m.data, '$.time.completed'), m.time_created)) FROM message m
          WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
          AND COALESCE(json_extract(m.data, '$.summary'), 0) = 0) AS assistant_at
        FROM session s WHERE s.directory IN (?, ?) AND (s.time_archived IS NULL OR s.time_archived = 0)`, [root, canonical]);
      for (const row of rows) {
        const sessionId = String(row.id);
        const run = automation.get(sessionId);
        sessions.push({ workspaceId: workspace.id, sessionId, updatedAt: Number(row.time_updated), assistantAt: Number(row.assistant_at ?? 0), ...(run ? { automation: run.automation } : {}) });
        automation.delete(sessionId);
      }
    }
    // Delivery may have just created a chat before the engine commits its metadata.
    // Older missing/archived chats must not be resurrected by an automation record.
    return [...sessions, ...[...automation.values()].filter(entry => Date.now() - entry.updatedAt < 30_000)];
  } finally { db.close(); }
}
