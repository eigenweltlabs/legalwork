import { dirname } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";
import { providerUsageLimitErrorText, usageLimitDetailsSchema, type UsageLimitDetails } from "./provider-usage-limit.js";

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
      const columns = db.all("PRAGMA table_info(session_usage_limits)");
      if (!columns.some(column => column.name === "limit_json")) {
        try { db.exec("ALTER TABLE session_usage_limits ADD COLUMN limit_json TEXT"); }
        catch (error) {
          if (!db.all("PRAGMA table_info(session_usage_limits)").some(column => column.name === "limit_json")) throw error;
        }
      }
      if (!db.all("PRAGMA table_info(session_usage_limits)").some(column => column.name === "stop_reason")) {
        try { db.exec("ALTER TABLE session_usage_limits ADD COLUMN stop_reason TEXT"); }
        catch (error) { if (!db.all("PRAGMA table_info(session_usage_limits)").some(column => column.name === "stop_reason")) throw error; }
      }
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
  limit?: UsageLimitDetails | null,
  stopReason?: string,
) {
  const db = await store(config);
  db.run(
    "INSERT INTO session_usage_limits (workspace_id,session_id,message_id,provider_id,limit_json,stop_reason) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,session_id,message_id) DO UPDATE SET provider_id=excluded.provider_id,limit_json=excluded.limit_json,stop_reason=excluded.stop_reason",
    [workspaceId, sessionId, messageId, providerId, providerId === "eigenwelt" && limit ? JSON.stringify(limit) : null, stopReason ?? null],
  );
}

export async function applySessionUsageLimits(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  messages: SessionMessageInfo[],
): Promise<SessionMessageInfo[]> {
  const db = await store(config);
  const rows = db.all(
    "SELECT message_id,provider_id,limit_json,stop_reason FROM session_usage_limits WHERE workspace_id=? AND session_id=?",
    [workspaceId, sessionId],
  );
  const providers = new Map(
    rows.flatMap((row) =>
      typeof row.message_id === "string" && typeof row.provider_id === "string"
        ? [[row.message_id, {providerId:row.provider_id,limit:storedLimit(row.limit_json), reason: typeof row.stop_reason === "string" ? row.stop_reason : null}]]
        : [],
    ),
  );
  return messages.map((message) => {
    const provider = providers.get(message.id);
    if (provider === undefined || message.type !== "assistant") return message;
    return { ...message, error: {
      type: "legalwork.usage-limit",
      message: provider.reason ?? providerUsageLimitErrorText(provider.providerId, provider.limit),
    } };
  });
}

function storedLimit(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = usageLimitDetailsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
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
