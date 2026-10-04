import { dirname } from "node:path";
import type { SessionMessagesResponse2 } from "@opencode-ai/sdk/v2/client";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

// The engine records an interrupted turn when we stop a permanent quota retry.
// Keep the reason in our read model, keyed to that turn rather than the chat.
const stores = new Map<string, Promise<SqliteHandle>>();
async function store(config: ServerConfig) {
  const path = runtimeDbPath(config);
  let db = stores.get(path);
  if (!db) {
    db = (async () => {
      await ensureDir(dirname(path));
      const db = await openSqlite(path);
      db.exec(
        "CREATE TABLE IF NOT EXISTS session_usage_limits (workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT NOT NULL, PRIMARY KEY(workspace_id,session_id,message_id))",
      );
      return db;
    })();
    stores.set(path, db);
  }
  return db;
}

export async function recordSessionUsageLimit(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  messageId: string,
  providerId: string,
) {
  const db = await store(config);
  db.run(
    "INSERT INTO session_usage_limits VALUES (?,?,?,?) ON CONFLICT(workspace_id,session_id,message_id) DO UPDATE SET provider_id=excluded.provider_id",
    [workspaceId, sessionId, messageId, providerId],
  );
}

export async function applySessionUsageLimits(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  messages: SessionMessagesResponse2,
): Promise<SessionMessagesResponse2> {
  const db = await store(config);
  const rows = db.all(
    "SELECT message_id,provider_id FROM session_usage_limits WHERE workspace_id=? AND session_id=?",
    [workspaceId, sessionId],
  );
  const providers = new Map(
    rows.flatMap((row) =>
      typeof row.message_id === "string" && typeof row.provider_id === "string"
        ? [[row.message_id, row.provider_id]]
        : [],
    ),
  );
  return messages.map((message) => {
    const provider = providers.get(message.info.id);
    if (provider === undefined || message.info.role !== "assistant")
      return message;
    return {
      ...message,
      info: {
        ...message.info,
        error: {
          name: "UnknownError",
          data: {
            message:
              "LegalWork provider usage limit: " + encodeURIComponent(provider),
          },
        },
      },
    };
  });
}

export async function deleteSessionUsageLimits(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
) {
  (await store(config)).run(
    "DELETE FROM session_usage_limits WHERE workspace_id=? AND session_id=?",
    [workspaceId, sessionId],
  );
}
