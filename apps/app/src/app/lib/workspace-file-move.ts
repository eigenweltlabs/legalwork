export const WORKSPACE_MOVE_TYPE = "application/x-legalwork-workspace-file-move";
const scopeType = (baseUrl: string, workspaceId: string) => `application/x-legalwork-file-move-${encodeURIComponent(JSON.stringify([baseUrl, workspaceId])).toLowerCase()}`;
export type WorkspaceFileMove = { baseUrl: string; workspaceId: string; paths: string[] };
const validPath = (path: unknown): path is string => typeof path === "string" && Boolean(path) && !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every(part => part && part !== "." && part !== "..");

export function writeWorkspaceFileMove(data: Pick<DataTransfer, "setData" | "effectAllowed">, payload: WorkspaceFileMove) {
  data.effectAllowed = "copyMove";
  data.setData(WORKSPACE_MOVE_TYPE, JSON.stringify(payload));
  data.setData(scopeType(payload.baseUrl, payload.workspaceId), "");
}
export function hasWorkspaceFileMove(data: Pick<DataTransfer, "types">, baseUrl: string, workspaceId: string) {
  return data.types.includes(WORKSPACE_MOVE_TYPE) && data.types.includes(scopeType(baseUrl, workspaceId));
}
export function readWorkspaceFileMove(data: Pick<DataTransfer, "getData">, baseUrl: string, workspaceId: string): string[] {
  try {
    const value: unknown = JSON.parse(data.getData(WORKSPACE_MOVE_TYPE));
    if (!value || typeof value !== "object" || !("baseUrl" in value) || value.baseUrl !== baseUrl || !("workspaceId" in value) || value.workspaceId !== workspaceId || !("paths" in value) || !Array.isArray(value.paths) || !value.paths.every(validPath)) return [];
    return [...new Set(value.paths)];
  } catch { return []; }
}
export function workspaceFileMoves(paths: string[], folder: string) {
  if ((folder && !validPath(folder)) || !paths.every(validPath)) throw new Error("Invalid file destination");
  return [...new Set(paths)].flatMap<{ type: "rename"; from: string; to: string; overwrite: false }>(from => {
    const name = from.split("/").at(-1)!;
    const to = folder ? `${folder}/${name}` : name;
    return from === to ? [] : [{ type: "rename", from, to, overwrite: false }];
  });
}
