import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import type { SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store";

type ToolPart = ToolUIPart | DynamicToolUIPart;
export const isSubagentTool = (part: ToolPart) => ["task", "subagent"].includes(getToolName(part));

export function subagentSessionId(part: ToolPart): string | undefined {
  const metadata = part.callProviderMetadata?.opencode;
  if (typeof metadata?.sessionId === "string" && metadata.sessionId.trim()) return metadata.sessionId;
  const input = part.input;
  if (getToolName(part) === "subagent" && input && typeof input === "object" && "sessionID" in input && typeof input.sessionID === "string" && input.sessionID.trim()) return input.sessionID;
  if (input && typeof input === "object" && "task_id" in input && typeof input.task_id === "string" && input.task_id.trim()) return input.task_id;
}

export function subagentDescription(part: ToolPart): string | undefined {
  const input = part.input;
  if (input && typeof input === "object" && "description" in input && typeof input.description === "string") return input.description.trim() || undefined;
}

export function subagentStatus(part: ToolPart, activity: SessionActivityStatus | undefined, waiting: boolean): SessionActivityStatus {
  if (waiting) return "waiting";
  if (activity && activity !== "idle") return activity;
  if (part.state === "output-error") return "error";
  if (activity === "idle" || (part.state === "output-available" && part.callProviderMetadata?.opencode?.background !== true)) return "idle";
  return "thinking";
}
