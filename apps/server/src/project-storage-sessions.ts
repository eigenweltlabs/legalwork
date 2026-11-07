import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import { isAbsolute, join, relative, sep } from "node:path";
import { finishLocalProject, localProjectMigrationPending, localProjectReferenceRoots } from "./project-storage.js";
import { restoreLegacySessionPermissions } from "./session-history-permissions.js";
import { sameProjectDirectory } from "./workspace-path-match.js";
import { projectPathKey } from "./workspace-path-match.js";
import { relocateProjectState, type SessionRelocation } from "./project-storage-state.js";
import { openBenchmarkStore } from "./benchmarks/store.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import type { WorkspaceRoots } from "./project-storage-paths.js";

export async function projectSessionMovesPending(config: ServerConfig): Promise<boolean> {
  for (const workspace of config.workspaces) if (await localProjectMigrationPending(workspace)) return true;
  return false;
}

/** Preserve path-scoped grants and denials when their native relative base moves.
 * Search expressions, shell patterns and wildcard-only policies keep their meaning. */
function movedPermissions(session: SessionInfo, workspace: WorkspaceInfo) {
  return session.permissions?.map(rule => {
    // A wildcard action also applies to shell commands and search patterns.
    // Keep its resource unchanged; file-only aliases are evaluated by the
    // managed permission hook rather than rewriting the saved generic rule.
    if (!workspace.previousPath || rule.resource === "*" || !["read", "edit", "list", "external_directory"].includes(rule.action)) return rule;
    const path = isAbsolute(rule.resource) ? rule.resource : join(session.location.directory, rule.resource);
    const suffix = relative(workspace.previousPath, path);
    const resource = /^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix) ? join(workspace.path, suffix) : path;
    return { ...rule, resource: resource.split(sep).join("/") };
  });
}

/** Benchmark item locations are the only nested native workspaces owned by
 * this migration. Ordinary connected subfolders retain their location. */
export function relocatedProjectDirectory(workspace: WorkspaceRoots, directory: string): string {
  if (!workspace.previousPath) return directory;
  const key = projectPathKey(directory);
  for (const root of new Set([workspace.previousPath, ...workspace.previousPaths ?? []])) {
    const source = projectPathKey(root);
    if (key === source) return workspace.path;
    const suffix = key.startsWith(`${source}/`) ? relative(root, directory) : "";
    if (/^\.legalwork[\\/]benchmarks[\\/][^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(suffix)) return join(workspace.path, suffix);
  }
  return directory;
}

function previousProjectDirectory(workspace: WorkspaceInfo, directory: string): string | undefined {
  if (!workspace.previousPath) return;
  const original = { ...workspace, path: workspace.previousPath, previousPath: workspace.path };
  const previous = relocatedProjectDirectory(original, directory);
  return previous !== directory ? previous : undefined;
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
  if (config.readOnly) return;
  const previous = migrations.get(config);
  const current = (async () => { await previous?.catch(() => {}); await moveSessions(config, client); })();
  migrations.set(config, current);
  try { await current; } finally { if (migrations.get(config) === current) migrations.delete(config); }
}
async function moveSessions(config: ServerConfig, client: OpenCodeClient): Promise<void> {
  if (!await projectSessionMovesPending(config)) return;
  const { relocateProjectImports } = await import("./project-storage-imports.js");
  const sessions = await listSessions(client);
  for (const registered of config.workspaces) {
    if (!await localProjectMigrationPending(registered) || !registered.previousPath) continue;
    const originalDirectory = registered.previousPath;
    const workspace = await localProjectReferenceRoots(registered);
    const moving: Array<{ session: SessionInfo; from: string; target: string }> = [];
    const verified: SessionRelocation[] = [];
    for (const session of sessions) {
      let target = relocatedProjectDirectory(workspace, session.location.directory);
      if (target === session.location.directory && await sameProjectDirectory(session.location.directory, originalDirectory)) target = workspace.path;
      if (target !== session.location.directory) moving.push({ session, from: session.location.directory, target });
      else {
        const from = previousProjectDirectory(workspace, session.location.directory);
        if (from) verified.push({ sessionId: session.id, from, to: session.location.directory });
      }
    }
    // Restore every child's original policy before moving a parent can affect it.
    for (const { session } of moving) {
      const restored = await restoreLegacySessionPermissions(config, { ...workspace, path: session.location.directory, directory: session.location.directory }, client, session);
      const permissions = movedPermissions(restored, workspace);
      if (permissions && JSON.stringify(permissions) !== JSON.stringify(restored.permissions)) await client.session.update({ sessionID: session.id, permissions });
    }
    for (const { session, from, target } of moving) {
      const current = await client.session.get({ sessionID: session.id });
      if (await sameProjectDirectory(current.location.directory, from)) await client.session.move({ sessionID: session.id, directory: target, delivery: "steer" });
      // Native move admits a control item; a fully configured location can
      // take time to initialize before the projector changes its placement.
      const deadline = Date.now() + 30_000;
      let moved = await client.session.get({ sessionID: session.id });
      while (!await sameProjectDirectory(moved.location.directory, target) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        moved = await client.session.get({ sessionID: session.id });
      }
      if (!await sameProjectDirectory(moved.location.directory, target)) throw new Error("A saved chat has not finished moving to its local project home. Its history remains preserved.");
      verified.push({ sessionId: session.id, from, to: moved.location.directory });
    }
    for (const session of await listSessions(client)) if (relocatedProjectDirectory(workspace, session.location.directory) !== session.location.directory || await sameProjectDirectory(session.location.directory, originalDirectory)) throw new Error("Native chats remain in the original project. Migration will resume on the next startup.");
    await relocateProjectState(config, workspace, verified);
    (await openBenchmarkStore(config)).relocateProjectDirectories(workspace.id, directory => relocatedProjectDirectory(workspace, directory));
    await relocateProjectImports(config, workspace);
    await writeLegalworkRuntimeConfigFile(config, workspace.id);
    await finishLocalProject(workspace);
  }
}
