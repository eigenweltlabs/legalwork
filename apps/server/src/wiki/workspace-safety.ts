import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { WikiRegistration } from "@legalwork/types/wiki";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";

/** Also canonicalize folders not yet created, including symlinks in existing parents. */
export async function canonicalFolderPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalFolderPath(parent), basename(absolute));
  }
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
function overlapError(): ApiError {
  return new ApiError(409, "wiki_workspace_overlap", "Choose separate wiki and project folders so project file access cannot bypass wiki permissions.");
}
export async function assertWikiFoldersIndependent(wikis: WikiRegistration[], workspaces: WorkspaceInfo[]): Promise<void> {
  if (wikis.length === 0) return;
  const wikiWorkspaceIds = new Set(wikis.map((wiki) => wiki.workspaceId));
  const projectRoots: string[] = [];
  for (const workspace of workspaces) {
    if (workspace.workspaceType !== "local" || !workspace.path || (workspace.preset === "wiki" && wikiWorkspaceIds.has(workspace.id))) continue;
    projectRoots.push(await canonicalFolderPath(workspace.path));
  }
  for (const wiki of wikis) {
    const root = await canonicalFolderPath(wiki.root);
    if (projectRoots.some((project) => overlaps(root, project))) throw overlapError();
  }
}
export async function assertProjectFolderIndependent(path: string, wikis: WikiRegistration[]): Promise<void> {
  const root = await canonicalFolderPath(path);
  for (const wiki of wikis) if (overlaps(root, await canonicalFolderPath(wiki.root))) throw overlapError();
}
