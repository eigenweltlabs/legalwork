import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { SandboxMount } from "../agent-sandbox/files.js";
import { canonicalFolderPath } from "./workspace-safety.js";
import { wikiForDirectory } from "./access.js";
import type { WikiRegistration } from "@legalwork/types/wiki";
import type { WorkspaceInfo } from "../types.js";

export const wikiFilePolicySchema = z.object({
  directory: z.string().min(1),
  ownRoot: z.string().min(1).nullable(),
  ownEngineRoot: z.string().min(1).nullable().optional(),
  ownWritable: z.boolean(),
  protectedRoots: z.array(z.string().min(1)),
  runtimeRoots: z.array(z.string().min(1)),
}).strict();
export type WikiFilePolicy = z.infer<typeof wikiFilePolicySchema>;

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
/** Includes every registered wiki, even private or project-disabled wikis. */
export async function buildWikiFilePolicy(wikis: ReadonlyArray<{ root: string }>, directory: string, runtimeRoots: string[] = [], workspaces: readonly WorkspaceInfo[] = []): Promise<WikiFilePolicy> {
  const canonicalDirectory = await realpath(directory);
  const registered = wikis.filter((wiki): wiki is Pick<WikiRegistration, "root" | "workspaceId" | "id"> => "workspaceId" in wiki && typeof wiki.workspaceId === "string" && "id" in wiki && typeof wiki.id === "string");
  const own = wikiForDirectory(registered, canonicalDirectory, workspaces);
  const roots = [...new Set(await Promise.all(wikis.flatMap(wiki => [wiki.root, ...("workspaceId" in wiki ? workspaces.filter(workspace => workspace.id === wiki.workspaceId).map(workspace => workspace.path) : [])]).map(canonicalFolderPath)))];
  const ownRoot = own ? await canonicalFolderPath(own.root) : roots.filter(root => within(root, canonicalDirectory)).sort((a, b) => b.length - a.length)[0] ?? null;
  const ownWorkspace = own && workspaces.find(workspace => workspace.id === own.workspaceId);
  const ownEngineRoot = ownWorkspace ? await canonicalFolderPath(ownWorkspace.path) : ownRoot;
  const protectedRoots = roots.filter(root => root !== ownRoot && root !== ownEngineRoot);
  const engineConfigRoot = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  return { directory: canonicalDirectory, ownRoot, ownEngineRoot, ownWritable: true, protectedRoots,
    runtimeRoots: [...new Set(await Promise.all([...runtimeRoots, ...(protectedRoots.length ? [engineConfigRoot] : [])].map(canonicalFolderPath)))] };
}

export function wikiContentPath(policy: WikiFilePolicy, path: string): boolean {
  return [...policy.protectedRoots, ...(policy.ownRoot ? [policy.ownRoot] : []), ...(policy.ownEngineRoot ? [policy.ownEngineRoot] : [])].some(root => within(root, path));
}

/** Keep optional external wiki mounts read-only. Refuse broad writable mounts
 * instead of allowing a parent mount to bypass a protected wiki child. */
export async function wikiSafeSandboxMounts(policy: WikiFilePolicy, mounts: SandboxMount[]): Promise<SandboxMount[]> {
  const result: SandboxMount[] = [];
  for (const mount of mounts) {
    const source = await realpath(mount.source);
    if (!mount.writable) { result.push({ ...mount, source }); continue; }
    if (policy.protectedRoots.some(root => within(root, source))) {
      result.push({ ...mount, source, writable: false });
      continue;
    }
    if (policy.protectedRoots.some(root => within(source, root)))
      throw new ApiError(403, "wiki_sandbox_mount_denied", "An authorized folder contains an external wiki. Choose narrower folders for shell access and use approved wiki tools for wiki changes.");
    result.push({ ...mount, source });
  }
  return result;
}
