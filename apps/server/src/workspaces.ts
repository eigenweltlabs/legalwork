import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceInfo } from "./types.js";

function workspaceIdForKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `ws_${hash.slice(0, 12)}`;
}

export function workspaceIdForPath(path: string): string {
  return workspaceIdForKey(path);
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces.filter(workspace => workspace.workspaceType !== "remote").map((workspace) => {
    const rawPath = workspace.path?.trim() ?? "";
    const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
    const id = workspace.id?.trim() || workspaceIdForPath(resolvedPath);
    const name = workspace.name?.trim()
      || workspace.displayName?.trim()
      || basename(resolvedPath || workspace.directory?.trim() || workspace.baseUrl?.trim() || "Workspace");
    return {
      id,
      name,
      path: resolvedPath,
      preset: workspace.preset?.trim() || "starter",
      workspaceType: "local",
      baseUrl: workspace.baseUrl,
      directory: workspace.directory,
      displayName: workspace.displayName,
      sandboxBackend: workspace.sandboxBackend,
      sandboxRunId: workspace.sandboxRunId,
      sandboxContainerName: workspace.sandboxContainerName,
      opencodeUsername: workspace.opencodeUsername,
      opencodePassword: workspace.opencodePassword,
    };
  });
}
