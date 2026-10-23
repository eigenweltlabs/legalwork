import { forgetWikiProjectAccess, revokeWikiProjectAccess } from "./project-access.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { Actor, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";

type SessionOrigin = { sessionId: string; directory: string; scope: TokenScope; generation: string; scheduledProjects?: "all" | string[] };
export const SessionAuthoritySchema = z.object({ scope: z.enum(["owner", "collaborator", "viewer"]), scheduledProjects: z.union([z.literal("all"), z.array(z.string())]).optional(), sourceSessionId: z.string().optional() });
export type SessionAuthority = z.infer<typeof SessionAuthoritySchema>;
type SessionLookup = (workspace: WorkspaceInfo, sessionId: string, directory: string, signal: AbortSignal) => Promise<unknown>;
type RuntimeAccess = { token: string; sessions: Map<string, SessionOrigin>; parents: Map<string, string>; revoked: Set<string>; lookup?: SessionLookup; changed?: (sessionId: string, origin: SessionOrigin | null) => void };
const runtimes = new WeakMap<ServerConfig, RuntimeAccess>();
const sessionSchema = z.object({ id: z.string().min(1).max(200), directory: z.string().min(1), parentID: z.string().min(1).max(200).optional() });

function runtime(config: ServerConfig): RuntimeAccess {
  let access = runtimes.get(config);
  if (!access) {
    access = { token: randomBytes(32).toString("hex"), sessions: new Map(), parents: new Map(), revoked: new Set() };
    runtimes.set(config, access);
  }
  return access;
}

/** Verified lineage is a revocation dependency, never a cached scope grant. */
function revokeProjectTree(config: ServerConfig, sessionId: string) {
  const pending = [sessionId], visited = new Set<string>(), access = runtime(config);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    revokeWikiProjectAccess(config, id);
    for (const [child, parent] of access.parents) if (parent === id) pending.push(child);
  }
}

/** The server supplies its authenticated, directory-pinned engine client. */
export function configureWikiAgentSessionLookup(config: ServerConfig, lookup: SessionLookup): void {
  runtime(config).lookup = lookup;
}

/** Durable internal dispatches observe later human scope changes and revocations. */
export function observeWikiAgentSessions(config: ServerConfig, changed: NonNullable<RuntimeAccess["changed"]>): void {
  runtime(config).changed = changed;
}

export function currentWikiAgentSession(config: ServerConfig, sessionId: string): SessionOrigin | undefined {
  return runtime(config).sessions.get(sessionId);
}

/** Only the managed engine receives this ephemeral, narrow credential. */
export async function ensureWikiAgentToken(config: ServerConfig): Promise<string> {
  return runtime(config).token;
}

/** Called by the authenticated proxy, never from request-body identity claims. */
export async function grantWikiAgentSession(config: ServerConfig, input: {
  sessionId: string;
  directory: string;
  scope: TokenScope;
  scheduledProjects?: "all" | string[];
}, beforeCommit?: () => void): Promise<void> {
  if (!input.sessionId || input.sessionId.length > 200) throw new ApiError(403, "wiki_agent_session_invalid", "The agent session is unknown.");
  const directory = await realpath(input.directory).catch(() => null);
  beforeCommit?.();
  if (!directory) {
    // A remote engine may use a directory absent on this host. Its ordinary
    // session can proceed, but no private wiki grant may survive that change.
    const access = runtime(config);
    revokeProjectTree(config, input.sessionId);
    access.sessions.delete(input.sessionId);
    access.revoked.add(input.sessionId);
    access.changed?.(input.sessionId, null);
    return;
  }
  const access = runtime(config);
  const previous = access.sessions.get(input.sessionId);
  if (previous && previous.directory !== directory)
    throw new ApiError(403, "wiki_agent_directory_mismatch", "This agent session belongs to another working directory.");
  // Replace rather than merge: a collaborator taking over an owner's session
  // must immediately lose the owner's private wiki access.
  const unchanged = previous?.scope === input.scope && JSON.stringify(previous.scheduledProjects) === JSON.stringify(input.scheduledProjects);
  if (previous && !unchanged || access.parents.has(input.sessionId)) revokeProjectTree(config, input.sessionId);
  access.parents.delete(input.sessionId);
  access.sessions.set(input.sessionId, { sessionId: input.sessionId, directory, scope: input.scope, scheduledProjects: input.scheduledProjects,
    generation: unchanged ? previous.generation : randomBytes(16).toString("hex") });
  access.revoked.delete(input.sessionId);
  access.changed?.(input.sessionId, access.sessions.get(input.sessionId)!);
}

