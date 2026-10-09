import { isProjectView, type ProjectView } from "../panel/project-view";

const VIEW_DRAG_TYPE = "application/x-legalwork-project-view";
const workspaceDragType = (workspaceId: string) => `application/x-legalwork-project-view-${workspaceId.toLowerCase()}`;

export function startProjectViewDrag(data: Pick<DataTransfer, "setData" | "effectAllowed">, workspaceId: string, view: ProjectView) {
  data.setData(VIEW_DRAG_TYPE, view);
  data.setData(workspaceDragType(workspaceId), workspaceId);
  data.effectAllowed = "copyMove";
}

export function acceptsProjectViewDrag(data: Pick<DataTransfer, "types">, workspaceId: string) {
  return data.types.includes(VIEW_DRAG_TYPE) && data.types.includes(workspaceDragType(workspaceId));
}

export function readProjectViewDrag(data: Pick<DataTransfer, "types" | "getData">, workspaceId: string): ProjectView | null {
  if (!acceptsProjectViewDrag(data, workspaceId) || data.getData(workspaceDragType(workspaceId)) !== workspaceId) return null;
  const view = data.getData(VIEW_DRAG_TYPE);
  return isProjectView(view) ? view : null;
}
