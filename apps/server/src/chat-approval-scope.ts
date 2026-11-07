import { ApiError } from "./errors.js";
import { sameProjectDirectory } from "./workspace-path-match.js";

type ChatSession = { id: string; parentID?: string; location: { directory: string } };

/** Resolve authority from engine-owned ancestry, never a caller-supplied parent. */
export async function chatApprovalLineage<T extends ChatSession>(sessionID: string, get: (id: string) => Promise<T>): Promise<T[]> {
  const sessions: T[] = [];
  let id: string | undefined = sessionID;
  while (id) {
    if (sessions.some(session => session.id === id) || sessions.length >= 64)
      throw new ApiError(403, "chat_approval_lineage", "This chat's ancestry could not be verified.");
    const session = await get(id);
    if (session.id !== id || sessions.length && !await sameProjectDirectory(sessions[0].location.directory, session.location.directory))
      throw new ApiError(403, "chat_approval_lineage", "This chat's parent belongs to another project.");
    sessions.push(session);
    id = session.parentID;
  }
  return sessions;
}
