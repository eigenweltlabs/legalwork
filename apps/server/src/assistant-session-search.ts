import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { localSessionDatabasePath } from "./content-search.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import { matchesSearch, searchExcerpt } from "./search-schema.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export function searchFingerprint(input: unknown) { return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24); }
const cursorSchema = z.object({ fingerprint: z.string(), time: z.number().finite(), id: z.string() });
type Match = { projectId: string; projectName: string; sessionId: string; sessionTitle: string; messageId: string; partId: string; role: string; excerpt: string; createdAt: number; matchIn: "text" | "tool-output" };

/** Bounded, resumable scan of the server's engine store, not the UI's recent-message window. */
export async function searchAssistantSessions(config: ServerConfig, workspaces: WorkspaceInfo[], input: {
  query: string; limit: number; cursor?: string; sessionId?: string; includeToolOutputs?: boolean;
}, signal: AbortSignal) {
  const roots = new Map<string, WorkspaceInfo>();
  await Promise.all(workspaces.map(async workspace => {
    const root = workspace.opencode?.directory || workspace.directory || workspace.path;
    roots.set(resolve(root), workspace); roots.set(await realpath(root).catch(() => resolve(root)), workspace);
  }));
  const fingerprint = searchFingerprint([workspaces.map(workspace => workspace.id).sort(), input.query, input.sessionId, Boolean(input.includeToolOutputs)]);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())); }
    catch { throw new ApiError(400, "search_cursor", "The search cursor is invalid."); }
    if (cursor.fingerprint !== fingerprint) throw new ApiError(400, "search_cursor", "Keep the same query and scope when following a search cursor.");
  }
  if (!roots.size) return { items: [], nextCursor: null, scanned: 0 };
  const db = await openSqliteReadonly(localSessionDatabasePath(config));
  try {
    const values = [...roots.keys()];
    let where = `s.directory IN (${values.map(() => "?").join(",")}) AND COALESCE(s.time_archived, 0) = 0
      AND json_extract(m.data, '$.role') IN ('user','assistant')
      AND json_extract(p.data, '$.type') IN (${input.includeToolOutputs ? "'text','tool'" : "'text'"})
      AND COALESCE(json_extract(p.data, '$.synthetic'),0) = 0 AND COALESCE(json_extract(p.data, '$.ignored'),0) = 0`;
    if (input.sessionId) { where += " AND s.id = ?"; values.push(input.sessionId); }
    if (cursor) { where += " AND (p.time_created, p.id) < (CAST(? AS INTEGER), ?)"; values.push(String(cursor.time), cursor.id); }
    const rows = db.iterate(`SELECT p.id, p.message_id, p.time_created, s.id AS session_id, s.title, s.directory,
      json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS type,
      CASE WHEN json_extract(p.data, '$.type') = 'tool' THEN json_extract(p.data, '$.state.output') ELSE json_extract(p.data, '$.text') END AS text
      FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = p.session_id
      WHERE ${where} ORDER BY p.time_created DESC, p.id DESC LIMIT 1001`, values);
    const items: Match[] = [];
    let scanned = 0, nextCursor: string | null = null;
    for (const row of rows) {
      signal.throwIfAborted();
      if (scanned >= 1000 || items.length >= input.limit) return { items, nextCursor, scanned };
      scanned++;
      nextCursor = Buffer.from(JSON.stringify({ fingerprint, time: Number(row.time_created), id: String(row.id) })).toString("base64url");
      if (scanned % 100 === 0) await setImmediate();
      const workspace = roots.get(String(row.directory));
      if (!workspace || typeof row.text !== "string" || !matchesSearch(row.text, input.query)) continue;
      items.push({ projectId: workspace.id, projectName: workspace.displayName || workspace.name, sessionId: String(row.session_id), sessionTitle: String(row.title),
        messageId: String(row.message_id), partId: String(row.id), role: String(row.role), excerpt: searchExcerpt(row.text, input.query), createdAt: Number(row.time_created), matchIn: row.type === "tool" ? "tool-output" : "text" });
    }
    return { items, nextCursor: null, scanned };
  } finally { db.close(); }
}
