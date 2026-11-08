import { resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import type { WikiRegistration } from "@legalwork/types/wiki";

export const ownsWikis = (actor: Actor | undefined) => actor?.type === "host" || actor?.scope === "owner";

/** Wiki visibility also applies through the existing workspace/file/proxy APIs. */
export function assertWikiWorkspaceAccess(actor: Actor | undefined, wiki: WikiRegistration | undefined) {
  if (wiki && !wiki.sync && !ownsWikis(actor)) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
}

export function wikiForDirectory<T extends Pick<WikiRegistration, "root" | "workspaceId" | "id">>(wikis: readonly T[], directory: string, workspaces: readonly WorkspaceInfo[] = []) {
  const path = resolve(directory);
  return wikis.flatMap(wiki => [wiki.root, ...workspaces.filter(workspace => workspace.id === wiki.workspaceId).map(workspace => workspace.directory || workspace.path)]
    .map(root => ({ wiki, root: resolve(root) })))
    .filter(({ root }) => path === root || path.startsWith(root + sep)).sort((a, b) => b.root.length - a.root.length)[0]?.wiki;
}

/** Scope is derived from the authenticated engine session, never Markdown. */
export async function wikiAgentCanAccess(config: ServerConfig, wikis: WikiRegistration[], wiki: WikiRegistration, directory: string) {
  if (wikiForDirectory(wikis, directory, config.workspaces)?.id === wiki.id) return true;
  if (!wiki.allowInProjects) return false;
  const wikiWorkspaces = new Set(wikis.map((item) => item.workspaceId));
  const matching: Array<{ id: string; root: string }> = [];
  for (const project of config.workspaces) {
    if (wikiWorkspaces.has(project.id)) continue;
    const root = await realpath(project.directory || project.path).catch(() => null);
    if (root && (directory === root || directory.startsWith(root + sep))) {
      matching.push({ id: project.id, root });
    }
  }
  const project = matching.sort((a, b) => b.root.length - a.root.length)[0];
  return Boolean(project && (wiki.projectWorkspaceIds == null || wiki.projectWorkspaceIds.includes(project.id)));
}