/** Human UI reads may reopen an existing chat before its next prompt registers it. */
export async function verifiedWikiSessionOrigin(config: ServerConfig, workspace: WorkspaceInfo, sessionId: string, scope: TokenScope, signal: AbortSignal): Promise<SessionOrigin> {
  const access = runtime(config);
  const directory = await realpath(workspace.directory || workspace.path);
  const existing = access.sessions.get(sessionId);
  if (existing && existing.directory === directory && !access.revoked.has(sessionId)) return existing;
  const lookup = access.lookup;
  const found = lookup ? sessionSchema.safeParse(await lookup(workspace, sessionId, directory, AbortSignal.any([signal, AbortSignal.timeout(10_000)])).catch(() => null)) : null;
  if (!found?.success || found.data.id !== sessionId || await realpath(found.data.directory).catch(() => null) !== directory || access.revoked.has(sessionId))
    throw new ApiError(403, "wiki_agent_session_unknown", "This chat does not belong to this wiki.");
  if (found.data.parentID) {
    const inherited = await inheritedOrigin(config, access, sessionId, directory, signal);
    if (!inherited) throw new ApiError(403, "wiki_agent_session_unknown", "This chat's originating permissions are unavailable.");
    return inherited;
  }
  await grantWikiAgentSession(config, { sessionId, directory, scope });
  const origin = access.sessions.get(sessionId);
  if (!origin) throw new ApiError(403, "wiki_agent_session_unknown", "This chat is unavailable.");
  return origin;
}

export function revokeWikiAgentSession(config: ServerConfig, sessionId: string): void {
  const access = runtime(config);
  access.sessions.delete(sessionId);
  access.revoked.add(sessionId);
  access.changed?.(sessionId, null);
  revokeProjectTree(config, sessionId);
  forgetWikiProjectAccess(config, sessionId);
}

/** Inherit live scope, never a cached owner grant, from an engine-verified ancestor. */
async function inheritedOrigin(config: ServerConfig, access: RuntimeAccess, sessionId: string, directory: string, requestSignal: AbortSignal): Promise<SessionOrigin | undefined> {
  const lookup = access.lookup;
  if (!lookup || access.revoked.has(sessionId)) return;
  const workspaces = await Promise.all(config.workspaces.map(async workspace => {
    const root = await realpath(workspace.directory || workspace.path).catch(() => null);
    if (!root) return null;
    const child = relative(root, directory);
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? { workspace, root } : null;
  }));
  const source = workspaces.filter(item => item !== null).sort((a, b) => b.root.length - a.root.length)[0];
  if (!source) return;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10_000)]);
  const visited = new Set<string>();
  let id: string | undefined = sessionId;
  while (id && visited.size < 64) {
    if (visited.has(id) || access.revoked.has(id) || signal.aborted) return;
    visited.add(id);
    const session = sessionSchema.safeParse(await lookup(source.workspace, id, directory, signal).catch(() => null));
    if (!session.success || session.data.id !== id || await realpath(session.data.directory).catch(() => null) !== directory || signal.aborted) return;
    // Read after the engine response, so a downgrade during lookup takes effect.
    const origin = access.sessions.get(id);
    if (access.revoked.has(id)) return;
    if (origin) return origin.directory === directory ? origin : undefined;
    if (session.data.parentID) access.parents.set(id, session.data.parentID);
    else access.parents.delete(id);
    id = session.data.parentID;
  }
}

function narrowWikiPath(method: string, pathname: string): boolean {
  if (method === "POST" && /^\/assistant\/(?:delegate|follow-up|session-control)$/.test(pathname)) return true;
  // Recording reads inherit the authenticated session's scope. The library
  // routes separately require owner access, including after a scope downgrade.
  if (method === "GET" && /^\/recorder\/recordings(?:\/[^/]+)?$/.test(pathname)) return true;
  if (method === "GET" && /^\/wikis\/[^/]+\/sessions\/[^/]+\/projects(?:\/[^/]+\/(?:files|read))?$/.test(pathname)) return true;
  if (method === "POST" && /^\/wikis\/[^/]+\/sessions\/[^/]+\/projects\/[^/]+\/access$/.test(pathname)) return true;
  if (method === "POST" && /^\/workspace\/[^/]+\/view-generations\/[^/]+$/.test(pathname)) return true;
  if (method === "GET" && pathname === "/wikis/file-policy") return true;
  if (method === "GET" && (pathname === "/workspaces" || pathname === "/wikis")) return true;
  if (method === "GET" && /^\/wikis\/(?!deleted$|team$)[^/]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/wikis\/[^/]+\/search$/.test(pathname)) return true;
  if (method === "GET" && /^\/wikis\/[^/]+\/fields$/.test(pathname)) return true;
  if (method === "POST" && /^\/wikis\/[^/]+\/query$/.test(pathname)) return true;
  if (method === "GET" && /^\/(?:wikis|workspace)\/[^/]+\/ui-views$/.test(pathname)) return true;
  if (method === "GET" && /^\/(?:wikis|workspace)\/[^/]+\/ui-views\/[^/]+$/.test(pathname)) return true;
  if (method === "PATCH" && /^\/wikis\/[^/]+\/properties$/.test(pathname)) return true;
  return ["GET", "PUT", "DELETE"].includes(method) && /^\/wikis\/[^/]+\/page$/.test(pathname);
}

