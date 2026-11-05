import { realpath } from "node:fs/promises";
import type { ServerConfig, TokenScope } from "../types.js";
import { ApiError } from "../errors.js";
import { within, type SandboxMount } from "../agent-sandbox/files.js";

export type WikiProjectGrant = { wikiId: string; projectId: string; root: string; scope: TokenScope; origin: string };
type SessionAccess = { revision: number; grants: Map<string, WikiProjectGrant>; controller: AbortController; protectedRoots: Set<string>; pending: Map<string, number> };
const access = new WeakMap<ServerConfig, Map<string, SessionAccess>>();
function session(config: ServerConfig, id: string): SessionAccess {
  let sessions = access.get(config);
  if (!sessions) { sessions = new Map(); access.set(config, sessions); }
  let value = sessions.get(id);
  if (!value) { value = { revision: 0, grants: new Map(), controller: new AbortController(), protectedRoots: new Set(), pending: new Map() }; sessions.set(id, value); }
  return value;
}
export function wikiProjectAccessRevision(config: ServerConfig, sessionId: string) { return session(config, sessionId).revision; }
export function wikiProjectGrants(config: ServerConfig, sessionId: string) { return [...(access.get(config)?.get(sessionId)?.grants.values() ?? [])]; }
export function wikiProjectAccessSignal(config: ServerConfig, sessionId: string) { return session(config, sessionId).controller.signal; }
export function beginWikiProjectApproval(config: ServerConfig, sessionId: string, projectId: string) {
  const value = session(config, sessionId);
  value.pending.set(projectId, (value.pending.get(projectId) ?? 0) + 1);
  return { revision: value.revision, signal: value.controller.signal, done: () => {
    const count = (value.pending.get(projectId) ?? 1) - 1;
    if (count) value.pending.set(projectId, count); else value.pending.delete(projectId);
  } };
}
export function grantWikiProjectAccess(config: ServerConfig, sessionId: string, grant: WikiProjectGrant, revision: number) {
  const value = session(config, sessionId);
  if (value.revision !== revision) throw new ApiError(409, "wiki_project_access_changed", "Project access changed while approval was pending. Request it again.");
  value.grants.set(grant.projectId, grant);
  value.protectedRoots.add(grant.root);
}
export function revokeWikiProjectAccess(config: ServerConfig, sessionId: string, projectId?: string) {
  const value = access.get(config)?.get(sessionId);
  if (!value) return;
  if (projectId) value.grants.delete(projectId); else value.grants.clear();
  value.revision++;
  value.controller.abort(new ApiError(403, "wiki_project_access_revoked", "Project access was revoked. This operation was stopped. Request access again before retrying."));
  value.controller = new AbortController();
}
/** Only for a deleted/revoked agent identity; live chats retain their root boundaries. */
export function forgetWikiProjectAccess(config: ServerConfig, sessionId: string) {
  revokeWikiProjectAccess(config, sessionId);
  access.get(config)?.delete(sessionId);
}
export async function requireWikiProjectAccess(config: ServerConfig, sessionId: string, projectId: string, wikiId: string, origin: string, scope: TokenScope) {
  const grant = access.get(config)?.get(sessionId)?.grants.get(projectId);
  const project = config.workspaces.find(item => item.id === projectId);
  const root = project ? await realpath(project.directory || project.path).catch(() => null) : null;
  if (!grant || grant.wikiId !== wikiId || grant.origin !== origin || grant.scope !== scope || grant.root !== root) {
    if (grant && grant.root !== root) revokeWikiProjectAccess(config, sessionId, projectId);
    throw new ApiError(403, "wiki_project_access_required", "This wiki chat needs the user's read-only approval for this project.");
  }
  return grant;
}

/** Registry changes also invalidate approvals that are still waiting for the user. */
export function revokeWikiProjectEverywhere(config: ServerConfig, projectId: string) {
  for (const [sessionId, value] of access.get(config) ?? [])
    if (value.grants.has(projectId) || value.pending.has(projectId)) revokeWikiProjectAccess(config, sessionId, projectId);
}

/** Never share a stale root merely because it used to have a read-only grant. */
export async function validWikiProjectGrants(config: ServerConfig, sessionId: string, wikiId: string, origin: string, scope: TokenScope) {
  const valid: WikiProjectGrant[] = [];
  for (const grant of wikiProjectGrants(config, sessionId)) {
    if (grant.wikiId !== wikiId) continue;
    try { valid.push(await requireWikiProjectAccess(config, sessionId, grant.projectId, wikiId, origin, scope)); }
    catch (error) { if (!(error instanceof ApiError && error.code === "wiki_project_access_required")) throw error; }
  }
  return valid;
}

/** Project folders cannot be reached through a broad, previously authorized mount. */
export async function wikiProjectSandboxMounts(config: ServerConfig, wikiId: string, wikiWorkspaceIds: Set<string>, sessionId: string,
  origin: string, scope: TokenScope, mounts: SandboxMount[]): Promise<SandboxMount[]> {
  const roots = (await Promise.all(config.workspaces.filter(project => !wikiWorkspaceIds.has(project.id))
    .map(project => realpath(project.directory || project.path).catch(() => null)))).filter(root => root !== null);
  const grants = await validWikiProjectGrants(config, sessionId, wikiId, origin, scope);
  // Retain the boundary after unregister/revoke. Otherwise the same root could
  // come back as a writable generic external-directory mount on the next call.
  const protectedRoots = new Set([...roots, ...(access.get(config)?.get(sessionId)?.protectedRoots ?? [])]);
  const result: SandboxMount[] = [];
  for (const mount of mounts) {
    const source = await realpath(mount.source).catch(() => { throw new ApiError(403, "wiki_project_mount_unavailable", "A shared folder is unavailable. Review this chat's project access."); });
    const overlaps = [...protectedRoots].filter(root => within(root, source) || within(source, root));
    if (!overlaps.length) { result.push({ ...mount, source }); continue; }
    // A parent grant already approves every file below it. Nested registrations
    // must not require another grant or make an approved parent impossible to use.
    if (!grants.some(grant => within(grant.root, source))) {
      if (!overlaps.some(root => within(root, source)))
        throw new ApiError(403, "wiki_project_mount_too_broad", "Choose the specific approved project folder, not a parent folder.");
      throw new ApiError(403, "wiki_project_access_required", "This wiki chat needs the user's read-only approval for this project.");
    }
    result.push({ ...mount, source, writable: false });
  }
  return result;
}
