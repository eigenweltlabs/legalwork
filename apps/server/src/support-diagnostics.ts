import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readAuditEntries } from "./audit.js";
import { ApiError } from "./errors.js";
import { openSqliteReadonly, MANAGED_ENGINE_DB_FILENAME } from "./managed-opencode-db.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const MAX_SESSIONS = 100;
const MAX_RECORDS = 20_000;
const MAX_STRING_BYTES = 256 * 1024;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const OMITTED = "[chat message omitted]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function parse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value);
  try { const parsed: unknown = JSON.parse(value); return record(parsed); } catch { return {}; }
}
function pick(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.filter(field => field in value).map(field => [field, value[field]]));
}

/** Keep diagnostic detail; remove credentials and verbatim message bodies repeated in traces. */
export function createDiagnosticRedactor(messageBodies: string[] = []) {
  const bodies = [...new Set(messageBodies.filter(Boolean))].sort((a, b) => b.length - a.length);
  const exactBodies = new Set(bodies);
  const needles = [...new Set(bodies.filter(body => body.length >= 20).flatMap(body => [body, JSON.stringify(body).slice(1, -1)]))];
  const secretKey = /(?:password|passwd|secret|credentials?|apikey|accesskey|privatekey|token)$|^(?:authorization|proxyauthorization|cookie|setcookie)$/i;
  let truncatedStrings = 0;
  let remaining = MAX_TRACE_BYTES;
  const scrub = (text: string) => {
    if (exactBodies.has(text)) return OMITTED;
    let result = text;
    for (const needle of needles) {
      // Short replies are only removed on exact match, so IDs / error words remain readable.
      if (needle.length <= result.length) result = result.replaceAll(needle, () => OMITTED);
    }
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
      .replace(/(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|host[_-]?token|token|password|secret|credential|authorization|api[-_]?key)["']?\s*[:=]\s*)(["']?)[^"'\s,;}]+\2/gi, "$1$2<redacted>$2")
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1<redacted>@")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "<redacted private key>")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<redacted>");
  };
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 40) return "[nesting limit reached]";
    if (typeof value === "string") {
      // Tool results and log lines often embed JSON rather than nested objects.
      if (/^\s*[\[{]/.test(value)) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed === "object" && parsed !== null) return JSON.stringify(clean(parsed, depth + 1));
        } catch { /* ordinary text / multiline logs */ }
      }
      const text = scrub(value);
      const bytes = Buffer.byteLength(text);
      const limit = Math.max(0, Math.min(MAX_STRING_BYTES, remaining));
      remaining -= Math.min(bytes, limit);
      if (bytes <= limit) return text;
      truncatedStrings++;
      return `${Buffer.from(text).subarray(0, limit).toString("utf8")}\n[truncated: ${bytes - limit} bytes omitted]`;
    }
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (!isRecord(value)) return value;
    const chat = value.role === "user" || value.role === "assistant" || value.role === "system";
    const nativeText = ["user", "synthetic", "system", "skill", "compaction"].includes(String(value.type));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name.length >= 20 ? scrub(name) : name,
      secretKey.test(name.replace(/[-_\s]/g, "")) ? "<redacted>"
        : chat && ["content", "text", "parts", "reasoning", "system", "structured", "summary"].includes(name) ? OMITTED
          : nativeText && ["text", "summary", "description", "native", "metadata"].includes(name) ? OMITTED
            : value.type === "user" && name === "files" ? clean(Array.isArray(item) ? item.map(attachment) : [], depth + 1)
              : value.type === "assistant" && ["native", "metadata"].includes(name) ? OMITTED
                : value.type === "assistant" && name === "content" ? clean(nativeAssistantContent(item), depth + 1)
          : clean(item, depth + 1),
    ]));
  };
  return { clean, stats: () => ({ truncatedStrings, traceByteLimitReached: remaining === 0 }) };
}