/** Existing storage/sandbox/skill tools need the originating member's access to their own wiki workspace. */
function workspaceToolPath(method: string, pathname: string): string | null {
  const match = pathname.match(/^\/workspace\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const route = match[2]!;
  const suggestion = (["GET", "POST"].includes(method) && route === "wiki-suggestions") || (["GET", "PUT"].includes(method) && /^wiki-suggestions\/[^/]+$/.test(route));
  const allowed = suggestion || (method === "GET"
    ? /^(?:storage\/roots|storage\/[^/]+\/(?:capabilities|children|search|file)|sandbox\/session\/[^/]+|skills|skills\/[^/]+\/(?:composed|package-file))$/.test(route)
    : method === "POST" && /^(?:storage\/[^/]+\/(?:checkout|filename-search|from-workspace|rename|folders)|sandbox\/(?:execute|web)|sessions\/[^/]+\/review-recovery|skills|skills\/(?!hub\/)[^/]+\/resources)$/.test(route));
  return allowed ? decodeURIComponent(match[1]!) : null;
}

/**
 * This is not a host/owner credential. A valid runtime secret authenticates
 * only a session whose origin the server recorded from an authenticated user.
 * Wiki routes still enforce that actor's visibility and this directory's scope.
 */
export async function authenticateWikiAgentRequest(config: ServerConfig, request: Request): Promise<{
  actor: Actor;
  directory: string;
  sessionId: string;
  originSessionId: string;
  generation: string;
  scheduledProjects?: "all" | string[];
} | null> {
  const token = request.headers.get("x-legalwork-wiki-agent-token");
  if (token === null) return null;
  const access = runtimes.get(config);
  const candidate = Buffer.from(token);
  const expected = Buffer.from(access?.token ?? "");
  if (!access || candidate.length !== expected.length || !timingSafeEqual(candidate, expected))
    throw new ApiError(403, "wiki_agent_unauthorized", "The wiki agent connection is not authorized.");
  const pathname = new URL(request.url).pathname;
  const toolWorkspaceId = workspaceToolPath(request.method, pathname);
  if (!narrowWikiPath(request.method, pathname) && !toolWorkspaceId)
    throw new ApiError(403, "wiki_agent_endpoint_denied", "This agent credential is limited to wiki page tools.");
  const sessionId = request.headers.get("x-legalwork-wiki-agent-session");
  if (!sessionId || sessionId.length > 200) throw new ApiError(403, "wiki_agent_session_unknown", "Run this task through an authenticated LegalWork session before accessing wikis.");
  const claimed = request.headers.get("x-legalwork-wiki-agent-directory");
  let decoded: string | null = null;
  try { decoded = claimed ? decodeURIComponent(claimed) : null; } catch { /* Invalid encoded claims fail closed. */ }
  const directory = decoded ? await realpath(decoded).catch(() => null) : null;
  if (!directory) throw new ApiError(403, "wiki_agent_directory_mismatch", "The wiki request does not match this session's working directory.");
  const origin = access.sessions.get(sessionId) ?? await inheritedOrigin(config, access, sessionId, directory, request.signal);
  if (!origin) throw new ApiError(403, "wiki_agent_session_unknown", "Run this task through an authenticated LegalWork session before accessing wikis.");
  if (directory !== origin.directory)
    throw new ApiError(403, "wiki_agent_directory_mismatch", "The wiki request does not match this session's working directory.");
  if (pathname.startsWith("/assistant/")) {
    const source = z.object({ sourceSessionId: z.string() }).safeParse(await request.clone().json());
    if (!source.success || source.data.sourceSessionId !== sessionId)
      throw new ApiError(403, "wiki_agent_session_mismatch", "Use this chat's own delegation context.");
  }
  if (toolWorkspaceId) {
    const recovery = pathname.match(/\/sessions\/([^/]+)\/review-recovery$/);
    if (recovery && decodeURIComponent(recovery[1]) !== sessionId)
      throw new ApiError(403, "wiki_agent_session_mismatch", "Use recovery only for this chat.");
    const candidates = await Promise.all(config.workspaces.map(async item => ({
      id: item.id, root: await realpath(item.directory || item.path).catch(() => null),
    })));
    const own = candidates.filter(item => {
      if (!item.root) return false;
      const child = relative(item.root, directory);
      return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    }).sort((a, b) => (b.root?.length ?? 0) - (a.root?.length ?? 0))[0];
    if (own?.id !== toolWorkspaceId)
      throw new ApiError(403, "wiki_agent_workspace_denied", "Use storage and execution tools only in this session's own workspace.");
    if (pathname.includes("/sandbox/")) {
      const claimedSession = request.method === "GET" ? decodeURIComponent(pathname.split("/").at(-1)!)
        : z.object({ sessionID: z.string() }).parse(await request.clone().json()).sessionID;
      if (claimedSession !== sessionId)
        throw new ApiError(403, "wiki_agent_session_mismatch", "Use this session's execution settings and approvals.");
    }
  }
  return { directory, sessionId, originSessionId: origin.sessionId, generation: origin.generation, scheduledProjects: origin.scheduledProjects, actor: { type: "remote", clientId: `wiki-agent:${sessionId}`, scope: origin.scope,
    tokenHash: createHash("sha256").update(access.token).digest("hex") } };
}
