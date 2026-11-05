import { isAbsolute, relative } from "node:path";
import { access } from "node:fs/promises";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { assertEngineProjectReady } from "./engine-project.js";
import { assertSessionHistoryRecoveryReady } from "./session-history-undo.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig } from "./types.js";

const session = z.object({ id: z.string(), directory: z.string() });
const recovery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), sessionID: z.string() }),
  z.object({ kind: z.literal("subagent"), parentSessionID: z.string(), childSessionID: z.string() }),
]);
const background = z.object({ recovery });
const move = z.object({ location: z.object({ directory: z.string() }) });

/** Read-only compatibility inspection of the pinned 2.1.4 recovery tables.
 * No messages are replayed or removed. The released service owns recovery. */
export async function inspectNativeEngineRecovery(path: string): Promise<{ sessions: Array<z.infer<typeof session>>; directories: string[] }> {
  try { await access(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { sessions: [], directories: [] }; throw error; }
  const db = await openSqliteReadonly(path);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
    if (!tables.has("session_v2")) return { sessions: [], directories: [] };
    const sessions = new Map<string, z.infer<typeof session>>();
    const add = (id: string) => {
      if (sessions.has(id)) return;
      const row = db.all("SELECT id,directory FROM session_v2 WHERE id=?", [id])[0];
      if (!row) throw new ApiError(409, "engine_recovery_unresolved", "A recoverable OpenCode job refers to a missing chat. Preserve the engine database and resolve its recovery state before starting automation.", { sessionID: id });
      sessions.set(id, session.parse(row));
    };
    for (const row of db.all("SELECT id,directory FROM session_v2 WHERE time_suspended IS NOT NULL AND parent_id IS NULL")) {
      const info = session.parse(row); sessions.set(info.id, info);
    }
    if (tables.has("kv")) for (const row of db.iterate("SELECT value FROM kv WHERE key LIKE 'job.background/%'")) {
      const job = background.parse(JSON.parse(String(row.value)));
      if (job.recovery.kind === "shell") add(job.recovery.sessionID);
      else { add(job.recovery.parentSessionID); add(job.recovery.childSessionID); }
    }
    const directories = new Set([...sessions.values()].map(item => item.directory));
    if (tables.has("session_inbox")) for (const row of db.iterate("SELECT session_id,payload FROM session_inbox WHERE type='move'")) {
      if (!sessions.has(String(row.session_id))) continue;
      directories.add(move.parse(JSON.parse(String(row.payload))).location.directory);
    }
    return { sessions: [...sessions.values()], directories: [...directories] };
  } finally { db.close(); }
}

export async function assertNativeEngineRecoveryProjectsReady(config: ServerConfig, path: string) {
  const recovered = await inspectNativeEngineRecovery(path);
  const roots = await Promise.all(config.workspaces.map(async workspace => ({ workspace, directory: await canonicalFilePath(workspace.directory?.trim() || workspace.path) })));
  for (const directory of recovered.directories) {
    if (!isAbsolute(directory)) throw new ApiError(409, "engine_recovery_approval_required", "A saved OpenCode recovery location cannot be resolved. Review it before restarting agent automation.", { directory });
    const actual = await canonicalFilePath(directory);
    const selected = roots.filter(root => { const suffix = relative(root.directory, actual); return suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix); }).sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!selected) throw new ApiError(409, "engine_recovery_approval_required", "A saved OpenCode job belongs to a folder that is no longer registered. Reopen and approve that project before restarting automation. Its history and queued work are preserved.", { directory: actual });
    await assertEngineProjectReady(config, selected.workspace);
  }
  await assertSessionHistoryRecoveryReady(config, recovered.sessions.map(session => session.id));
  return recovered;
}
