import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { localSessionDatabasePath } from "./content-search.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/** All past days count, including archived chats. System activity is not a first use. */
export async function hasAssistantInteraction(config: ServerConfig, workspace: WorkspaceInfo) {
  const path = localSessionDatabasePath(config);
  if (!existsSync(path)) return false;
  const root = workspace.opencode?.directory || workspace.directory || workspace.path;
  const canonical = await realpath(root).catch(() => resolve(root));
  const db = await openSqliteReadonly(path);
  try {
    return db.all(`SELECT 1 FROM session_v2 s JOIN session_message m ON m.session_id = s.id
      WHERE s.directory IN (?, ?) AND s.parent_id IS NULL AND m.type = 'user'
      AND COALESCE(json_extract(m.data, '$.metadata.legalworkSystemReminder'), 0) = 0
      AND (length(trim(CASE WHEN json_type(m.data, '$.metadata.legalworkPrompt.visibleText') = 'text'
        THEN json_extract(m.data, '$.metadata.legalworkPrompt.visibleText') ELSE json_extract(m.data, '$.text') END)) > 0
        OR json_array_length(m.data, '$.files') > 0)
      AND COALESCE(json_extract(m.data, '$.text'), '') NOT LIKE '[Scheduled task:%'
      LIMIT 1`, [root, canonical]).length > 0;
  } finally { db.close(); }
}
