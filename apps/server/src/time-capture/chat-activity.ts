import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { localSessionDatabasePath } from "../content-search.js";
import { openSqliteReadonly } from "../managed-opencode-db.js";
import { randomUUID } from "node:crypto";
import type { SessionMessageInfo } from "@opencode/client";
import type { ServerConfig } from "../types.js";
import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { isInternalSession } from "../native-shared-values.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";

type Witness = { projectId: string | null; sessionId?: string; messageId?: string; kind: string; agentVisibility?: "foreground" | "background"; watching?: boolean; start: number; end: number };

/** Use the native transcript only for a turn submitted here or a run observed on this device. */
export function witnessedReplies(records: SessionMessageInfo[], witnesses: Witness[], start: number, end: number) {
  const requests = new Set(witnesses.flatMap(row => row.messageId ? [row.messageId] : []));
  const runs = witnesses.filter(row => row.kind === "agent" || row.kind === "execution" || row.watching);
  let localTurn = false;
  return records.flatMap(message => {
    if (message.type === "user" || message.type === "synthetic") localTurn = message.type === "user" && requests.has(message.id);
    if (message.type !== "assistant" || !message.time.completed || message.time.completed < start || message.time.created >= end) return [];
    if (!localTurn && !runs.some(row => row.start < message.time.completed! && row.end > message.time.created)) return [];
    const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
    return [{ id: message.id, from: message.time.created, at: message.time.completed, text: text.slice(0, 1000) }];
  });
}

/** A fast execution can finish before the busy indicator reaches a renderer. Fill only uncovered clock spans. */
export function unwitnessedRunSpans(from: number, to: number, group: Witness[], observations: Witness[]) {
  const recorded = group.filter(row => row.kind === "agent" && row.start < to && row.end > from);
  const views = observations.filter(row => (row.watching !== undefined || row.kind === "foreground" || row.kind === "window") && row.start < to && row.end > from);
  const bounds = [...new Set([from, to, ...[...recorded, ...views].flatMap(row => [Math.max(from, row.start), Math.min(to, row.end)])])].sort((a, b) => a - b);
  const spans: { from: number; to: number; visibility?: "foreground" | "background" }[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1], end = bounds[i];
    if (recorded.some(row => row.start <= start && row.end >= end)) continue;
    const visible = views.filter(row => row.start <= start && row.end >= end);
    const watching = visible.some(row => row.watching && row.projectId === group[0].projectId && row.sessionId === group[0].sessionId);
    const other = visible.some(row => row.kind === "foreground" || row.watching || row.kind === "window");
    if (!visible.length && group.every(row => row.kind === "execution")) continue;
    const visibility = watching ? "foreground" : other ? "background" : undefined;
    const prior = spans.at(-1);
    if (prior && prior.to === start && prior.visibility === visibility) prior.to = end;
    else spans.push({ from: start, to: end, visibility });
  }
  return spans;
}

/** The native inbox can miss an entire background turn between two status polls. Read only its clock and owning directory here. */
async function completedLocalRuns(config: ServerConfig, allowed: Set<string>, coverage: Witness[], start: number, end: number): Promise<Witness[]> {
  const file = localSessionDatabasePath(config);
  if (!coverage.length || !existsSync(file)) return [];
  const folders = new Map<string, string>();
  const normalize = (path: string) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
  for (const workspace of config.workspaces.filter(w => allowed.has(w.id))) {
    const root = workspace.opencode?.directory || workspace.directory || workspace.path;
    folders.set(normalize(root), workspace.id);
    folders.set(normalize(await realpath(root).catch(() => resolve(root))), workspace.id);
  }
  const db = await openSqliteReadonly(file);
  try {
    if (!folders.size) return [];
    const dirs = [...folders.keys()];
    const directoryColumn = process.platform === "win32" ? "lower(replace(s.directory, char(92), '/'))" : "s.directory";
    const records = db.all(`SELECT s.id, s.directory, m.time_created AS started,
      json_extract(m.data, '$.time.completed') AS completed FROM session_message m JOIN session_v2 s ON s.id=m.session_id
      WHERE ${directoryColumn} IN (${dirs.map(() => "?").join(",")}) AND m.type='assistant' AND m.time_created < ? AND json_extract(m.data, '$.time.completed') >= CAST(? AS INTEGER)`,
      [...dirs, String(end), String(start)]);
    return records.flatMap(record => {
      const projectId = folders.get(normalize(String(record.directory)));
      const from = Number(record.started), to = Number(record.completed);
      if (!projectId || !Number.isFinite(to) || !coverage.some(row => row.start < to && row.end > from)) return [];
      return [{ kind: "execution", projectId, sessionId: String(record.id), start: from, end: to }];
    });
  } finally { db.close(); }
}

