import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { projectContentsSchema } from "@legalwork/types/workspace";

export function isProjectListTool(part: ToolUIPart | DynamicToolUIPart) {
  return getToolName(part) === "legalwork_project_list" && !("projectCardSuppressed" in part && part.projectCardSuppressed === true);
}

/** Render-only marker; preserve stored tool inputs/outputs and normal inventory cards. */
export function suppressProjectCard(part: ToolUIPart | DynamicToolUIPart) {
  return { ...part, projectCardSuppressed: true };
}

export function parseProjectContents(output: unknown) {
  try {
    const parsed = projectContentsSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
