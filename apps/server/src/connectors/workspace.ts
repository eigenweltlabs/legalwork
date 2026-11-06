import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";

export async function connectorWorkspace(config: ServerConfig, context: Record<string, unknown>) {
  if (typeof context.directory !== "string" || !context.directory.trim()) throw new ApiError(400, "connector_workspace_required", "Run this action from a project chat.");
  const directory = await realpath(resolve(context.directory));
  const candidates = [...config.workspaces].sort((a, b) => b.path.length - a.path.length);
  for (const workspace of candidates) {
    const root = await realpath(resolve(workspace.path));
    const child = relative(root, directory);
    if (child !== "" && (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))) continue;
    for (const allowed of config.authorizedRoots) {
      const relation = relative(await realpath(resolve(allowed)), root);
      if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) return { ...workspace, path: root };
    }
    throw new ApiError(403, "workspace_unauthorized", "This project folder is not authorized.");
  }
  throw new ApiError(404, "workspace_not_found", "No project matches this chat.");
}
