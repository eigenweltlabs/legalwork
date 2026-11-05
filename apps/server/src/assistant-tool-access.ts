import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { MainAssistant } from "./main-assistant.js";
import { isMainAssistant } from "./main-assistant.js";
import type { ServerConfig } from "./types.js";

const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};

/** Tool guard also runs in native research children, whose working directory is the Assistant. */
export async function assertAssistantToolAccess(config: ServerConfig, assistant: MainAssistant, directory: string, tool: string, args: Record<string, unknown>) {
  const workspace = config.workspaces.find(isMainAssistant);
  if (!workspace || resolve(directory) !== resolve(workspace.path)) return;
  for (const key of ["projectId", "workspaceId", "targetProjectId", "targetWorkspaceId"]) {
    if (typeof args[key] === "string") assistant.assertProjectAccess(args[key]);
  }
  if (assistant.settings().projectAccess.mode === "all") return;
  const denied = () => new ApiError(403, "assistant_project_access_denied", "This action cannot respect the Assistant's project access rules. Use the scoped Assistant project tools or delegate into an allowed project. Do not work around this refusal.");
  // Shell/code execution and generic task APIs can escape a project scope or return tasks from other projects.
  // The scoped Assistant APIs remain available. Workers in permitted projects keep normal project tools.
  if (["bash", "legalwork_shell", "apply_patch", "patch", "multiedit"].includes(tool) || tool.startsWith("legalwork_task_")
    || ["legalwork_sandbox_execute", "legalwork_sandbox_web"].includes(tool)) throw denied();
  if (!["read", "write", "edit", "glob", "grep", "list"].includes(tool)) return;
  const raw = args.filePath ?? args.path ?? directory;
  if (typeof raw !== "string") throw denied();
  const path = resolve(directory, raw);
  // Resolve existing ancestors too: a symlink into a forbidden project cannot bypass the rule,
  // and a new file is checked against the real parent directory.
  const canonical = async (candidate: string): Promise<string> => {
    try { return await realpath(candidate); }
    catch {
      const parent = resolve(candidate, "..");
      if (parent === candidate) throw denied();
      return resolve(await canonical(parent), relative(parent, candidate));
    }
  };
  const actual = await canonical(path);
  const projects = await Promise.all(config.workspaces.map(async project => ({ project, root: await canonical(project.path) })));
  // A forbidden nested project wins over its accessible parent.
  const matching = projects.filter(item => inside(item.root, actual)).sort((a, b) => b.root.length - a.root.length);
  if (matching.length) { assistant.assertProjectAccess(matching[0]!.project.id); return; }
  // Selected global packages may be read by research workers under restricted project access.
  // This grants package reads only, never execution or writes to the shared library.
  if (tool === "read") {
    const resources = assistant.resourceMetadata().filter(resource => !resource.projectId || config.workspaces.some(project => project.id === resource.projectId) && assistant.canAccessProject(resource.projectId));
    for (const resource of resources) {
      let files: Array<{ path: string; directory: boolean }>;
      if (resource.kind === "plugin") {
        let value: unknown;
        try { value = JSON.parse(resource.reference); } catch { continue; }
        const parsed = z.object({ files: z.array(z.object({ path: z.string(), directory: z.boolean() })) }).safeParse(value);
        if (!parsed.success) continue;
        files = parsed.data.files;
      } else files = [{ path: dirname(resource.reference), directory: true }];
      for (const file of files) {
        if (!isAbsolute(file.path)) continue;
        const root = await canonical(file.path);
        if (file.directory ? inside(root, actual) : root === actual) return;
      }
    }
  }
  throw denied();
}