function sessionInfo(value: Record<string, unknown>) {
  // Titles, summaries and custom instructions are generated from the conversation.
  return pick(value, ["id", "projectID", "parentID", "workspaceID", "directory", "path", "version", "agent", "model", "time", "cost", "tokens"]);
}
function messageInfo(value: Record<string, unknown>) {
  return pick(value, ["id", "sessionID", "parentID", "role", "time", "agent", "mode", "model", "modelID", "providerID", "variant", "path", "cost", "tokens", "finish", "error"]);
}
function attachment(value: unknown) {
  return pick(record(value), ["id", "sessionID", "messageID", "type", "mime", "filename", "name"]);
}
function toolContent(value: unknown) {
  return Array.isArray(value) ? value.map(item => {
    const content = record(item);
    return content.type === "text" ? pick(content, ["type", "text"]) : attachment(content);
  }) : [];
}
function nativeAssistantContent(value: unknown) {
  return Array.isArray(value) ? value.map(item => {
    const content = record(item);
    if (content.type === "text" || content.type === "reasoning") return {
      ...pick(content, ["type", "time"]), text: OMITTED,
      originalBytes: typeof content.originalBytes === "number" ? content.originalBytes
        : typeof content.text === "string" ? Buffer.byteLength(content.text) : 0,
    };
    if (content.type !== "tool") return { type: content.type, detailsOmitted: true };
    const state = record(content.state);
    return { ...pick(content, ["type", "id", "name", "executed", "time"]), state: {
      ...pick(state, ["status", "input", "metadata", "error"]),
      ...(Array.isArray(state.content) ? { content: toolContent(state.content) } : {}),
    } };
  }) : [];
}
/** V2 stores complete messages; assistant tool calls are entries inside content, not a part table. */
function nativeMessageInfo(value: Record<string, unknown>) {
  const base = pick(value, ["id", "type", "time", "agent", "model", "previous", "projectID", "location", "subpath", "cost", "tokens", "finish", "rawFinish", "error", "retry", "snapshot", "outcome", "status", "reason", "skill", "name"]);
  if (value.type === "assistant") return { ...base, content: nativeAssistantContent(value.content) };
  if (value.type === "shell") return { ...base, ...pick(value, ["shellID", "command", "exit", "output"]) };
  if (value.type === "user") return { ...base, text: OMITTED, files: Array.isArray(value.files) ? value.files.map(attachment) : [] };
  if (["synthetic", "system", "skill", "compaction"].includes(String(value.type))) return { ...base, text: OMITTED };
  return base;
}
function collectNativeMessageBodies(value: Record<string, unknown>, bodies: string[]) {
  for (const body of [value.text, value.summary, value.description, value.title]) if (typeof body === "string") bodies.push(body);
  if (value.type === "assistant" && Array.isArray(value.content)) for (const item of value.content) {
    const content = record(item);
    if ((content.type === "text" || content.type === "reasoning") && typeof content.text === "string") bodies.push(content.text);
  }
}

function nativeEventData(type: string, data: Record<string, unknown>) {
  // Opaque native/provider data, instruction deltas and app metadata can contain whole conversations.
  const base = pick(data, ["sessionID", "projectID", "parentID", "messageID", "assistantMessageID", "inboxID", "id", "ordinal", "time", "started", "at", "agent", "model", "previous", "location", "subpath", "version", "cost", "tokens", "source", "finish", "rawFinish", "error", "attempt", "reason", "inputID", "executed", "delivery", "idle", "snapshot", "files", "to"]);
  if (type.startsWith("session.tool.")) return { ...base, ...pick(data, ["name", "input", "metadata"]),
    ...(type === "session.tool.input.ended" ? { text: data.text } : {}),
    ...(Array.isArray(data.content) ? { content: toolContent(data.content) } : {}) };
  if (type === "session.message.content.updated") return { ...base, content: nativeAssistantContent(data.content) };
  if (type.startsWith("session.shell.")) return { ...base,
    shell: pick(record(data.shell), ["id", "command", "status", "exit", "time"]), ...pick(data, ["output"]) };
  if (type === "session.inbox.enqueued") return { ...base, item: pick(record(data.item), ["id", "type", "delivery", "time"]) };
  return base;
}
function partInfo(value: Record<string, unknown>) {
  const base = pick(value, ["id", "sessionID", "messageID", "type"]);
  switch (value.type) {
    case "text": case "reasoning":
      return { ...base, ...pick(value, ["time", "synthetic", "ignored"]), text: OMITTED,
        originalBytes: typeof value.text === "string" ? Buffer.byteLength(value.text) : 0 };
    case "file": return attachment(value);
    case "tool": {
      const state = record(value.state);
      return { ...base, ...pick(value, ["tool", "callID", "metadata"]), state: {
        ...pick(state, ["status", "input", "raw", "output", "title", "error", "metadata", "time"]),
        ...(Array.isArray(state.attachments) ? { attachments: state.attachments.map(attachment) } : {}),
      } };
    }
    case "step-start": case "step-finish": case "retry": case "compaction": case "snapshot": case "patch":
      return { ...base, ...pick(value, ["time", "reason", "cost", "tokens", "attempt", "error", "auto", "overflow", "tail_start_id", "snapshot", "hash", "files"]) };
    case "subtask": return { ...base, ...pick(value, ["agent", "model", "command"]), prompt: OMITTED, description: OMITTED };
    case "agent": return { ...base, name: value.name };
    default: return { ...base, detailsOmitted: true };
  }
}
function eventInfo(row: Record<string, unknown>, native = false) {
  const data = parse(row.data);
  const infoTime = record(record(data.info).time);
  const part = record(data.part);
  const partTime = record(part.time);
  const toolTime = record(record(part.state).time);
  const timestamp = [typeof row.created === "number" && row.created > 0 ? row.created : undefined, data.time, infoTime.updated, infoTime.completed, infoTime.created, toolTime.end, toolTime.start, partTime.end, partTime.start]
    .find(value => typeof value === "number" && Number.isFinite(value));
  const type = String(row.type);
  const payload = native ? nativeEventData(type.replace(/\.\d+$/, ""), data)
    : type.startsWith("session.") ? { sessionID: data.sessionID, info: sessionInfo(record(data.info)) }
    : type.startsWith("message.part.") ? { sessionID: data.sessionID, time: data.time, part: partInfo(record(data.part)) }
      : type.startsWith("message.updated.") ? { sessionID: data.sessionID, info: messageInfo(record(data.info)) }
        : pick(data, ["sessionID", "messageID", "partID", "time"]);
  return { id: row.id, sessionID: row.aggregate_id, sequence: row.seq, timestamp: typeof timestamp === "number" ? timestamp : null, type, data: payload };
}

