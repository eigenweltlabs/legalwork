import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import { isAbsolute, join, relative, sep } from "node:path";
import { finishLocalProject, localProjectMigrationPending } from "./project-storage.js";
import { restoreLegacySessionPermissions } from "./session-history-permissions.js";
import { permissionPatternMatches } from "./agent-sandbox/permissions.js";
import { sameProjectDirectory } from "./workspace-path-match.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export async function projectSessionMovesPending(config: ServerConfig): Promise<boolean> {
  for (const workspace of config.workspaces) if (await localProjectMigrationPending(workspace)) return true;
  return false;
}

/** Preserve path-scoped grants and denials when their native relative base moves.
 * Search expressions, shell patterns and wildcard-only policies keep their meaning. */
function movedPermissions(session: SessionInfo, workspace: WorkspaceInfo) {
  return session.permissions?.map(rule => {
    if (!workspace.previousPath || rule.resource === "*" || !["read", "edit", "list", "external_directory"].some(action => permissionPatternMatches(action, rule.action))) return rule;
    const path = isAbsolute(rule.resource) ? rule.resource : join(workspace.previousPath, rule.resource);
    const suffix = relative(workspace.previousPath, path);
    const resource = /^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix) ? join(workspace.path, suffix) : path;
    return { ...rule, resource: resource.split(sep).join("/") };
  });
}

async function listSessions(client: OpenCodeClient) {
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.session.list(cursor ? { cursor } : {});
    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Native history repeated a migration cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return sessions;
}

/** Run in plain-serve recovery before interrupted work can resume. Use the
 * native move API, never a model turn or a private database schema rewrite. */
const migrations = new WeakMap<ServerConfig, Promise<void>>();
export async function migrateLocalProjectSessions(config: ServerConfig, client: OpenCodeClient): Promise<void> {
  const previous = migrations.get(config);
  const current = (async () => { await previous?.catch(() => {}); await moveSessions(config, client); })();
  migrations.set(config, current);
  try { await current; } finally { if (migrations.get(config) === current) migrations.delete(config); }
}
async function moveSessions(config: ServerConfig, client: OpenCodeClient): Promise<void> {
  if (!await projectSessionMovesPending(config)) return;
  const sessions = await listSessions(client);
  for (const workspace of config.workspaces) {
    if (!await localProjectMigrationPending(workspace) || !workspace.previousPath) continue;
    const moving = [];
    for (const session of sessions) if (await sameProjectDirectory(session.location.directory, workspace.previousPath)) moving.push(session);
    // Restore every child's original policy before moving a parent can affect it.
    for (const session of moving) {
      const restored = await restoreLegacySessionPermissions(config, { ...workspace, path: workspace.previousPath, directory: workspace.previousPath }, client, session);
      const permissions = movedPermissions(restored, workspace);
      if (permissions && JSON.stringify(permissions) !== JSON.stringify(restored.permissions)) await client.session.update({ sessionID: session.id, permissions });
    }
    for (const session of moving) {
      const current = await client.session.get({ sessionID: session.id });
      if (await sameProjectDirectory(current.location.directory, workspace.previousPath)) await client.session.move({ sessionID: session.id, directory: workspace.path, delivery: "steer" });
      // Native move admits a control item; a fully configured location can
      // take time to initialize before the projector changes its placement.
      const deadline = Date.now() + 30_000;
      let moved = await client.session.get({ sessionID: session.id });
      while (!await sameProjectDirectory(moved.location.directory, workspace.path) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        moved = await client.session.get({ sessionID: session.id });
      }
      if (!await sameProjectDirectory(moved.location.directory, workspace.path)) throw new Error("A saved chat has not finished moving to its local project home. Its history remains preserved.");
    }
    for (const session of await listSessions(client)) if (await sameProjectDirectory(session.location.directory, workspace.previousPath)) throw new Error("Native chats remain in the original project. Migration will resume on the next startup.");
    await finishLocalProject(workspace);
  }
}
