import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import type { Actor, ServerConfig } from "./types.js";
import { authenticateWikiAgentRequest, currentWikiAgentSession, grantWikiAgentSession, observeWikiAgentSessions, SessionAuthoritySchema, type SessionAuthority } from "./wiki/agent-access.js";
import { WikiStore } from "./wiki/store.js";
import { assertWikiWorkspaceAccess, wikiForDirectory } from "./wiki/access.js";

const recordSchema = z.object({ directory: z.string(), authority: SessionAuthoritySchema, revoked: z.boolean() });
const rank = { viewer: 0, collaborator: 1, owner: 2 };

/** Background work cannot broaden either its saved mandate or a later takeover. */
export function intersectSessionAuthority(left: SessionAuthority, right: SessionAuthority): SessionAuthority {
  const projects = left.scheduledProjects, other = right.scheduledProjects;
  return { scope: rank[left.scope] < rank[right.scope] ? left.scope : right.scope, sourceSessionId: left.sourceSessionId,
    scheduledProjects: Array.isArray(projects) ? Array.isArray(other) ? projects.filter(id => other.includes(id)) : projects
      : Array.isArray(other) ? other : projects ?? other };
}

export async function assistantRequestAuthority(config: ServerConfig, request: Request, actor?: Actor): Promise<SessionAuthority> {
  const agent = await authenticateWikiAgentRequest(config, request);
  return { scope: agent?.actor.scope ?? (actor?.type === "host" ? "owner" : actor?.scope ?? "viewer"), scheduledProjects: agent?.scheduledProjects, sourceSessionId: agent?.originSessionId };
}

export function assertAssistantDispatchAuthority(authority: SessionAuthority, workspaceId: string) {
  if (authority.scope === "viewer" || Array.isArray(authority.scheduledProjects) && !authority.scheduledProjects.includes(workspaceId))
    throw new ApiError(403, "assistant_dispatch_forbidden", "This task is not authorized to run in the selected project.");
}

/** Only sessions explicitly authorized for internal dispatch are persisted. Normal
 * user prompts still own initialization; observing them preserves downgrades and
 * deletion across a restart without making every engine session authenticated. */