/** Read-only export of persisted engine traces plus desktop/runtime logs. Never copy the DB. */
export async function collectSupportDiagnostics(config: ServerConfig, now = Date.now(), desktop: unknown = null, days: unknown = 7) {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new ApiError(400, "invalid_days", "days must be a whole number from 1 to 365");
  }
  const since = now - days * 86400000;
  const base = { format: "legalwork-technical-diagnostics", schemaVersion: 2, generatedAt: new Date(now).toISOString(),
    scope: { sessionsActiveSince: new Date(since).toISOString(), days, maxSessions: MAX_SESSIONS, maxRecordsPerSection: MAX_RECORDS },
    privacy: { omitted: ["user and assistant message bodies", "reasoning text", "chat titles and summaries", "attachment bytes", "credentials"],
      included: ["original IDs and timestamps", "file paths and tool names", "tool arguments and results", "full errors", "model and token metadata", "engine events", "runtime and application logs"],
      notice: "Tool inputs, results and logs can contain document excerpts or paraphrases of a conversation. Review before sharing. Secret redaction is best effort." },
    limitations: ["Only retained local traces are available; missing events cannot be reconstructed.", "Session metadata, current runtime snapshots and records without timestamps can include context outside the selected period.", "Large strings and total trace text are capped; truncation is reported."],
  };
  const override = process.env.OPENCODE_DB?.trim();
  const databasePath = override && isAbsolute(override) ? override : join(runtimeStorageDir(config), MANAGED_ENGINE_DB_FILENAME);
  const sessions: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const messageBodies: string[] = [];
  const truncation: Record<string, boolean> = {};
  const sources: Record<string, string> = { database: existsSync(databasePath) ? "ready" : "missing" };
  if (existsSync(databasePath)) {
    const db = await openSqliteReadonly(databasePath);
    try {
      db.run("PRAGMA busy_timeout = 1000", []);
      db.run("BEGIN", []); // one consistent view, including committed WAL records
      const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
      const native = tables.has("session_v2");
      const sessionTable = native ? "session_v2" : "session";
      sources.engineSchema = native ? "native-v2" : tables.has("session") ? "legacy-v1" : "unrecognized";
      // Message bodies are read only to remove exact copies from logs / tool output. They are never serialized.
      if (tables.has("part")) {
        for (const row of db.iterate("SELECT json_extract(data, '$.text') AS text FROM part WHERE json_valid(data) AND json_extract(data, '$.type') IN ('text', 'reasoning')")) {
          if (typeof row.text === "string") messageBodies.push(row.text);
        }
      }
      if (native && tables.has("session_message")) {
        for (const row of db.iterate("SELECT type,data FROM session_message WHERE json_valid(data)")) {
          collectNativeMessageBodies({ ...parse(row.data), type: row.type }, messageBodies);
        }
        // Some durable events have no surviving message projection (e.g. an older compaction).
        if (tables.has("event")) for (const row of db.iterate("SELECT type,data FROM event WHERE json_valid(data)")) {
          const type = String(row.type).replace(/\.\d+$/, "");
          if (type.startsWith("session.tool.") || type.startsWith("session.shell.")) continue;
          const data = parse(row.data);
          collectNativeMessageBodies({ ...data, type: "assistant" }, messageBodies);
          const payload = record(record(data.item).payload);
          collectNativeMessageBodies(payload, messageBodies);
        }
      }
      if (tables.has(sessionTable)) for (const row of db.iterate(`SELECT title FROM ${sessionTable}`)) {
        if (typeof row.title === "string") messageBodies.push(row.title);
      }
      const recent = tables.has(sessionTable)
        ? db.all(`SELECT * FROM ${sessionTable} WHERE time_updated >= ? ORDER BY time_updated DESC, id DESC LIMIT ${MAX_SESSIONS + 1}`, [String(since)]) : [];
      truncation.sessions = recent.length > MAX_SESSIONS;
      for (const row of recent.slice(0, MAX_SESSIONS)) sessions.push({
        ...pick(row, ["id", "project_id", "workspace_id", "parent_id", "directory", "path", "version", "agent", "time_created", "time_updated", "time_compacting", "time_archived", "cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]),
        model: parse(row.model),
      });
      if (sessions.length) {
        const ids = sessions.map(row => String(row.id));
        const placeholders = ids.map(() => "?").join(",");
        for (const [table, target] of (native ? [["session_message", messages], ["event", events]] : [["message", messages], ["part", parts], ["event", events]]) satisfies Array<[string, Record<string, unknown>[]]>) {
          if (!tables.has(table)) { sources[table] = "missing"; continue; }
          const event = table === "event";
          const period = event ? native ? "AND (created = 0 OR created >= ?)" : "" : "AND time_updated >= ?";
          const rows = db.all(`SELECT * FROM ${table} WHERE ${event ? "aggregate_id" : "session_id"} IN (${placeholders}) AND json_valid(data) ${period} ORDER BY ${event || native ? "seq" : "time_created"} DESC, id DESC LIMIT ${MAX_RECORDS + 1}`, period ? [...ids, String(since)] : ids);
          truncation[table] = rows.length > MAX_RECORDS;
          for (const row of rows.slice(0, MAX_RECORDS).reverse()) {
            if (event) {
              const entry = eventInfo(row, native);
              if (entry.timestamp === null || entry.timestamp >= since) target.push(entry);
              continue;
            }
            const data = parse(row.data);
            // Summaries/system prompts are message content too; remove exact copies from logs.
            if (table === "message") {
              const summary = record(data.summary);
              for (const body of [data.system, summary.title, summary.body]) if (typeof body === "string") messageBodies.push(body);
            }
            target.push({ ...pick(row, ["id", "session_id", "message_id", "seq", "time_created", "time_updated"]),
              ...(native ? nativeMessageInfo({ ...data, type: row.type }) : table === "message" ? messageInfo(data) : partInfo(data)) });
          }
        }
      }
    } finally { db.close(); }
  }
  const audit: unknown[] = [];
  for (const workspace of config.workspaces) {
    try { audit.push(...(await readAuditEntries(workspace.path, workspace.id, 200)).filter(entry => entry.timestamp >= since)); }
    catch { sources[`audit:${workspace.id}`] = "unreadable"; }
  }
  const redactor = createDiagnosticRedactor(messageBodies);
  const payload = redactor.clean({ desktop, server: { uptimeMs: now - config.startedAt, platform: process.platform, arch: process.arch,
    versions: process.versions, memory: process.memoryUsage(), cpu: process.cpuUsage(), workspaces: config.workspaces.map(workspace => ({ id: workspace.id, path: workspace.path })) },
    sessions, messages, parts, events, audit });
  return { ...base, sources, counts: { sessions: sessions.length, messages: messages.length, parts: parts.length, events: events.length, audit: audit.length },
    truncation: { ...truncation, ...redactor.stats() }, ...record(payload) };
}
