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
    return db.all(`SELECT 1 FROM session s JOIN message m ON m.session_id = s.id
      WHERE s.directory IN (?, ?) AND s.parent_id IS NULL AND json_extract(m.data, '$.role') = 'user'
      AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id
        AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0 AND COALESCE(json_extract(p.data, '$.ignored'), 0) = 0
        AND (json_extract(p.data, '$.type') = 'file' OR (json_extract(p.data, '$.type') = 'text' AND length(trim(json_extract(p.data, '$.text'))) > 0)))
      AND NOT EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text' AND json_extract(p.data, '$.text') LIKE '[Scheduled task:%')
      LIMIT 1`, [root, canonical]).length > 0;
  } finally { db.close(); }
}
