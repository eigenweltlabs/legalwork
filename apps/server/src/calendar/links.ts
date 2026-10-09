import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
import { safeRemotePath } from "../project-file-sync.js";
import type { WorkspaceInfo } from "../types.js";

export async function validateCalendarLinks(workspace: WorkspaceInfo, input: { attachmentPaths?: string[]; sessionIds?: string[] }, previous: { attachmentPaths: string[]; sessionIds: string[] } | undefined, getSession: (workspace: WorkspaceInfo, id: string) => Promise<{ directory: string } | null>) {
  for (const path of input.attachmentPaths ?? []) {
    if (previous?.attachmentPaths.includes(path)) continue;
    if (!safeRemotePath(path)) throw new ApiError(400, "calendar_attachment", "Choose a visible project file.");
    const root = await realpath(workspace.path);
    const target = await realpath(resolve(root, path)).catch(() => null);
    if (!target?.startsWith(root + sep) || !(await stat(target)).isFile()) throw new ApiError(400, "calendar_attachment", "The attachment must be a file inside this project.");
  }
  for (const id of input.sessionIds ?? []) {
    if (previous?.sessionIds.includes(id)) continue;
    const session = await getSession(workspace, id);
    if (!session || resolve(session.directory) !== resolve(workspace.path)) throw new ApiError(400, "calendar_session", "Link a session from this project.");
  }
}