export async function chatReplyEvidence(config: ServerConfig, profileId: string, date: string, start: number, end: number,
  rows: Witness[], allowed: Set<string>, signal?: AbortSignal): Promise<WorkdayEvidence[]> {
  const windows = rows.filter(row => row.kind === "window" && row.start < end && row.end > start);
  const additional = await completedLocalRuns(config, allowed, windows, start, end).catch(() => []);
  const groups = new Map<string, Witness[]>();
  for (const row of [...rows, ...additional]) {
    if (!row.projectId || !row.sessionId || row.start >= end || (row.end < start && row.kind !== "chat-request")) continue;
    const key = JSON.stringify([row.projectId, row.sessionId]);
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const out: WorkdayEvidence[] = [];
  for (const group of groups.values()) {
    signal?.throwIfAborted();
    const { projectId, sessionId } = group[0];
    const workspace = config.workspaces.find(w => w.id === projectId);
    if (!workspace || !sessionId) continue;
    try {
      const client = createEngineClient(config, workspace);
      const timeout = AbortSignal.timeout(5000);
      const request = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const session = await getWorkspaceEngineSession(client, workspace, sessionId, request);
      if (isInternalSession(session)) continue;
      const records: SessionMessageInfo[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      const earliest = group.reduce((first, row) => row.kind === "chat-request" ? Math.min(first, row.start) : first, start);
      do {
        const page = await client.message.list({ sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: "desc" }) }, { signal: request });
        records.push(...page.data);
        cursor = page.cursor.next ?? undefined;
        if (!cursor || cursors.has(cursor) || page.data.some(m => m.time.created < earliest)) break;
        cursors.add(cursor);
      } while (cursor);
      for (const reply of witnessedReplies(records.reverse(), group, start, end)) {
        for (const span of unwitnessedRunSpans(Math.max(reply.from, start), Math.min(reply.at, end), group, rows)) {
          const eventKey = digest([profileId, "chat-execution", date, projectId, sessionId, reply.id, span.from]);
          const body = { date, source: "agent" as const, observation: "agent" as const, agentVisibility: span.visibility,
            projectId, narrative: "Agent run: " + (session.title || "Chat"), activity: "", startAt: new Date(span.from).toISOString(),
            endAt: new Date(span.to).toISOString(), workedMinutes: null, dismissed: false };
          out.push({ eventKey, proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]) } });
        }
        if (!reply.text || reply.at >= end || (group.every(row => row.kind === "execution") &&
            !windows.some(row => row.start <= reply.at && row.end >= reply.at))) continue;
        const eventKey = digest([profileId, "chat-reply", projectId, sessionId, reply.id]);
        const atCompletion = group.filter(row => row.start < reply.at && row.end >= reply.at);
        const watched = atCompletion.some(row => row.agentVisibility === "foreground" || row.watching);
        const background = atCompletion.some(row => row.agentVisibility === "background") ||
          windows.some(row => row.start < reply.at && row.end >= reply.at);
        const agentVisibility = watched ? "foreground" as const : background ? "background" as const : undefined;
        const body = { date, source: "agent" as const, agentVisibility, projectId, narrative: "Chat reply: " + (session.title || "Chat"),
          observedAt: new Date(reply.at).toISOString(), activity: "", startAt: null, endAt: null,
          workedMinutes: null, dismissed: false, changeSummary: reply.text };
        out.push({ eventKey, proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]) } });
      }
    } catch {
      signal?.throwIfAborted();
      // A deleted chat or an offline engine cannot erase the locally recorded request and focus spans.
    }
  }
  return out;
}
