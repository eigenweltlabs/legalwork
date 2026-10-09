const SESSION_DRAG_TYPE = "application/x-legalwork-session-id";
const SESSIONS_DRAG_TYPE = "application/x-legalwork-session-ids";
const workspaceDragType = (workspaceId: string) => `application/x-legalwork-workspace-${workspaceId.toLowerCase()}`;

export function startSessionDrag(data: Pick<DataTransfer, "setData" | "effectAllowed">, workspaceId: string, sessionId: string) {
  data.setData(SESSION_DRAG_TYPE, sessionId);
  data.setData(workspaceDragType(workspaceId), workspaceId);
  data.effectAllowed = "copyMove";
}

export function acceptsSessionDrag(data: Pick<DataTransfer, "types">, workspaceId: string) {
  return data.types.includes(SESSION_DRAG_TYPE) && data.types.includes(workspaceDragType(workspaceId));
}

export function readSessionDrag(data: Pick<DataTransfer, "getData" | "types">, workspaceId: string) {
  return acceptsSessionDrag(data, workspaceId) && data.getData(workspaceDragType(workspaceId)) === workspaceId
    ? data.getData(SESSION_DRAG_TYPE) : "";
}

export function startSessionsDrag(data: Pick<DataTransfer, "setData" | "clearData" | "effectAllowed">, workspaceId: string, ids: string[]) {
  if (ids.length === 1) return startSessionDrag(data, workspaceId, ids[0]);
  data.clearData();
  data.setData(SESSIONS_DRAG_TYPE, JSON.stringify(ids));
  data.setData(workspaceDragType(workspaceId), workspaceId);
  data.effectAllowed = "copyMove";
}
export function acceptsSessionsDrag(data: Pick<DataTransfer, "types">, workspaceId: string) {
  return acceptsSessionDrag(data, workspaceId) || (data.types.includes(SESSIONS_DRAG_TYPE) && data.types.includes(workspaceDragType(workspaceId)));
}
export function readSessionsDrag(data: Pick<DataTransfer, "getData" | "types">, workspaceId: string): string[] {
  if (!acceptsSessionsDrag(data, workspaceId) || data.getData(workspaceDragType(workspaceId)) !== workspaceId) return [];
  const batch = data.getData(SESSIONS_DRAG_TYPE);
  if (!batch) { const id = readSessionDrag(data, workspaceId); return id ? [id] : []; }
  try {
    const ids: unknown = JSON.parse(batch);
    return Array.isArray(ids) && ids.every((id): id is string => typeof id === "string" && id.length > 0) ? [...new Set(ids)] : [];
  } catch { return []; }
}

/** Move one root while preserving every session hidden by a filter or collapsed group. */
export function moveSessionInOrder(ids: string[], sessionId: string, targetId: string, edge: "before" | "after") {
  if (sessionId === targetId || !ids.includes(sessionId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== sessionId);
  next.splice(next.indexOf(targetId) + (edge === "after" ? 1 : 0), 0, sessionId);
  return next;
}
