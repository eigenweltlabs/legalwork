import type { AgentInfo } from "@opencode/client";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { permissionPatternMatches } from "../agent-sandbox/permissions.js";
type PermissionConfig = Array<NonNullable<(typeof Config.Info.Type)["permissions"]>[number]>;

export const PROJECT_TASK_AGENT = "legalwork-scheduled-project";
export const ALL_PROJECTS_TASK_AGENT = "legalwork-scheduled-all";

/** Background reviews read data directly and must not take over the user's UI. */
export function allProjectTaskPermissions(input: PermissionConfig = []): PermissionConfig {
  const permissions = Schema.decodeUnknownSync(Config.Info)({ permissions: input }).permissions ?? [];
  return [...permissions, ...["legalwork_ui_snapshot", "legalwork_ui_list_actions", "legalwork_ui_execute_action"].map(action => ({ action, resource: "*", effect: "deny" } satisfies PermissionConfig[number]))];
}

// These tools resolve the project from the engine's trusted execution context.
// No shell, delegation, browser, global task search, or unrestricted connectors.
export const PROJECT_TASK_TOOLS = new Set([
  "legalwork_project_list", "legalwork_project_read", "legalwork_project_get_details",
  "legalwork_project_get_instructions", "legalwork_project_create_note",
  "legalwork_calendar_list", "legalwork_calendar_get", "legalwork_review_files",
  "legalwork_jev_corpus_question", "legalwork_review_list", "legalwork_review_get", "legalwork_review_results",
  "legalwork_schedule_clock", "legalwork_schedule_projects", "legalwork_schedule_project_list", "legalwork_schedule_project_read",
  "legalwork_recordings_list", "legalwork_recording_read",
  "todowrite", "question",
  // Native Code Mode routes only the separately permitted child tools.
  "execute",
]);

/** Preserve the user's existing denials and approval rules for allowed tools. */
export function projectTaskPermissions(input: PermissionConfig = []): PermissionConfig {
  const global = Schema.decodeUnknownSync(Config.Info)({ permissions: input }).permissions ?? [];
  const permissions: PermissionConfig = [{ action: "*", resource: "*", effect: "deny" }];
  for (const tool of PROJECT_TASK_TOOLS) {
    const rules = global.filter(rule => permissionPatternMatches(tool, rule.action));
    permissions.push({ action: tool, resource: "*", effect: "allow" }, ...rules.map(rule => ({ ...rule, action: tool })));
  }
  return permissions;
}

/** Do not silently run unrestricted when an external or stale engine lacks our agent. */
export function hasProjectTaskBoundary(agent: Pick<AgentInfo, "id" | "permissions"> | undefined) {
  if (agent?.id !== PROJECT_TASK_AGENT) return false;
  let boundary = -1;
  agent.permissions.forEach((rule, index) => { if (rule.action === "*" && rule.resource === "*" && rule.effect === "deny") boundary = index; });
  // The engine appends access to its tool-output folder. No native file/shell
  // tool is permitted here, so this supporting permission cannot expose data.
  return boundary >= 0 && agent.permissions.slice(boundary + 1).every(rule => rule.effect === "deny" || rule.action === "external_directory" || PROJECT_TASK_TOOLS.has(rule.action));
}
