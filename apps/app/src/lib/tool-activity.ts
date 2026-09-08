import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isEnvVarRequestToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import { parseFilename, truncateText } from "@/components/tools/path"
import { t } from "@/i18n";

type AnyToolPart = ToolUIPart | DynamicToolUIPart

export function isToolPartInFlight(part: AnyToolPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available"
}

export function collectToolParts(messages: UIMessage[]): DynamicToolUIPart[] {
  return messages.flatMap((message) =>
    message.parts.filter(
      (part): part is DynamicToolUIPart => part.type === "dynamic-tool"
    )
  )
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined
  }
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * Human-readable "what is this tool doing" label. Safe against partial
 * streamed input (fields may be missing despite the type contract).
 */
export function getToolActivityLabel(part: AnyToolPart): string {
  if (isBashToolPart(part)) {
    const description = part.input?.description?.trim()
    return description ? truncateText(description, 64) : t("tool_activity.running_command")
  }
  if (isReadToolPart(part)) {
    return t("tool_activity.reading_file", { file: parseFilename(part.input?.filePath) })
  }
  if (isEditToolPart(part)) {
    return t("tool_activity.editing_file", { file: parseFilename(part.input?.filePath) })
  }
  if (isWriteToolPart(part)) {
    return t("tool_activity.writing_file", { file: parseFilename(part.input?.filePath) })
  }
  if (isApplyPatchToolPart(part)) {
    return t("tool.applying_changes")
  }
  if (isGrepToolPart(part) || isGlobToolPart(part)) {
    const pattern = part.input?.pattern?.trim()
    return pattern
      ? t("tool_activity.searching_for", { pattern: truncateText(pattern, 44) })
      : t("tool_activity.searching_files")
  }
  if (isLspToolPart(part)) {
    return t("tool_activity.inspecting_file", { file: parseFilename(part.input?.filePath) })
  }
  if (isSkillToolPart(part)) {
    const name = part.input?.name?.trim()
    return name ? t("tool_activity.loading_skill", { name }) : t("tool_activity.loading_skill_generic")
  }
  if (isTodoWriteToolPart(part)) {
    return t("tool.updating_plan")
  }
  if (isWebFetchToolPart(part)) {
    const host = hostnameOf(part.input?.url)
    return host ? t("tool_activity.reading_host", { host }) : t("tool_activity.fetching_page")
  }
  if (isWebSearchToolPart(part)) {
    const query = part.input?.query?.trim()
    return query
      ? t("tool_activity.searching_web_for", { query: truncateText(query, 44) })
      : t("tool_activity.searching_web")
  }
  if (isQuestionToolPart(part)) {
    return t("tool.asking_question")
  }
  if (isEnvVarRequestToolPart(part)) {
    const key = part.input?.key?.trim()
    return key ? t("tool_activity.requesting_env", { key }) : t("tool_activity.requesting_env_generic")
  }
  if (isTaskToolPart(part)) {
    const description = part.input?.description?.trim()
    return description
      ? t("tool_activity.agent_prefix", { description: truncateText(description, 56) })
      : t("tool_activity.running_agent")
  }
  if (part.type === "dynamic-tool") {
    return t("tool_activity.running_tool", { tool: part.toolName.replace(/[_-]+/g, " ") })
  }
  return t("tool.working")
}

/** Label for the most recent tool still in flight, if any. */
export function getActiveToolLabel(parts: DynamicToolUIPart[]): string | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part && isToolPartInFlight(part)) {
      return getToolActivityLabel(part)
    }
  }
  return null
}

