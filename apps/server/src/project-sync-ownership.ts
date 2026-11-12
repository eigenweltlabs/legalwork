import { isAbsolute, relative, sep } from "node:path";
import { canonicalFilePath } from "./file-write-lock.js";
import { defaultProjectRoot, readProjectDetails } from "./project-store.js";
import { projectSyncStore } from "./project-sync-store.js";
import { localProjectReferenceRoots, workspaceContentPath } from "./project-storage.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/** Backfill only a sync-created copy in a managed tree with matching firm ID.
 * Migration association by itself never grants content deletion. */
export async function retainDownloadedCopyOwnership(config: ServerConfig, workspace: WorkspaceInfo) {
  const store = await projectSyncStore(config), link = store.linkByWorkspace(workspace.id);
  if (!link || link.origin !== "remote") return null;
  const existing = store.ownedCopy(workspace.id);
  if (existing) return existing;
  const content = await canonicalFilePath(workspaceContentPath(workspace));
  if (workspace.previousPath) await localProjectReferenceRoots(workspace);
  const roots = [...new Set([defaultProjectRoot(), ...(config.projectsDirectory ? [config.projectsDirectory] : [])])];
  const managed = await Promise.all(roots.map(root => canonicalFilePath(root)));
  if (!managed.some(root => {
    const suffix = relative(root, content);
    return suffix && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  })) return null;
  if ((await readProjectDetails(workspace.path)).syncProjectId !== link.projectId) return null;
  store.ownCopy(workspace.id, link.projectId, content);
  return store.ownedCopy(workspace.id);
}
