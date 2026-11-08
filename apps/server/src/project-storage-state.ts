import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { AssistantResourceSchema, AssistantSettingsSchema } from "./assistant-schema.js";
import { relocatedSupportReference, relocatedSupportValues } from "./connected-project-config.js";
import { openSqlite, runtimeDbPath } from "./runtime-db.js";
import { projectPathKey } from "./workspace-path-match.js";
import { currentWikiAgentSession, relocateWikiAgentSession } from "./wiki/agent-access.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type SessionRelocation = { sessionId: string; from: string; to: string };
const directoryRecord = z.looseObject({ directory: z.string() });
const sourceRecord = directoryRecord.extend({ sessionId: z.string() });

/** Relocate app-owned addresses only after the native session placement was
 * verified. Scope, revocation, project selection and user prose stay intact. */
export async function relocateProjectState(config: ServerConfig, workspace: WorkspaceInfo & { previousPaths?: readonly string[] }, sessions: SessionRelocation[]): Promise<void> {
  const path = runtimeDbPath(config);
  const target = (id: string, directory: string) => sessions.find(session => session.sessionId === id && (projectPathKey(session.from) === projectPathKey(directory)
    || [workspace.previousPath, ...workspace.previousPaths ?? []].some(source => source && projectPathKey(join(source, relative(workspace.path, session.to))) === projectPathKey(directory))))?.to;
  if (await stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    const db = await openSqlite(path);
    const table = (name: string) => Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
    db.exec("BEGIN IMMEDIATE");
    try {
      if (table("assistant_session_access")) for (const session of sessions) {
        const row = db.get("SELECT data FROM assistant_session_access WHERE session_id = ?", [session.sessionId]);
        if (!row) continue;
        const record = directoryRecord.parse(JSON.parse(String(row.data))), directory = target(session.sessionId, record.directory);
        if (directory) db.run("UPDATE assistant_session_access SET data = ? WHERE session_id = ?", [JSON.stringify({ ...record, directory }), session.sessionId]);
      }
      if (table("assistant_proactivity_state")) {
        const row = db.get("SELECT data FROM assistant_proactivity_state WHERE key = 'scratchpad-source'");
        if (row) {
          const source = sourceRecord.nullable().parse(JSON.parse(String(row.data)));
          const directory = source ? target(source.sessionId, source.directory) : undefined;
          if (source && directory) db.run("UPDATE assistant_proactivity_state SET data = ? WHERE key = 'scratchpad-source'", [JSON.stringify({ ...source, directory })]);
        }
      }
      if (table("assistant_settings")) {
        const row = db.get("SELECT settings, routing FROM assistant_settings WHERE id = 1");
        if (row) {
          const settings = AssistantSettingsSchema.parse(JSON.parse(String(row.settings))), ids = new Map<string, string>();
          const routing = AssistantResourceSchema.array().parse(JSON.parse(String(row.routing))).map(resource => {
            if (resource.projectId !== workspace.id) return resource;
            const reference = resource.kind === "plugin" ? JSON.stringify(relocatedSupportValues(workspace, JSON.parse(resource.reference))) : relocatedSupportReference(workspace, resource.reference);
            const oldId = JSON.stringify([resource.kind, resource.projectId, resource.reference]);
            const id = resource.kind !== "plugin" && resource.id === oldId ? JSON.stringify([resource.kind, resource.projectId, reference]) : resource.id;
            ids.set(resource.id, id);
            return { ...resource, reference, id };
          });
          db.run("UPDATE assistant_settings SET settings = ?, routing = ? WHERE id = 1", [JSON.stringify({ ...settings, resourceIds: settings.resourceIds.map(id => ids.get(id) ?? id) }), JSON.stringify(routing)]);
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  }
  for (const session of sessions) {
    const origin = currentWikiAgentSession(config, session.sessionId);
    const directory = origin ? target(session.sessionId, origin.directory) : undefined;
    if (origin && directory) relocateWikiAgentSession(config, session.sessionId, origin.directory, directory);
  }
}
