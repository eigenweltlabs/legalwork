import { isAbsolute, resolve } from "node:path";
import { canonicalFolderPath } from "./workspace-safety.js";
import { within } from "../agent-sandbox/files.js";
import { ApiError } from "../errors.js";

export const wikiNativeFileTools = new Set(["read", "edit", "write", "apply_patch", "patch", "multiedit", "glob", "grep", "list", "bash", "shell", "legalwork_task_attach", "benchmark_create_task", "legalwork_skill_create"]);
/** Native host tools must never turn a project's read-only chat grant into write access. */
export async function assertWikiNativeFileAccess(root: string, tool: string, args: Record<string, unknown>, directory = root): Promise<void> {
  if (!wikiNativeFileTools.has(tool)) return;
  if (tool === "bash" || tool === "shell") throw new ApiError(403, "wiki_sandbox_required", "Use legalwork_shell with protected execution enabled in a wiki chat. Native host commands cannot enforce project access.");
  const deny = () => new ApiError(403, "wiki_native_project_access", "Use wiki_project_files/wiki_project_read for approved project files, or protected execution. Native file tools in a wiki chat can only access its own wiki.");
  if (tool === "legalwork_task_attach" || tool === "benchmark_create_task" || tool === "legalwork_skill_create") {
    const paths = tool === "legalwork_task_attach" ? args.paths : tool === "benchmark_create_task" ? args.documentPaths : args.resourcePaths;
    if (paths === undefined && tool !== "legalwork_task_attach") return;
    if (!Array.isArray(paths)) throw deny();
    for (const path of paths) {
      if (typeof path !== "string") throw deny();
      await assertWikiNativeFileAccess(root, "read", { filePath: path }, directory);
    }
    return;
  }
  // Patches/multi-edits can name several paths and move files. Route these through
  // the wiki's revision-checked tools or the protected command environment.
  if (["apply_patch", "patch", "multiedit"].includes(tool)) throw deny();
  const raw = args.filePath ?? args.path;
  if (raw !== undefined && typeof raw !== "string") throw deny();
  if (raw === undefined && ["read", "edit", "write"].includes(tool)) throw deny();
  if (typeof raw === "string" && raw.startsWith("~")) throw deny();
  if (tool === "glob" && typeof args.pattern === "string" && (isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes(".."))) throw deny();
  // Match the tool's working directory, which can be a subfolder of the wiki.
  const target = await canonicalFolderPath(resolve(directory, typeof raw === "string" ? raw : "."));
  if (!within(await canonicalFolderPath(root), target)) throw deny();
  if (["write", "edit"].includes(tool) && /\.view(?:\.conflict-[a-f0-9]{12})?\.json$/i.test(target))
    throw new ApiError(403, "human_save_required", "Return a dashboard preview with view_create/view_update. The user chooses Save and its destination.");
}
