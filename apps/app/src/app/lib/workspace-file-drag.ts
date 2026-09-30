export const WORKSPACE_FILE_DRAG_TYPE = "application/x-legalwork-workspace-file";

export type WorkspaceFileDragItem = {
  workspaceId: string;
  path: string;
  name: string;
};

export function hasWorkspaceFileDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_TYPE);
}

export function writeWorkspaceFileDrag(dataTransfer: DataTransfer, item: WorkspaceFileDragItem): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify(item));
  dataTransfer.setData("text/plain", item.name);
}

export function readWorkspaceFileDrag(dataTransfer: DataTransfer): WorkspaceFileDragItem | null {
  const raw = dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object") return null;
    if (!("workspaceId" in item) || typeof item.workspaceId !== "string" || !item.workspaceId) return null;
    if (!("path" in item) || typeof item.path !== "string" || !item.path) return null;
    if (!("name" in item) || typeof item.name !== "string" || !item.name) return null;
    return { workspaceId: item.workspaceId, path: item.path, name: item.name };
  } catch {
    return null;
  }
}