export class AssistantSessionAccess {
  private constructor(private db: SqliteHandle, private config: ServerConfig) {}
  static async open(path: string, config: ServerConfig) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS assistant_session_access (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    const access = new AssistantSessionAccess(db, config);
    observeWikiAgentSessions(config, (sessionId, origin) => {
      const previous = access.read(sessionId);
      if (!previous) return;
      access.save(sessionId, origin ? { directory: origin.directory, authority: { scope: origin.scope, scheduledProjects: origin.scheduledProjects }, revoked: false }
        : { ...previous, revoked: true });
    });
    return access;
  }
  private read(sessionId: string) {
    const row = this.db.get("SELECT data FROM assistant_session_access WHERE session_id = ?", [sessionId]);
    return row ? recordSchema.parse(JSON.parse(String(row.data))) : null;
  }
  private save(sessionId: string, record: z.infer<typeof recordSchema>) {
    this.db.run("INSERT INTO assistant_session_access VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data", [sessionId, JSON.stringify(record)]);
  }
  async checkDirectory(directory: string, authority: SessionAuthority) {
    assertWikiWorkspaceAccess({ type: "remote", scope: authority.scope }, wikiForDirectory(await new WikiStore(this.config).list(), await realpath(directory)));
  }
  /** Scoped tools keep the actual verified ancestor, never flatten inherited access. */
  async captureSource(sessionId: string, directory: string, authority: SessionAuthority): Promise<SessionAuthority> {
    if (!authority.sourceSessionId) {
      await this.authorize(sessionId, directory, authority);
      return { ...authority, sourceSessionId: sessionId };
    }
    const current = currentWikiAgentSession(this.config, authority.sourceSessionId);
    if (!current) throw new ApiError(403, "assistant_session_reauthorization", "The source chat is no longer authenticated.");
    this.save(current.sessionId, { directory: current.directory, authority: { scope: current.scope, scheduledProjects: current.scheduledProjects }, revoked: false });
    return intersectSessionAuthority(authority, current);
  }
  /** Call only after the route has authenticated the caller and verified the engine session. */
  async authorize(sessionId: string, directory: string, authority: SessionAuthority, beforeCommit?: () => void) {
    const canonical = await realpath(directory);
    await this.checkDirectory(canonical, authority);
    const source = authority.sourceSessionId ? this.read(authority.sourceSessionId) : null;
    const sourceCurrent = authority.sourceSessionId ? currentWikiAgentSession(this.config, authority.sourceSessionId) : undefined;
    if (authority.sourceSessionId && (!source || source.revoked)) throw new ApiError(403, "assistant_session_reauthorization", "The source chat is no longer authorized.");
    const effective = source ? intersectSessionAuthority(authority, sourceCurrent ?? source.authority) : authority;
    if (effective.scope === "viewer") throw new ApiError(403, "assistant_dispatch_forbidden", "The source chat is read-only.");
    await this.checkDirectory(canonical, effective);
    await grantWikiAgentSession(this.config, { sessionId, directory: canonical, ...effective }, () => {
      beforeCommit?.();
      if (authority.sourceSessionId) this.unchanged(authority.sourceSessionId, source, sourceCurrent)();
    });
    const current = currentWikiAgentSession(this.config, sessionId);
    if (!current) throw new ApiError(403, "assistant_session_reauthorization", "This chat's permissions changed before dispatch.");
    this.save(sessionId, { directory: current.directory, authority: { scope: current.scope, scheduledProjects: current.scheduledProjects }, revoked: false });
  }
  /** A durable job supplies its original ceiling, never a replacement permission. */
  async prepare(sessionId: string, directory: string, ceiling: SessionAuthority | undefined) {
    if (!ceiling) throw new ApiError(403, "assistant_session_reauthorization", "Continue this task from an authenticated chat to restore its permissions.");
    const canonical = await realpath(directory);
    const saved = this.read(sessionId);
    if (!saved || saved.revoked) throw new ApiError(403, "assistant_session_reauthorization", "Continue this task from an authenticated chat to restore its permissions.");
    if (saved.directory !== canonical) throw new ApiError(403, "wiki_agent_directory_mismatch", "This chat belongs to another working directory.");
    const current = currentWikiAgentSession(this.config, sessionId);
    const source = ceiling.sourceSessionId ? this.read(ceiling.sourceSessionId) : null;
    const sourceCurrent = ceiling.sourceSessionId ? currentWikiAgentSession(this.config, ceiling.sourceSessionId) : undefined;
    if (ceiling.sourceSessionId && (!source || source.revoked)) throw new ApiError(403, "assistant_session_reauthorization", "The source chat is no longer authorized. Continue from an authenticated chat.");
    const targetAuthority = intersectSessionAuthority(ceiling, current ?? saved.authority);
    const authority = source ? intersectSessionAuthority(targetAuthority, sourceCurrent ?? source.authority) : targetAuthority;
    if (authority.scope === "viewer") throw new ApiError(403, "assistant_dispatch_forbidden", "This chat is read-only. Continue it from an authorized account.");
    await this.checkDirectory(directory, authority);
    await grantWikiAgentSession(this.config, { sessionId, directory, ...authority }, () => {
      this.unchanged(sessionId, saved, current)();
      if (ceiling.sourceSessionId) this.unchanged(ceiling.sourceSessionId, source, sourceCurrent)();
    });
    return authority;
  }
  /** A return may arrive in a new daily chat. Preserve any newer destination restrictions. */
  async prepareReturn(sessionId: string, directory: string, authority: SessionAuthority) {
    const canonical = await realpath(directory);
    const saved = this.read(sessionId), current = currentWikiAgentSession(this.config, sessionId);
    if (saved?.revoked) throw new ApiError(403, "assistant_session_reauthorization", "The result destination is no longer authorized.");
    if (saved && saved.directory !== canonical) throw new ApiError(403, "wiki_agent_directory_mismatch", "The result destination belongs to another working directory.");
    const effective = intersectSessionAuthority(authority, current ?? saved?.authority ?? authority);
    if (effective.scope === "viewer") throw new ApiError(403, "assistant_dispatch_forbidden", "The result destination is read-only.");
    await this.authorize(sessionId, directory, effective, this.unchanged(sessionId, saved, current));
  }
  private unchanged(sessionId: string, saved: ReturnType<AssistantSessionAccess["read"]>, current: ReturnType<typeof currentWikiAgentSession>) {
    return () => {
      if (JSON.stringify(this.read(sessionId)) !== JSON.stringify(saved) || currentWikiAgentSession(this.config, sessionId) !== current)
        throw new ApiError(409, "assistant_session_authority_changed", "This chat's permissions changed before dispatch. Retry from the current authorized context.");
    };
  }
}
