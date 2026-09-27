import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Blocks, BookOpen, Bot, FilePenLine, FilePlus2, FolderSearch, Globe, KeyRound, ListChecks, MessageCircleQuestionMark, Search, SquareTerminal, Table2, Wrench } from "lucide-react";
import { isBashToolPart, isEditToolPart, isGlobToolPart, isGrepToolPart, isReadToolPart, isWriteToolPart } from "@/lib/build-in-tools";
import { getToolActivityLabel, isToolPartInFlight, isToolPermissionDenied } from "@/lib/tool-activity";
import { t } from "@/i18n";
import { parseFilename, truncateText } from "./path";

type ToolPart = ToolUIPart | DynamicToolUIPart;

function nameOf(part: ToolPart) {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

function categoryOf(part: ToolPart) {
  const name = nameOf(part);
  if (name === "bash" || name === "exec_command") return "command";
  if (name === "task" || name === "task_status") return "agent";
  if (name === "question") return "question";
  if (name === "request_env_var" || name === "env_var_request") return "credentials";
  if (name === "skill") return "skill";
  if (name === "todowrite") return "plan";
  if (name === "webfetch") return "web";
  if (name === "legalwork_review_settings" || name === "legalwork_review_library") return "read";
  if (name === "legalwork_review_list") return "browse";
  if (/(?:^|[_-])(?:search|grep|glob|find)(?:$|[_-])/.test(name)) return "search";
  if (name === "websearch") return "search";
  if (/(?:^|[_-])(?:read|get|results|inspect)(?:$|[_-])/.test(name) || name === "lsp") return "read";
  if (/(?:^|[_-])(?:edit|patch|update|rename)(?:$|[_-])/.test(name)) return "edit";
  if (/(?:^|[_-])(?:write|create|save)(?:$|[_-])/.test(name)) return "write";
  if (name.startsWith("legalwork_review_")) return "review";
  if (/(?:^|[_-])(?:list|files|browse)(?:$|[_-])/.test(name)) return "browse";
  return "tool";
}

const icons = {
  command: SquareTerminal, read: BookOpen, edit: FilePenLine, write: FilePlus2,
  search: Search, web: Globe, skill: Blocks, plan: ListChecks, agent: Bot,
  question: MessageCircleQuestionMark, credentials: KeyRound, review: Table2,
  browse: FolderSearch, tool: Wrench,
};

export function getToolIcon(part: ToolPart) {
  return icons[categoryOf(part)];
}

/** Compact history labels retain the useful target without exposing command bodies. */
export function getToolHistoryLabel(part: ToolPart): string {
  if (isToolPartInFlight(part)) return getToolActivityLabel(part);
  if (isToolPermissionDenied(part)) return t("tool_run.permission_denied");
  if (part.state === "output-error") return t("tool_run.action_failed");
  if (isReadToolPart(part)) return t("tool_run.read_file", { file: parseFilename(part.input?.filePath) });
  if (isEditToolPart(part)) return t("tool_run.edited_file", { file: parseFilename(part.input?.filePath) });
  if (isWriteToolPart(part)) return t("tool_run.wrote_file", { file: parseFilename(part.input?.filePath) });
  if (isGrepToolPart(part) || isGlobToolPart(part)) {
    const pattern = part.input?.pattern?.trim();
    return pattern ? t("tool_run.searched_for", { pattern: truncateText(pattern, 44) }) : t("tool_run.summary.search");
  }
  if (isBashToolPart(part)) {
    const description = part.input?.description?.trim();
    return description ? truncateText(description, 80) : t("tool_run.ran_command");
  }
  if (nameOf(part) === "legalwork_review_results") return t("tool_run.review_results");
  if (nameOf(part) === "legalwork_review_settings") return t("tool_run.review_settings");
  if (nameOf(part) === "legalwork_review_list") return t("tool_run.review_list");
  if (categoryOf(part) !== "tool") return t(`tool_run.summary.${categoryOf(part)}`);
  const name = nameOf(part).replace(/^(?:inapp_|legalwork_)/, "").replace(/[_-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function getToolRunSummary(parts: ToolPart[]): string {
  if (parts.length === 1) return getToolHistoryLabel(parts[0]);
  return [...new Set(parts.map(categoryOf))].map(category => t(`tool_run.summary.${category}`)).join(" · ");
}
