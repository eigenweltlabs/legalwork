import { z } from "zod";
import type { Agent, PermissionConfig } from "@opencode-ai/sdk/v2";

export const PROJECT_TASK_AGENT = "legalwork-scheduled-project";
export const ALL_PROJECTS_TASK_AGENT = "legalwork-scheduled-all";

/** Background reviews read data directly and must not take over the user's UI. */
export function allProjectTaskPermissions(input: unknown = {}): PermissionConfig {
  const global = permissionSchema.parse(input);
  const permissions: Exclude<PermissionConfig, string> = typeof global === "string" ? { "*": global } : { ...global };
  for (const tool of ["legalwork_ui_snapshot", "legalwork_ui_list_actions", "legalwork_ui_execute_action"]) {
    delete permissions[tool];
    permissions[tool] = "deny";
  }
  return permissions;
}

// These tools resolve the project from the engine's trusted execution context.
// No shell, delegation, browser, global task search, or unrestricted connectors.
export const PROJECT_TASK_TOOLS = new Set([
  "legalwork_project_list", "legalwork_project_read", "legalwork_project_get_details",
  "legalwork_project_get_instructions", "legalwork_project_create_note",
  "legalwork_calendar_list", "legalwork_calendar_get", "legalwork_review_files",
  "legalwork_jev_corpus_question", "legalwork_review_list", "legalwork_review_get", "legalwork_review_results",
  "legalwork_schedule_projects", "legalwork_schedule_project_list", "legalwork_schedule_project_read",
  "todowrite", "question",
]);

const actionSchema = z.enum(["allow", "ask", "deny"]);
const permissionSchema = z.union([actionSchema, z.record(z.string(), z.union([actionSchema, z.record(z.string(), actionSchema)]))]);

function matches(pattern: string, name: string) {
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);
}

/** Preserve the user's existing denials and approval rules for allowed tools. */
export function projectTaskPermissions(input: unknown = {}): PermissionConfig {
  const global = permissionSchema.parse(input);
  const permissions: Exclude<PermissionConfig, string> = { "*": "deny" };
  for (const tool of PROJECT_TASK_TOOLS) {
    if (typeof global === "string") { permissions[tool] = global; continue; }
    let action: Exclude<PermissionConfig, string>[string] = "allow";
    for (const [name, value] of Object.entries(global)) if (matches(name, tool)) action = value;
    permissions[tool] = action;
  }
  return permissions;
}

/** Do not silently run unrestricted when an external or stale engine lacks our agent. */
export function hasProjectTaskBoundary(agent: Pick<Agent, "name" | "permission"> | undefined) {
  if (agent?.name !== PROJECT_TASK_AGENT) return false;
  let boundary = -1;
  agent.permission.forEach((rule, index) => { if (rule.permission === "*" && rule.pattern === "*" && rule.action === "deny") boundary = index; });
  // The engine appends access to its tool-output folder. No native file/shell
  // tool is permitted here, so this supporting permission cannot expose data.
  return boundary >= 0 && agent.permission.slice(boundary + 1).every(rule => rule.action === "deny" || rule.permission === "external_directory" || PROJECT_TASK_TOOLS.has(rule.permission));
}
