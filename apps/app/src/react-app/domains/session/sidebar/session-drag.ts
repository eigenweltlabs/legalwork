const SESSION_DRAG_TYPE = "application/x-legalwork-session-id";
const workspaceDragType = (workspaceId: string) => `application/x-legalwork-workspace-${workspaceId.toLowerCase()}`;

export function startSessionDrag(data: DataTransfer, workspaceId: string, sessionId: string) {
  data.setData(SESSION_DRAG_TYPE, sessionId);
  data.setData(workspaceDragType(workspaceId), workspaceId);
  data.effectAllowed = "move";
}

export function acceptsSessionDrag(data: Pick<DataTransfer, "types">, workspaceId: string) {
  return data.types.includes(SESSION_DRAG_TYPE) && data.types.includes(workspaceDragType(workspaceId));
}

export function readSessionDrag(data: DataTransfer, workspaceId: string) {
  return acceptsSessionDrag(data, workspaceId) && data.getData(workspaceDragType(workspaceId)) === workspaceId
    ? data.getData(SESSION_DRAG_TYPE) : "";
}

/** Move one root while preserving every session hidden by a filter or collapsed group. */
export function moveSessionInOrder(ids: string[], sessionId: string, targetId: string, edge: "before" | "after") {
  if (sessionId === targetId || !ids.includes(sessionId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== sessionId);
  next.splice(next.indexOf(targetId) + (edge === "after" ? 1 : 0), 0, sessionId);
  return next;
}
