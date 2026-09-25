import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { projectContentsSchema } from "@legalwork/types/workspace";

export function isProjectListTool(part: ToolUIPart | DynamicToolUIPart) {
  return getToolName(part) === "legalwork_project_list";
}

export function parseProjectContents(output: unknown) {
  try {
    const parsed = projectContentsSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
