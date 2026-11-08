import { workspaceContentPath, workspaceFileRoot as relativeWorkspaceFileRoot } from "@legalwork/types/workspace";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export { workspaceContentPath };
export type WorkspaceRoots = { path: string; contentPath?: string | null; previousPath?: string | null; previousPaths?: readonly string[] };
const support = (path: string) => /^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(path);
const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

/** Application readers select a verified root for explicit absolute files too. */
export function workspaceFileRoot(workspace: WorkspaceRoots, file: string): string {
  return isAbsolute(file) ? resolveWorkspaceFile(workspace, file).root : relativeWorkspaceFileRoot(workspace, file);
}

/** Application document references retain their selected root. Native OpenCode
 * arguments are never passed through this resolver. */
export function resolveWorkspaceFile(workspace: WorkspaceRoots, file: string, options: { allowRoot?: boolean } = {}) {
  if (!file || file.includes("\0")) throw new ApiError(400, "invalid_path", "Choose a project file.");
  const engine = resolve(workspace.path), content = resolve(workspaceContentPath(workspace));
  let root: string, suffix: string;
  if (isAbsolute(file)) {
    const absolute = resolve(file);
    const roots = [...new Set([content, engine, ...(workspace.previousPath ? [resolve(workspace.previousPath)] : [])])].sort((a, b) => b.length - a.length);
    const matched = roots.find(candidate => inside(candidate, absolute));
    if (!matched) throw new ApiError(403, "file_access_denied", "This file is outside the project's document and support folders.");
    suffix = relative(matched, absolute);
    root = support(suffix) ? engine : matched;
  } else {
    root = resolve(workspaceFileRoot(workspace, file));
    suffix = relative(root, resolve(root, file));
  }
  const path = resolve(root, suffix);
  if (!suffix && !options.allowRoot || !inside(root, path)) throw new ApiError(400, "invalid_path", "Path must identify a file inside its project folder.");
  // An ordinary engine-owned file cannot be represented by a content-relative
  // name. Keep its absolute address for previews, downloads and editor saves.
  const reference = root === engine && engine !== content && !support(suffix) ? path : suffix.split(sep).join("/") || ".";
  return { path, root, relativePath: suffix.split(sep).join("/"), reference };
}
